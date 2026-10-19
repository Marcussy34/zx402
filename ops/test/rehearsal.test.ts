import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { Server, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { FacilitatorCardanoSigner } from '@x402/cardano';
import { IndexerClient, RelayerClient } from '@zx402/api';
import { createZx402, fileStore } from '@zx402/core';
import { addressFromBech32, deriveNoteSecrets, precommitment, vkToCardano } from '@zx402/crypto';
import { devKeysPresent, loadDevArtifacts, loadDevVkey, shutdown } from '@zx402/prover';
import {
  buildDeposit, decodePoolDatum, decodePoolRedeemer, decodeTx, encodeDepositDatum, enterpriseAddress, keyHash, readPool, signTx, timeToSlot, vkToHex,
  type TxView, type Utxo,
} from '@zx402/txlib';
import { FakeChain } from '@zx402/txlib/testing/fake-chain';
import { startDevnet } from '@zx402/txlib/testing/devnet';
import { startSeller } from '@zx402/example-x402-seller/src/seller.js';
import { deploy } from '../src/deploy.js';
import { roleSeed } from '../src/roles.js';
import type { DemoResult } from '../src/demo.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const price = 2_000_000n;
const total = (utxos: Utxo[]) => utxos.reduce((sum, u) => sum + u.value.lovelace, 0n);
after(shutdown);

test('E2E-04: CLI rejects malformed polling and port settings before startup', async t => {
  for (const name of ['ZX402_INTERVAL_MS', 'ZX402_IDLE_RETRY_MS', 'ZX402_INDEXER_PORT', 'ZX402_RELAYER_PORT']) {
    await t.test(name, async () => {
      for (const value of ['-1', '1.5', 'abc', '', 'Infinity', '9007199254740992']) {
        await assert.rejects(promisify(execFile)(process.execPath,
          ['--import', 'tsx', 'ops/src/node.ts'], { cwd: root, env: { PATH: process.env.PATH, [name]: value } }),
        (error: unknown) => {
          const failure = error as { code: number; stderr: string };
          assert.equal(failure.code, 1);
          assert.match(failure.stderr, new RegExp(`${name}.*nonnegative.*integer`));
          return true;
        });
      }
    });
  }
});

test('E2E-04, CRK-01, ASP-01: idle steps wait for changed snapshots or their retry deadline', {
  timeout: 900_000,
  skip: devKeysPresent(root) ? false : 'Development proving keys are absent: circuits/build/dev/manifest.json is required',
}, async t => {
  const { startNode } = await import('../src/node.js');
  const { chain, ctx, keys, run } = await startDevnet();
  chain.advanceSlots(timeToSlot(Date.now(), ctx.deployment.network));
  let now = 1_000;
  const idleRetryMs = 20_000;
  const node = await startNode({ ctx, history: chain, seeds: keys,
    insertArtifacts: await loadDevArtifacts('insert', root), spendVkey: await loadDevVkey('spend', root),
    intervalMs: 0, ports: { indexer: 0, relayer: 0 }, now: () => now });
  t.after(() => node.close());
  // Ordinary outputs can bypass the deposit builder's minimum-amount check.
  const small = chain.addUtxo({ address: ctx.deployment.scripts.deposit.address,
    value: { lovelace: 2_000_000n, assets: {} }, inlineDatum: encodeDepositDatum({ precommitment: 11n,
      refund: Buffer.from(keyHash(keys.users[0]!)).toString('hex') }), datumHash: null, scriptRef: null });
  chain.mineBlock();
  await node.indexer.sync();
  assert.ok((await node.indexer.getDeposits()).some(d => d.txId === small.txId && d.status === 'pending'));
  const methods = ['getTip', 'getUtxosAt', 'getUtxos', 'getProtocolParameters', 'getTransactionsAt',
    'getTransactionCbor', 'evaluate', 'submit'] as const;
  const calls = methods.map(name => t.mock.method(chain, name));
  const crank = t.mock.method(node.crank, 'tick');
  const approval = t.mock.method(node.asp, 'tick');
  const round = async () => {
    calls.forEach(call => call.mock.resetCalls());
    await node.tick();
    return calls.reduce((sum, call) => sum + call.mock.callCount(), 0);
  };
  assert.equal(await round(), 4, 'The first round must try the below-minimum deposit');
  for (const elapsed of [0, 10_000, 19_999]) {
    now = 1_000 + elapsed;
    assert.equal(await round(), 1, 'An unchanged rejected deposit needs only the indexer tip read');
  }
  assert.equal(crank.mock.callCount(), 1);
  now = 1_000 + idleRetryMs;
  assert.equal(await round(), 4, 'The retry deadline must permit one more crank attempt');
  assert.equal(await round(), 1);
  const attempts = crank.mock.callCount();
  chain.mineBlock();
  await node.tick();
  assert.equal(crank.mock.callCount(), attempts, 'A new tip alone must not bypass the retry delay');

  const read = chain.getUtxosAt.bind(chain);
  now += idleRetryMs;
  const crankFailure = t.mock.method(chain, 'getUtxosAt', async (address: string) => {
    if (address === ctx.deployment.scripts.pool.address) throw new Error('crank retry read failed');
    return read(address);
  });
  try { await node.tick(); } finally { crankFailure.mock.restore(); }
  assert.equal(await round(), 4, 'A thrown crank step must run again in the next round');
  assert.equal(await round(), 1);

  const secrets = deriveNoteSecrets(keys.users[0]!, 0);
  const depositTx = await run(await buildDeposit(ctx, { payer: { address: enterpriseAddress(keys.users[0]!, ctx.deployment.network) },
    amount: 10_000_000n, precommitment: precommitment(secrets.nullifier, secrets.secret),
    refundKeyHash: Buffer.from(keyHash(keys.users[0]!)).toString('hex') }), [keys.users[0]!]);
  await node.indexer.sync();
  const expectation = t.mock.method(node.indexer, 'expectChange');
  await node.tick();
  const insertion = await crank.mock.calls.at(-1)!.result;
  assert.ok(insertion?.txId, 'A new valid deposit must bypass the retry delay immediately');
  assert.equal(insertion.deposits, 1);
  assert.equal(expectation.mock.callCount(), 1, 'An Insert submission must request a second look');
  chain.mineBlock();
  await node.indexer.sync();
  expectation.mock.resetCalls();
  await node.tick();
  const deposits = await node.indexer.getDeposits();
  assert.equal(deposits.find(d => d.txId === small.txId)?.status, 'pending');
  assert.equal(deposits.find(d => d.txId === depositTx)?.status, 'absorbed');
  assert.ok((await approval.mock.calls.at(-1)!.result)?.txId);
  assert.equal(expectation.mock.callCount(), 1, 'An association submission must request a second look');
  expectation.mock.resetCalls();

  // A pending pool transaction makes the sequencer read the tip once more per round.
  assert.equal(await round(), 3, 'The association service checks its pending update once');
  for (let i = 0; i < 3; i += 1) assert.equal(await round(), 2);
  assert.equal(expectation.mock.callCount(), 0, 'Idle steps must not extend indexer activity');
  now += idleRetryMs;
  assert.equal(await round(), 6, 'Both idle steps must retry when their deadlines expire');
  assert.equal(await round(), 2);
  now += idleRetryMs;
  const aspFailure = t.mock.method(chain, 'getUtxosAt', async (address: string) => {
    if (address === ctx.deployment.scripts.asp.address) throw new Error('association retry read failed');
    return read(address);
  });
  try { await node.tick(); } finally { aspFailure.mock.restore(); }
  assert.equal(await round(), 3, 'A thrown association step must run again in the next round');
  assert.equal(await round(), 2);
  node.asp.remove(deposits.find(d => d.txId === depositTx)!.label!);
  assert.equal(await round(), 3, 'Changing approved leaves must bypass the association retry delay');
  assert.equal(await round(), 2);
  const approvals = approval.mock.callCount();
  chain.mineBlock();
  await node.tick();
  assert.equal(approval.mock.callCount(), approvals + 1, 'A changed confirmed ASP root must bypass the retry delay');
});

test('E2E-18 the node chains two private payments in one block', {
  timeout: 900_000,
  skip: devKeysPresent(root) ? false : 'Development proving keys are absent: circuits/build/dev/manifest.json is required',
}, async t => {
  const { startNode } = await import('../src/node.js');
  const { chain, ctx, keys } = await startDevnet();
  chain.advanceSlots(timeToSlot(Date.now(), ctx.deployment.network));
  // Keep the chain at wall time, because the relayer quotes real deadlines.
  const mine = async () => chain.mineBlock(Math.max(0, timeToSlot(Date.now(), ctx.deployment.network) - (await chain.getTip()).slot));
  const node = await startNode({ ctx, history: chain, seeds: keys, maxPending: 2, intervalMs: 0, ports: { indexer: 0, relayer: 0 },
    insertArtifacts: await loadDevArtifacts('insert', root), spendVkey: await loadDevVkey('spend', root) });
  t.after(() => node.close());
  const indexer = new IndexerClient(node.urls.indexer);
  const relayer = new RelayerClient(node.urls.relayer);
  const artifacts = { spend: await loadDevArtifacts('spend', root), ragequit: await loadDevArtifacts('ragequit', root) };
  const poll = { intervalMs: 0, timeoutMs: 900_000, onPoll: async () => { await mine(); await node.tick(); } };
  const walletA = keys.users[0]!;
  const walletB = keys.users[1]!;
  const sdkA = createZx402({ seed: walletA, ctx, indexer, relayer, artifacts, poll });
  const sdkB = createZx402({ seed: walletB, ctx, indexer, relayer, artifacts, poll });
  const deposits = await Promise.all([
    sdkA.deposit({ amount: 10_000_000n, walletSeed: walletA }),
    sdkB.deposit({ amount: 10_000_000n, walletSeed: walletB }),
  ]);
  await mine();
  await Promise.all([sdkA.waitForNote(deposits[0]!.prepared.noteId), sdkB.waitForNote(deposits[1]!.prepared.noteId)]);
  const payouts = [{ address: enterpriseAddress(keys.users[2]!, ctx.deployment.network), amount: price }];
  const settling = Promise.all([sdkA.settlePrivately({ payouts }), sdkB.settlePrivately({ payouts })]);
  // Both Settles must reach the mempool before any block is mined.
  const deadline = Date.now() + 120_000;
  while (chain.mempoolTxIds().length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  const chained = chain.mempoolTxIds().length === 2;
  // Release a Settle that waits for a block, so the node can close. The checks below then fail.
  if (!chained) {
    chain.mineBlock();
    await node.tick();
  }
  const [first, second] = await settling;
  chain.mineBlock();
  assert.ok(chained, 'Both settles must reach the mempool before a block is mined');
  const block = chain.blocks().at(-1)!;
  assert.ok(block.txIds.includes(first.txHash), 'The first Settle must land in the block');
  assert.ok(block.txIds.includes(second.txHash), 'The second Settle must land in the same block');
});

// Only the chain adapter differs from the stock seller and facilitator.
function facilitator(chain: FakeChain, mine: () => Promise<unknown>): FacilitatorCardanoSigner {
  return {
    getAddresses: () => [],
    async getUtxo(ref, network) {
      assert.equal(network, 'cardano:preprod');
      const u = chain.allUtxos().find(u => `${u.ref.txId}#${u.ref.index}` === ref);
      if (!u) return { exists: false };
      const payment = addressFromBech32(u.address, 'preprod').payment;
      assert.equal(payment.kind, 'key');
      // The stock facilitator conserves token values using dotted wire units.
      const assets = Object.fromEntries(Object.entries(u.value.assets).map(([unit, amount]) =>
        [`${unit.slice(0, 56)}.${unit.slice(56)}`, amount]));
      return { exists: true, address: u.address, coin: u.value.lovelace, assets,
        paymentKeyHash: Buffer.from(payment.hash).toString('hex') };
    },
    async getCurrentSlot() { return BigInt((await chain.getTip()).slot); },
    async getProtocolParameters() {
      const p = await chain.getProtocolParameters();
      return { coinsPerUtxoByte: p.coinsPerUtxoByte, minFeeCoefficient: p.minFeeA, minFeeConstant: p.minFeeB };
    },
    async evaluateTransaction(transaction) {
      await chain.evaluate(Buffer.from(transaction, 'base64').toString('hex'));
    },
    async submitTransaction(transaction) {
      const txHash = await chain.submit(Buffer.from(transaction, 'base64').toString('hex'));
      await mine();
      await mine();
      return { txHash, status: 'mempool' };
    },
    async getTransactionEvidence(hash) {
      const block = chain.transaction(hash)?.block;
      return block ? { status: 'confirmed', confirmations: chain.blocks().length - block.height }
        : { status: 'unknown', confirmations: 0 };
    },
  };
}

test('TOKEN-25 the whole product in a token pool', {
  timeout: 1_800_000,
  skip: devKeysPresent(root) ? false : 'Development proving keys are absent: circuits/build/dev/manifest.json is required',
}, async t => {
  const { startNode } = await import('../src/node.js');
  const { runDemo } = await import('../src/demo.js');
  const asset = { policy: '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde', name: '0014df10745553444d' };
  const unit = asset.policy + asset.name;
  const wireUnit = `${asset.policy}.${asset.name}`;
  const operator = new Uint8Array(32).fill(72);
  const walletSeed = roleSeed(operator, 'user');
  const agentSeed = roleSeed(operator, 'agent');
  const network = 'preprod';
  const wallet = enterpriseAddress(walletSeed, network);
  const seller = enterpriseAddress(roleSeed(operator, 'seller'), network);
  const seeds = { crank: roleSeed(operator, 'crank'), relayer: roleSeed(operator, 'relayer'), asp: roleSeed(operator, 'asp') };
  const relayer = enterpriseAddress(seeds.relayer, network);
  const chain = new FakeChain({ network, startSlot: timeToSlot(Date.now(), network) });
  // Real elapsed slots keep the relayer's wall-clock deadlines valid while proofs run.
  const mine = async () => chain.mineBlock(Math.max(0, timeToSlot(Date.now(), network) - (await chain.getTip()).slot));
  chain.addUtxo({ address: enterpriseAddress(operator, network), value: { lovelace: 400_000_000n, assets: {} },
    inlineDatum: null, datumHash: null, scriptRef: null });
  const deployment = await deploy({ provider: chain, network, operatorSeed: operator, asset,
    vkeys: { spend: await loadDevVkey('spend', root), insert: await loadDevVkey('insert', root),
      ragequit: await loadDevVkey('ragequit', root) },
    confirm: async () => { await mine(); },
  });
  chain.addUtxo({ address: wallet, value: { lovelace: 5_000_000n, assets: { [unit]: 100_000_000n } },
    inlineDatum: null, datumHash: null, scriptRef: null });
  await mine();
  const ctx = { provider: chain, deployment };
  const tokenBalance = async (address: string) => (await chain.getUtxosAt(address))
    .reduce((sum, u) => sum + (u.value.assets[unit] ?? 0n), 0n);
  const relayerBefore = await tokenBalance(relayer);
  const node = await startNode({ ctx, history: chain, seeds, intervalMs: 0, ports: { indexer: 0, relayer: 0 },
    insertArtifacts: await loadDevArtifacts('insert', root), spendVkey: await loadDevVkey('spend', root) });
  t.after(() => node.close());
  const server = await startSeller({ port: 0, network: 'cardano:preprod', payTo: seller,
    price: { asset: wireUnit, amount: 2_000_000n }, blockfrostProjectId: '', facilitatorSigner: facilitator(chain, mine) });
  t.after(() => server.close());
  const transactions: { view: TxView; inputs: Utxo[] }[] = [];
  const submit = chain.submit.bind(chain);
  t.mock.method(chain, 'submit', async (cbor: string) => {
    const view = decodeTx(cbor);
    const inputs = await chain.getUtxos(view.inputs);
    const id = await submit(cbor);
    transactions.push({ view, inputs });
    return id;
  });
  const logs: string[] = [];
  const result = await runDemo({ ctx, indexerUrl: node.urls.indexer, relayerUrl: node.urls.relayer, sellerUrl: server.url,
    walletSeed, agentSeed, depositAmount: 10_000_000n,
    artifacts: { spend: await loadDevArtifacts('spend', root), ragequit: await loadDevArtifacts('ragequit', root) },
    poll: { intervalMs: 0, timeoutMs: 900_000, onPoll: async () => { await mine(); await node.tick(); } },
    log: line => { logs.push(line); t.diagnostic(line); },
  });
  assert.equal(result.paid.status, 200);
  assert.deepEqual(JSON.parse(result.paid.body), { weather: 'sunny', temperatureC: 28 });
  assert.ok(result.paid.settlementTx);
  assert.equal(result.noteValue, 10_000_000n);
  assert.equal(await tokenBalance(seller), 2_000_000n);
  assert.ok(total(await chain.getUtxosAt(seller)) >= 1_000_000n);
  assert.ok(result.exitTx);
  const exit = transactions.find(tx => tx.view.txId === result.exitTx);
  assert.ok(exit && chain.transaction(result.exitTx)?.block);
  // The confirmed exit input proves the change was inserted before leaving the pool.
  const beforeExit = exit.inputs.find(u => u.address === deployment.scripts.pool.address);
  assert.ok(beforeExit?.inlineDatum);
  const datum = decodePoolDatum(beforeExit.inlineDatum);
  assert.equal(datum.size, 2);
  assert.deepEqual(datum.queue, []);
  assert.equal(beforeExit.value.assets[unit], 7_000_000n);
  assert.equal(beforeExit.value.lovelace, 6_000_000n);
  const pool = await readPool(ctx);
  assert.equal(pool.balance, 0n);
  assert.equal(Object.hasOwn(pool.utxo.value.assets, unit), false);
  assert.equal(pool.utxo.value.lovelace, 6_000_000n);
  assert.equal(await tokenBalance(relayer) - relayerBefore, 1_000_000n);
  assert.ok(logs.some(line => line.includes(`10000000 ${wireUnit}`)));
});

test('E2E-01 through E2E-04: deployed pool rehearsal through real HTTP and stock x402', {
  timeout: 1_800_000,
  skip: devKeysPresent(root) ? false : 'Development proving keys are absent: circuits/build/dev/manifest.json is required',
}, async t => {
  const { startNode } = await import('../src/node.js').catch(error => {
    if (error.code === 'ERR_MODULE_NOT_FOUND') return { startNode: undefined };
    throw error;
  });
  assert.equal(typeof startNode, 'function', 'The node must expose startNode');
  assert.ok(startNode);
  const { runDemo } = await import('../src/demo.js').catch(error => {
    if (error.code === 'ERR_MODULE_NOT_FOUND') return { runDemo: undefined };
    throw error;
  });
  assert.equal(typeof runDemo, 'function', 'The demo must expose runDemo');
  assert.ok(runDemo);
  const directory = await mkdtemp(join(tmpdir(), 'zx402-rehearsal-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const storePath = join(directory, 'demo-store.json');
  const operator = new Uint8Array(32).fill(71);
  const walletSeed = roleSeed(operator, 'user');
  const agentSeed = roleSeed(operator, 'agent');
  const network = 'preprod';
  const wallet = enterpriseAddress(walletSeed, network);
  const seller = enterpriseAddress(roleSeed(operator, 'seller'), network);
  // Match wall time because the live relayer quotes POSIX validity deadlines.
  const chain = new FakeChain({ network, startSlot: timeToSlot(Date.now(), network) });
  // A block takes the slots that really passed. A fixed step per block outruns the clock within a few polls,
  // and then every later settlement expires before it is mined.
  const mine = async () => chain.mineBlock(Math.max(0, timeToSlot(Date.now(), network) - (await chain.getTip()).slot));
  chain.addUtxo({ address: enterpriseAddress(operator, network), value: { lovelace: 400_000_000n, assets: {} },
    inlineDatum: null, datumHash: null, scriptRef: null });
  const transactions: { view: TxView; inputs: Utxo[] }[] = [];
  const submit = chain.submit.bind(chain);
  t.mock.method(chain, 'submit', async (cbor: string) => {
    const view = decodeTx(cbor);
    const inputs = await chain.getUtxos(view.inputs);
    const id = await submit(cbor);
    transactions.push({ view, inputs });
    return id;
  });
  const logs: string[] = [];
  const started = performance.now();
  const deployment = await deploy({ provider: chain, network, operatorSeed: operator,
    vkeys: { spend: await loadDevVkey('spend', root), insert: await loadDevVkey('insert', root),
      ragequit: await loadDevVkey('ragequit', root) },
    config: { depositFeeBps: 50, settleFeeBps: 100 },
    confirm: async () => { await mine(); }, log: line => logs.push(line),
  });
  t.diagnostic(`Deployment seconds: ${((performance.now() - started) / 1000).toFixed(3)}`);
  const ctx = { provider: chain, deployment };
  const reserve = (await readPool(ctx)).balance;
  const nodeOptions = { ctx, history: chain, intervalMs: 0, ports: { indexer: 0, relayer: 0 },
    seeds: { crank: roleSeed(operator, 'crank'), relayer: roleSeed(operator, 'relayer'), asp: roleSeed(operator, 'asp') },
    insertArtifacts: await loadDevArtifacts('insert', root), spendVkey: await loadDevVkey('spend', root),
    aspStorePath: join(directory, 'asp-store.json'), log: (line: string) => logs.push(line),
  };
  const node = await startNode(nodeOptions);
  t.after(() => node.close());
  const server = await startSeller({ port: 0, network: 'cardano:preprod', payTo: seller,
    priceLovelace: price, blockfrostProjectId: '', facilitatorSigner: facilitator(chain, mine) });
  t.after(() => server.close());
  const served: { url: string; body: string }[] = [];
  const ports = new Set(Object.values(node.urls).map(url => Number(new URL(url).port)));
  const emit = Server.prototype.emit;
  t.mock.method(Server.prototype, 'emit', function (this: Server, event: string | symbol, ...args: unknown[]) {
    if (event === 'request') {
      const request = args[0] as IncomingMessage;
      if (ports.has(request.socket.localPort!)) {
        const entry = { url: request.url ?? '', body: '' };
        served.push(entry);
        request.on('data', (chunk: Buffer) => { entry.body += chunk.toString('utf8'); });
      }
    }
    return Reflect.apply(emit, this, [event, ...args]) as boolean;
  });

  const options = { ctx, indexerUrl: node.urls.indexer, relayerUrl: node.urls.relayer, sellerUrl: server.url,
    walletSeed, agentSeed, storePath,
    artifacts: { spend: await loadDevArtifacts('spend', root), ragequit: await loadDevArtifacts('ragequit', root) },
    poll: { intervalMs: 0, timeoutMs: 900_000, onPoll: async () => { await mine(); await node.tick(); } },
    log: (line: string) => { logs.push(line); t.diagnostic(line); },
  };
  let first: DemoResult;
  const runStart = transactions.length;
  const checkStory = async (result: DemoResult, start: number, count: number) => {
    assert.equal(result.paid.status, 200);
    assert.deepEqual(JSON.parse(result.paid.body), { weather: 'sunny', temperatureC: 28 });
    assert.ok(result.paid.settlementTx);
    assert.equal(total(await chain.getUtxosAt(seller)), price * BigInt(count));
    const payment = transactions.find(tx => tx.view.txId === result.paid.settlementTx)!;
    assert.ok(payment);
    assert.equal(payment.view.inputs.length, 1);
    assert.equal(payment.inputs[0]!.address, result.paid.oneTimeAddress);
    assert.equal(payment.view.inputs[0]!.txId, result.paid.leg1Tx);
    assert.equal(payment.view.outputs.length, 1);
    assert.equal(payment.view.outputs[0]!.address, seller);
    assert.equal(payment.view.outputs[0]!.value.lovelace, price);
    assert.notEqual(result.paid.oneTimeAddress, wallet);
    assert.equal(result.noteValue, 9_650_000n);
    for (const tx of transactions.filter(tx => tx.view.outputs.some(out => out.address === seller))) {
      assert.ok(tx.inputs.every(input => input.address !== wallet));
      assert.ok(tx.view.outputs.every(out => out.address !== wallet));
    }
    assert.ok(result.exitTx);
    const exit = transactions.find(tx => tx.view.txId === result.exitTx)!;
    assert.ok(exit && chain.transaction(result.exitTx)?.block);
    const store = (await fileStore(storePath).load())!;
    const exited = store.notes.filter(note => note.status === 'exited');
    assert.equal(exited.length, count);
    assert.equal(store.notes.filter(note => !['spent', 'exited'].includes(note.status)).length, 0);
    const refund = total(exit.view.outputs.filter(out => out.address === wallet).map((out, index) =>
      ({ ...out, ref: { txId: exit.view.txId, index } })));
    assert.equal(refund - total(exit.inputs.filter(input => input.address === wallet)), exited.at(-1)!.value! - exit.view.fee);
    const pool = await readPool(ctx);
    assert.ok(pool.datum.feesAccrued > 0n);
    assert.equal(pool.balance, reserve + pool.datum.feesAccrued);
    assert.deepEqual(pool.datum.queue, []);
    assert.ok(transactions.slice(start).every(tx => logs.some(line => line.includes(tx.view.txId))), 'Every story transaction must be logged');
    assert.ok(result.seconds.toSpendable > 0 && result.seconds.payment > 0);
    assert.ok(result.seconds.total >= result.seconds.toSpendable + result.seconds.payment);
  };
  await t.test('E2E-01, E2E-02: weather payment, private settlement, confirmed exit, and exact solvency', async () => {
    first = await runDemo(options);
    await checkStory(first, runStart, 1);
    // Quotes carry real deadlines. A chain that outruns the clock expires every later settlement.
    assert.ok((await chain.getTip()).time <= Date.now(), 'Chain time must not run ahead of the real clock');
  });
  await t.test('E2E-03: a second demo resumes the store with new note and one-time indexes', async () => {
    const start = transactions.length;
    const second = await runDemo(options);
    await checkStory(second, start, 2);
    assert.notEqual(second.depositTx, first.depositTx);
    assert.notEqual(second.paid.oneTimeAddress, first.paid.oneTimeAddress);
    const store = (await fileStore(storePath).load())!;
    assert.equal(store.nextDepositIndex, 2);
    assert.equal(store.nextOneTimeIndex, 2);
    assert.deepEqual(store.notes.filter(note => note.kind === 'deposit').map(note => note.secretIndex), [0, 1]);
  });
  await t.test('E2E-05: a staged demo keeps its change in the pool and the next demo pays from it', async () => {
    const staged = await runDemo({ ...options, exit: false });
    assert.equal(staged.exitTx, null);
    const kept = (await fileStore(storePath).load())!.notes.find(note => note.kind === 'change' && note.status === 'spendable');
    assert.ok(kept, 'The change note must stay spendable when the demo skips the exit');
    const reused = await runDemo({ ...options, reuseNote: true });
    assert.equal(reused.depositTx, null, 'A reused note needs no deposit');
    assert.equal(reused.noteValue, kept.value);
    assert.equal(reused.paid.status, 200);
    assert.ok(reused.exitTx, 'The default demo still exits its change');
    assert.ok(logs.some(line => line.includes(`Note ${kept.id} in the pool covers the price plus fees`)));
    assert.ok(logs.some(line => line.includes('Not on the chain: any link from the agent')), 'The demo must print the explorer summary');
  });
  await t.test('E2E-01: incoming HTTP URLs and bodies never contain raw note secrets', async () => {
    assert.ok(served.some(request => request.url === '/v1/settle' && request.body.includes('publicInputs')));
    assert.ok(served.some(request => request.url.startsWith('/v1/leaves?')));
    const store = (await fileStore(storePath).load())!;
    const observed = JSON.stringify(served) + logs.join('\n') + await readFile(storePath, 'utf8');
    for (const note of store.notes) {
      for (const value of Object.values(deriveNoteSecrets(agentSeed, note.secretIndex))) {
        assert.ok(!observed.includes(value.toString()), 'Raw note material must remain local');
        assert.ok(!observed.toLowerCase().includes(value.toString(16).padStart(64, '0')), 'Raw note material must remain local');
      }
    }
    for (const seed of [operator, walletSeed, agentSeed]) assert.ok(!observed.includes(Buffer.from(seed).toString('hex')));
  });
  await t.test('E2E-04, REL-02: an accepted settlement requests a second look through the HTTP route', async () => {
    const expectation = t.mock.method(node.indexer, 'expectChange');
    try {
      await new RelayerClient(node.urls.relayer).quote([{ address: seller, amount: price, datumHash: null }]);
      const rejected = await fetch(`${node.urls.relayer}/v1/settle`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      assert.equal(rejected.status, 400);
      assert.equal(expectation.mock.callCount(), 0);
      // Replaying an accepted request exercises the route without spending a note twice.
      const accepted = served.findLast(request => request.url === '/v1/settle' && request.body.includes('publicInputs'))!;
      const response = await fetch(`${node.urls.relayer}/v1/settle`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: accepted.body,
      });
      assert.equal(response.status, 202);
      assert.equal((await response.json() as { status: string }).status, 'confirmed');
      assert.equal(expectation.mock.callCount(), 1);
    } finally { expectation.mock.restore(); }
  });
  await t.test('E2E-04, CRK-01: idle rounds make one provider call and pending deposits wake the crank', async () => {
    const reads = ['getTip', 'getUtxosAt', 'getUtxos', 'getProtocolParameters', 'getTransactionsAt',
      'getTransactionCbor', 'evaluate', 'submit'] as const;
    const calls = reads.map(name => t.mock.method(chain, name));
    try {
      for (let round = 0; round < 3; round += 1) {
        calls.forEach(call => call.mock.resetCalls());
        await node.tick();
        const count = calls.reduce((sum, call) => sum + call.mock.callCount(), 0);
        t.diagnostic(`Idle round ${round + 1}: ${count} provider calls`);
        assert.equal(count, 1);
      }
    } finally { calls.forEach(call => call.mock.restore()); }
    const secrets = deriveNoteSecrets(agentSeed, 2);
    const deposit = await buildDeposit(ctx, { payer: { address: wallet }, amount: 10_000_000n,
      precommitment: precommitment(secrets.nullifier, secrets.secret),
      refundKeyHash: Buffer.from(keyHash(walletSeed)).toString('hex') });
    const depositTx = await chain.submit(signTx(deposit.cbor, [walletSeed]));
    await mine();
    const before = transactions.length;
    await node.tick();
    assert.equal(transactions.length, before + 1, 'A new pending deposit must trigger Insert in the next round');
    const insertion = transactions.at(-1)!;
    assert.ok(insertion.inputs.some(input => input.ref.txId === depositTx));
    await mine();
    await node.tick();
    await mine();
    await node.tick();
    assert.equal((await node.indexer.getDeposits()).find(d => d.txId === depositTx)?.status, 'absorbed');
  });
  await t.test('E2E-04: failed reads preserve the snapshot and pending crank work', async () => {
    const secrets = deriveNoteSecrets(agentSeed, 3);
    const deposit = await buildDeposit(ctx, { payer: { address: wallet }, amount: 10_000_000n,
      precommitment: precommitment(secrets.nullifier, secrets.secret),
      refundKeyHash: Buffer.from(keyHash(walletSeed)).toString('hex') });
    const depositTx = await chain.submit(signTx(deposit.cbor, [walletSeed]));
    await mine();
    await node.indexer.sync();
    const sync = t.mock.method(node.indexer, 'sync');
    const getUtxosAt = chain.getUtxosAt.bind(chain);
    let failOnce = true;
    const failing = t.mock.method(chain, 'getUtxosAt', async (address: string) => {
      if (failOnce && address === deployment.scripts.pool.address) {
        failOnce = false;
        throw new Error('transient crank provider failure');
      }
      return getUtxosAt(address);
    });
    try {
      await node.tick();
      assert.equal(failOnce, false);
      assert.equal(sync.mock.callCount(), 1, 'A failed crank step needs no extra sync');
      assert.ok(logs.some(line => /crank.*transient crank provider failure/i.test(line)));
      assert.equal((await new IndexerClient(node.urls.indexer).getPool()).poolId, deployment.poolId);
    } finally { failing.mock.restore(); sync.mock.restore(); }
    const stale = t.mock.method(chain, 'getTip', async () => { throw new Error('transient indexer provider failure'); }, { times: 1 });
    try {
      const before = transactions.length;
      await node.tick();
      assert.equal(transactions.length, before + 1, 'The crank must use the last snapshot after a failed sync');
      assert.ok(transactions.at(-1)!.inputs.some(input => input.ref.txId === depositTx));
      assert.ok(logs.some(line => /indexer.*transient indexer provider failure/i.test(line)));
    } finally { stale.mock.restore(); }
    await mine();
    await node.tick();
    await mine();
    await node.tick();
  });
  await t.test('E2E-04: close waits for an in-flight relayer request', async () => {
    const quote = node.relayer.quote.bind(node.relayer);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let arrived!: () => void;
    const ready = new Promise<void>(resolve => { arrived = resolve; });
    const pending = t.mock.method(node.relayer, 'quote', async (...args: Parameters<typeof quote>) => {
      arrived();
      await gate;
      return quote(...args);
    });
    const request = new RelayerClient(node.urls.relayer).quote([{ address: seller, amount: price, datumHash: null }]);
    // Attach a handler immediately so a broken shutdown is reported as a test failure.
    const outcome = request.then(value => ({ value }), error => ({ error }));
    await ready;
    let closed = false;
    const closing = node.close().then(() => { closed = true; });
    try {
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(closed, false, 'Shutdown must drain an accepted relayer request');
    } finally { release(); }
    await closing;
    pending.mock.restore();
    const result = await outcome;
    assert.ok('value' in result);
    assert.equal(result.value.poolId, deployment.poolId);
  });
  await t.test('E2E-04: concurrent ticks share one round and close stops caller-driven work', async () => {
    const live = await startNode(nodeOptions);
    t.after(() => live.close());
    const sync = live.indexer.sync.bind(live.indexer);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const pending = t.mock.method(live.indexer, 'sync', async () => { calls++; await gate; return sync(); });
    const one = live.tick();
    const two = live.tick();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
    release();
    await Promise.all([one, two]);
    assert.equal(calls, 1);
    pending.mock.restore();
    await live.close();
    await live.close();
    const tip = t.mock.method(chain, 'getTip');
    await live.tick();
    assert.equal(tip.mock.callCount(), 0);
    await assert.rejects(fetch(`${live.urls.indexer}/v1/pool`));
    await assert.rejects(fetch(`${live.urls.relayer}/v1/pool`));
  });
  await t.test('E2E-04: timer rounds stop after close and wait for a running sync', async () => {
    const timed = await startNode({ ...nodeOptions, intervalMs: 10 });
    t.after(() => timed.close());
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let arrived!: () => void;
    const ready = new Promise<void>(resolve => { arrived = resolve; });
    const sync = timed.indexer.sync.bind(timed.indexer);
    let calls = 0;
    t.mock.method(timed.indexer, 'sync', async () => { calls++; arrived(); await gate; return sync(); });
    await ready;
    let closed = false;
    const closing = timed.close().then(() => { closed = true; });
    try {
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal(calls, 1);
      assert.equal(closed, false);
    } finally { release(); }
    await closing;
    const afterClose = calls;
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(calls, afterClose);
  });
  await t.test('E2E-04: artifact selection matches deployment keys and rejects altered files', async () => {
    const { deploymentArtifacts } = await import('../src/node.js');
    const development = await deploymentArtifacts(deployment, root);
    assert.deepEqual(development.spendVkey, await loadDevVkey('spend', root));
    assert.deepEqual((await development.load('insert')).vkey, await loadDevVkey('insert', root));
    const fixtureRoot = join(directory, 'artifact-fixture');
    const publicDir = join(fixtureRoot, 'deployments/preprod/keys');
    const devDir = join(fixtureRoot, 'artifacts/dev');
    await Promise.all([publicDir, devDir].map(path => mkdir(path, { recursive: true })));
    await writeFile(join(devDir, 'manifest.json'), await readFile(join(root, 'artifacts/dev/manifest.json')));
    const record = structuredClone(deployment);
    const manifest: Record<string, { vkey_sha256: string }> = {};
    const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
    for (const name of ['spend', 'insert', 'ragequit'] as const) {
      const original = await readFile(join(root, `artifacts/dev/${name}_vkey.json`));
      await writeFile(join(devDir, `${name}_vkey.json`), original);
      const key = JSON.parse(original.toString('utf8'));
      if (name === 'spend') key.vk_alpha_1 = key.IC[0];
      record.vkeys[name] = vkToHex(vkToCardano(key));
      const bytes = Buffer.from(JSON.stringify(key));
      await writeFile(join(publicDir, `${name}_vkey.json`), bytes);
      manifest[name] = { vkey_sha256: sha(bytes) };
    }
    await writeFile(join(publicDir, 'manifest.json'), JSON.stringify({ circuits: manifest }));
    const production = await deploymentArtifacts(record, fixtureRoot);
    assert.deepEqual(vkToHex(vkToCardano(production.spendVkey)), record.vkeys.spend);
    const mismatched = structuredClone(record);
    mismatched.vkeys.ragequit = record.vkeys.insert;
    await assert.rejects(deploymentArtifacts(mismatched, fixtureRoot), /do not match the deployment/);
    await writeFile(join(publicDir, 'spend_vkey.json'), '{}');
    await assert.rejects(deploymentArtifacts(record, fixtureRoot), /Verification key hash mismatch/);
  });
  for (const [index, { view, inputs }] of transactions.entries()) {
    const poolInput = inputs.find(input => input.address === deployment.scripts.pool.address);
    const action = poolInput ? decodePoolRedeemer(view.redeemers.find(r => r.tag === 'spend'
      && view.inputs[r.index]?.txId === poolInput.ref.txId && view.inputs[r.index]?.index === poolInput.ref.index)!.dataCbor).kind
      : view.outputs.some(out => out.address === deployment.scripts.deposit.address) ? 'Deposit'
      : view.outputs.some(out => out.address === seller) ? 'Payment'
      : inputs.some(input => input.address === deployment.scripts.asp.address) ? 'ASP'
      : index === 0 ? 'Funding' : view.txId === deployment.initTx ? 'Init' : 'References';
    t.diagnostic(`TX ${JSON.stringify({ index: index + 1, action, id: view.txId, size: view.size,
      fee: String(view.fee), mem: String(view.redeemers.reduce((sum, r) => sum + r.mem, 0n)),
      steps: String(view.redeemers.reduce((sum, r) => sum + r.steps, 0n)) })}`);
  }
});
