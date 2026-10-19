import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ApiError, RelayerClient, relayerRoutes, serveJson,
  type ErrorCode, type IndexerApi, type PayoutRequest, type SettleRequest, type SettleStatus,
} from '@zx402/api';
import {
  MerkleTree, NETWORKS, R, addressFromBech32, contextFor, deriveNoteSecrets, insertWitness,
  precommitment, spendWitness, type Note,
} from '@zx402/crypto';
import { devKeysPresent, loadDevArtifacts, loadDevVkey, prove, shutdown } from '@zx402/prover';
import {
  Sequencer, SubmitRejected, assetAmount, assetWireUnit, buildAspUpdate, buildDeposit, buildInsert, buildSettle, complete, decodePoolRedeemer, decodeTx,
  encodeConfigDatum, encodeVoid, enterpriseAddress, keyHash, newTxBuilder, nullifierInsertion, planInsert,
  readAsp, readConfig, readDeposits, readPool, signTx, timeToSlot, utxoToMesh,
  type ChainContext,
} from '@zx402/txlib';
import { startDevnet } from '@zx402/txlib/testing/devnet';
import { Relayer } from '../src/index.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const tokenAsset = { policy: '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde', name: '0014df10745553444d' };
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const rejects = (promise: Promise<unknown>, code: ErrorCode) =>
  assert.rejects(promise, error => error instanceof ApiError && error.code === code);
after(shutdown);

async function waitFor(check: () => boolean | Promise<boolean>, message: string): Promise<void> {
  const deadline = performance.now() + 5000;
  while (!await check()) {
    assert.ok(performance.now() < deadline, message);
    await delay(5);
  }
}

// The indexer service was absent when this lane began. Keep the test on its public interface.
function fakeIndexer(ctx: ChainContext, leaves: bigint[], spent: bigint[]): IndexerApi {
  return {
    async getPool() {
      const [pool, config, asp, tip] = await Promise.all([readPool(ctx), readConfig(ctx), readAsp(ctx), ctx.provider.getTip()]);
      const { depositsPaused, minDeposit, maxDeposit, poolCap, depositFeeBps, settleFeeBps, crankFee } = config.datum;
      return { poolId: ctx.deployment.poolId, asset: assetWireUnit(ctx.deployment.asset), ...pool.datum, aspRoot: asp.datum.root,
        config: { depositsPaused, minDeposit, maxDeposit, poolCap, depositFeeBps, settleFeeBps, crankFee },
        tip: { slot: tip.slot, hash: tip.blockHash } };
    },
    async getLeaves(from, limit) {
      return { from, leaves: leaves.slice(from, from + limit), size: leaves.length, root: MerkleTree.fromLeaves(leaves).root };
    },
    async getAspLeaves(from) { return { from, leaves: [], root: (await readAsp(ctx)).datum.root }; },
    async getNullifiers(from, limit) { return { from, nullifiers: spent.slice(from, from + Math.min(limit, 1)) }; },
    async getDeposits() {
      return (await readDeposits(ctx)).map(({ utxo, datum }) => ({ ...utxo.ref, gross: assetAmount(utxo.value, ctx.deployment.asset),
        precommitment: datum.precommitment, refundKeyHash: datum.refund, status: 'pending' as const,
        value: null, label: null, leafIndex: null }));
    },
  };
}

test('TOKEN-14 a quote in a token pool', { timeout: 120_000 }, async () => {
  const { chain, ctx, keys } = await startDevnet({ asset: tokenAsset });
  const relayer = new Relayer({ ctx, sequencer: new Sequencer({ ctx, status: chain }), indexer: fakeIndexer(ctx, [], []), seed: keys.relayer,
    vkey: await loadDevVkey('spend', repoRoot) });
  const payout = { address: enterpriseAddress(keys.users[0]!, ctx.deployment.network), amount: 100_000n, datumHash: null };
  const quote = await relayer.quote([payout]);
  assert.equal(quote.payoutLovelace, 2_000_000n);
  assert.equal(quote.relayerFee, 1_000_000n);
  assert.equal(quote.withdrawn, 1_100_000n);
  assert.equal(quote.protocolFee, 0n);
  assert.equal((await relayer.quote([{ ...payout, amount: 1n }])).withdrawn, 1_000_001n);
  await rejects(relayer.quote([{ ...payout, amount: 0n }]), 'bad_request');
});

test('TOKEN-15 the ADA pool quote is unchanged', { timeout: 120_000 }, async () => {
  const { chain, ctx, keys } = await startDevnet();
  const relayer = new Relayer({ ctx, sequencer: new Sequencer({ ctx, status: chain }), indexer: fakeIndexer(ctx, [], []), seed: keys.relayer,
    vkey: await loadDevVkey('spend', repoRoot) });
  const payout = { address: enterpriseAddress(keys.users[0]!, ctx.deployment.network), amount: 1_000_000n, datumHash: null };
  const quote = await relayer.quote([payout]);
  assert.equal(quote.payoutLovelace, 0n);
  assert.equal(quote.relayerFee, 1_000_000n);
  assert.equal(quote.withdrawn, 2_000_000n);
  assert.equal(quote.protocolFee, 0n);
  await rejects(relayer.quote([{ ...payout, amount: 999_999n }]), 'bad_request');
});

test('TOKEN-16 relayer settings', { timeout: 240_000 }, async t => {
  const vkey = await loadDevVkey('spend', repoRoot);
  for (const [asset, invalid, valid] of [
    [tokenAsset, [500_000n, -1n, 0n, 999_999n], [1_000_000n, 3_000_000n]],
    [{ policy: '', name: '' }, [1n, -1n], [0n]],
  ] as const) {
    const { chain, ctx, keys } = await startDevnet({ asset });
    const options = { ctx, indexer: fakeIndexer(ctx, [], []), seed: keys.relayer, vkey };
    for (const payoutLovelace of invalid) {
      await t.test(`TOKEN-16 ${asset.name ? 'token' : 'ADA'} pool refuses payoutLovelace ${payoutLovelace}`, () => {
        assert.throws(() => new Relayer({ ...options, sequencer: new Sequencer({ ctx, status: chain }), payoutLovelace }), RangeError);
      });
    }
    for (const payoutLovelace of valid) {
      await t.test(`TOKEN-16 ${asset.name ? 'token' : 'ADA'} pool quotes payoutLovelace ${payoutLovelace}`, async () => {
        const relayer = new Relayer({ ...options, sequencer: new Sequencer({ ctx, status: chain }), payoutLovelace });
        const quote = await relayer.quote([{ address: enterpriseAddress(keys.users[0]!, ctx.deployment.network),
          amount: 1_000_000n, datumHash: null }]);
        assert.equal(quote.payoutLovelace, payoutLovelace);
      });
    }
  }
});

test('TOKEN-17 the indexer must serve the same asset', { timeout: 120_000 }, async () => {
  const { chain, ctx, keys } = await startDevnet({ asset: tokenAsset });
  const indexer = fakeIndexer(ctx, [], []);
  const original = indexer.getPool;
  indexer.getPool = async () => ({ ...await original(), asset: 'lovelace' });
  const relayer = new Relayer({ ctx, sequencer: new Sequencer({ ctx, status: chain }), indexer, seed: keys.relayer, vkey: await loadDevVkey('spend', repoRoot) });
  // This amount also clears the ADA floor, so only the asset mismatch can reject it.
  await assert.rejects(relayer.quote([{ address: enterpriseAddress(keys.users[0]!, ctx.deployment.network),
    amount: 1_000_000n, datumHash: null }]), error => error instanceof ApiError
    && error.code === 'internal' && error.message === 'Indexer serves another pool asset');
});

test('REL-01: quotes include both fees and validate payouts without proving keys', { timeout: 120_000 }, async () => {
  const { chain, ctx, keys } = await startDevnet();
  const indexer = fakeIndexer(ctx, [], []);
  const original = indexer.getPool;
  indexer.getPool = async () => {
    const view = await original();
    return { ...view, config: { ...view.config, settleFeeBps: 100 } };
  };
  const relayer = new Relayer({ ctx, sequencer: new Sequencer({ ctx, status: chain }), indexer, seed: keys.relayer, vkey: await loadDevVkey('spend', repoRoot), now: () => 123_000 });
  const address = enterpriseAddress(keys.users[0]!, ctx.deployment.network);
  const payouts = [{ address, amount: 2_000_000n, datumHash: null }, { address, amount: 3_000_000n, datumHash: null }];
  const quote = await relayer.quote(payouts);
  assert.equal(quote.protocolFee, 50_000n);
  assert.equal(quote.relayerFee, 1_000_000n);
  assert.equal(quote.withdrawn, 6_050_000n);
  assert.equal(quote.validUntil, 423_000);
  assert.equal(quote.poolId, ctx.deployment.poolId);
  assert.equal(quote.relayerKeyHash, hex(keyHash(keys.relayer)));
  for (const bad of [[], Array(5).fill(payouts[0]), [{ ...payouts[0]!, address: 'bad' }],
    [{ ...payouts[0]!, address: enterpriseAddress(keys.users[0]!, 'mainnet') }],
    [{ ...payouts[0]!, amount: 999_999n }]]) {
    await rejects(relayer.quote(bad), 'bad_request');
  }
  await rejects(relayer.getSettle('unknown'), 'not_found');
});

test('REL-01: quote limits include concurrent requests and expired quotes release capacity', { timeout: 120_000 }, async () => {
  const { chain, ctx, keys } = await startDevnet();
  const indexer = fakeIndexer(ctx, [], []);
  let now = 123_000;
  const relayer = new Relayer({ ctx, sequencer: new Sequencer({ ctx, status: chain }), indexer, seed: keys.relayer, vkey: await loadDevVkey('spend', repoRoot),
    maxQuotes: 2, quoteTtlMs: 1000, now: () => now });
  const payouts = [{ address: enterpriseAddress(keys.users[0]!, ctx.deployment.network), amount: 2_000_000n, datumHash: null }];
  const results = await Promise.allSettled(Array.from({ length: 3 }, () => relayer.quote(payouts)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 2);
  const busy = results.find(result => result.status === 'rejected');
  assert.ok(busy?.status === 'rejected' && busy.reason instanceof ApiError);
  assert.equal(busy.reason.status, 503);
  assert.equal(busy.reason.code, 'internal');
  assert.equal(busy.reason.message, 'Relayer is busy');
  now += 999;
  await assert.rejects(relayer.quote(payouts), { status: 503 });
  now++;
  assert.ok(await relayer.quote(payouts));
  assert.ok(await relayer.quote(payouts));
  await assert.rejects(relayer.quote(payouts), { status: 503 });
  const old = results.find(result => result.status === 'fulfilled');
  assert.ok(old?.status === 'fulfilled');
  await rejects(relayer.settle({ quoteId: old.value.quoteId } as SettleRequest), 'not_found');
});

test('REL-02, REL-03, REL-04, REL-05, HTTP: real proof relayer story', {
  timeout: 1_200_000,
  skip: devKeysPresent(repoRoot) ? false : 'Development proving keys are absent: circuits/build/dev/manifest.json is required',
}, async t => {
  const { chain, ctx, keys, run } = await startDevnet({ users: 4 });
  const network = ctx.deployment.network;
  chain.advanceSlots(NETWORKS[network].zeroSlot);
  const payer = (seed: Uint8Array) => ({ address: enterpriseAddress(seed, network) });
  const config = await readConfig(ctx);
  const configScript = ctx.deployment.scripts.config;
  const configRef = ctx.deployment.refScripts.config;
  const builder = await newTxBuilder({ provider: chain, network });
  builder.spendingPlutusScriptV3()
    .txIn(config.utxo.ref.txId, config.utxo.ref.index, utxoToMesh(config.utxo).output.amount, config.utxo.address, 0)
    .spendingTxInReference(configRef.txId, configRef.index, String(configScript.size), configScript.hash)
    .txInInlineDatumPresent().txInRedeemerValue(encodeVoid(), 'CBOR')
    // The larger fee integer increases datum bytes, so fund the continuing output's minimum ADA.
    .txOut(config.utxo.address, utxoToMesh({ ...config.utxo,
      value: { ...config.utxo.value, lovelace: config.utxo.value.lovelace + 1_000_000n } }).output.amount)
    .txOutInlineDatumValue(encodeConfigDatum({ ...config.datum, settleFeeBps: 100 }), 'CBOR')
    .requiredSignerHash(hex(keyHash(keys.admin[0]!)));
  await run(await complete({ provider: chain, network }, builder, { payer: payer(keys.admin[0]!),
    extraUtxos: [config.utxo, ...await chain.getUtxos([configRef])] }), [keys.admin[0]!]);

  const artifacts = { insert: await loadDevArtifacts('insert', repoRoot), spend: await loadDevArtifacts('spend', repoRoot) };
  const secrets = keys.users.map(key => deriveNoteSecrets(key, 0));
  for (const [i, key] of keys.users.entries()) {
    await run(await buildDeposit(ctx, { payer: payer(key), amount: 20_000_000n,
      precommitment: precommitment(secrets[i]!.nullifier, secrets[i]!.secret), refundKeyHash: hex(keyHash(key)) }), [key]);
  }
  const pool = await readPool(ctx);
  const plan = planInsert({ poolId: ctx.deployment.poolId, pool, config: (await readConfig(ctx)).datum, deposits: await readDeposits(ctx) });
  assert.ok(plan);
  const insertion = insertWitness({ tree: MerkleTree.empty(), slots: plan.slots });
  await run(await buildInsert(ctx, { payer: payer(keys.crank), pool, plan,
    proof: (await prove(artifacts.insert, insertion.input)).cardano, newRoot: insertion.newRoot }), [keys.crank]);
  let tree = insertion.tree;
  const leaves = [...insertion.leaves];
  const spent: bigint[] = [];
  const notes: Note[] = plan.deposits.map((deposit, index) => {
    const user = keys.users.findIndex(key => hex(keyHash(key)) === deposit.datum.refund);
    return { ...secrets[user]!, value: plan.credited[index]!.value, label: plan.credited[index]!.label };
  });
  const aspTree = MerkleTree.fromLeaves(notes.map(note => note.label));
  await run(await buildAspUpdate(ctx, { payer: payer(keys.asp), root: aspTree.root, signers: [hex(keyHash(keys.asp))] }), [keys.asp]);
  const indexer = fakeIndexer(ctx, leaves, spent);
  let now = (await chain.getTip()).time;
  const logs: { message: string; error: unknown }[] = [];
  const relayer = new Relayer({ ctx, sequencer: new Sequencer({ ctx, status: chain }), indexer, seed: keys.relayer, vkey: artifacts.spend.vkey,
    quoteTtlMs: 600_000, retryDelayMs: 5, now: () => now, log: (message, error) => logs.push({ message, error }) });
  const server = await serveJson(relayerRoutes(relayer), 0);
  t.after(() => server.close());
  const client = new RelayerClient(server.url);
  let submissions = 0;
  let pending: bigint[] = [];
  const submit = chain.submit.bind(chain);
  chain.submit = async cbor => {
    submissions++;
    const txId = await submit(cbor);
    for (const redeemer of decodeTx(cbor).redeemers) {
      const value = decodePoolRedeemer(redeemer.dataCbor);
      if (value.kind === 'Settle') pending.push(value.nullifierHash);
    }
    return txId;
  };
  const mine = () => { chain.mineBlock(); spent.push(...pending); pending = []; };
  const requests: SettleRequest[] = [];
  const sellers = Array.from({ length: 4 }, (_, i) => new Uint8Array(32).fill(101 + i));
  for (let i = 0; i < notes.length; i++) {
    const payouts: PayoutRequest[] = [{ address: payer(sellers[i]!).address, amount: 2_000_000n, datumHash: null }];
    const quote = await (i === 0 ? client : relayer).quote(payouts);
    assert.equal(quote.protocolFee, 20_000n);
    assert.equal(quote.withdrawn, 3_020_000n);
    const intent = { poolId: quote.poolId, payouts, relayer: quote.relayerKeyHash, validUntil: quote.validUntil };
    const context = contextFor({ poolId: Buffer.from(intent.poolId, 'hex'), relayer: Buffer.from(intent.relayer, 'hex'),
      validUntil: BigInt(intent.validUntil), payouts: payouts.map(p => ({ ...p, address: addressFromBech32(p.address, network), datumHash: null })) });
    const fresh = deriveNoteSecrets(sellers[i]!, 1);
    const witness = spendWitness({ note: notes[i]!, stateTree: tree, stateIndex: i, aspTree, aspIndex: i,
      withdrawn: quote.withdrawn, newNullifier: fresh.nullifier, newSecret: fresh.secret, context });
    const proof = await prove(artifacts.spend, witness.input);
    requests.push({ quoteId: quote.quoteId, intent, proof: { a: hex(proof.cardano.a), b: hex(proof.cardano.b), c: hex(proof.cardano.c) },
      publicInputs: { newCommitment: witness.public.newCommitment, nullifierHash: witness.public.nullifierHash,
        withdrawn: quote.withdrawn, stateRoot: tree.root, aspRoot: aspTree.root, context } });
  }
  const first = requests[0]!;
  const freshRequest = async (request = first, owner = relayer) => {
    const quote = await owner.quote(request.intent.payouts);
    assert.equal(quote.validUntil, request.intent.validUntil, 'the existing proof binds the same deadline');
    return { ...request, quoteId: quote.quoteId };
  };
  const mineConfirmed = () => {
    const block = chain.mineBlock();
    for (const txId of block.txIds) {
      for (const redeemer of decodeTx(chain.transaction(txId)!.cbor).redeemers) {
        const value = decodePoolRedeemer(redeemer.dataCbor);
        if (value.kind === 'Settle') spent.push(value.nullifierHash);
      }
    }
    pending = [];
    return block;
  };
  const chained = async (body: (owner: Relayer, sequencer: Sequencer,
    settle: (request: SettleRequest) => Promise<SettleStatus>) => Promise<void>, quoteTtlMs = 600_000) => {
    const height = chain.blocks().length;
    const spentCount = spent.length;
    const saved = now;
    const sequencer = new Sequencer({ ctx, status: chain, maxPending: 2 });
    const owner = new Relayer({ ctx, sequencer, indexer, seed: keys.relayer, vkey: artifacts.spend.vkey,
      quoteTtlMs, retryDelayMs: 5, now: () => now });
    const work: Promise<SettleStatus>[] = [];
    const settle = (request: SettleRequest) => {
      const result = owner.settle(request);
      work.push(result);
      void result.catch(() => undefined);
      return result;
    };
    try { await body(owner, sequencer, settle); }
    finally {
      // Release an implementation still waiting for a confirmed pool during the red run.
      now = first.intent.validUntil + 1;
      await Promise.allSettled(work);
      chain.rollback(chain.blocks().length - height);
      spent.length = spentCount;
      pending = [];
      now = saved;
    }
  };
  const twoPending = async (owner: Relayer, settle: (request: SettleRequest) => Promise<SettleStatus>) => {
    const a = settle(await freshRequest(first, owner));
    const b = settle(await freshRequest(requests[1]!, owner));
    await waitFor(() => chain.mempoolTxIds().length === 2, 'both settles must submit before a block is mined');
    const results = await Promise.all([a, b]);
    for (const result of results) assert.equal(result.status, 'submitted');
    return results;
  };
  const directSettle = async (request: SettleRequest) => {
    const inputs = request.publicInputs;
    const trie = await nullifierInsertion(spent, inputs.nullifierHash);
    const tx = await buildSettle(ctx, { payer: payer(keys.crank), pool: await readPool(ctx),
      proof: { a: Buffer.from(request.proof.a, 'hex'), b: Buffer.from(request.proof.b, 'hex'), c: Buffer.from(request.proof.c, 'hex') },
      nullifierHash: inputs.nullifierHash, newCommitment: inputs.newCommitment, withdrawn: inputs.withdrawn,
      stateRoot: inputs.stateRoot, nullifierProof: trie.proofCbor, newNullifierRoot: trie.newRoot,
      intent: { poolId: Buffer.from(request.intent.poolId, 'hex'),
        relayer: request.intent.relayer === null ? null : Buffer.from(request.intent.relayer, 'hex'),
        validUntil: BigInt(request.intent.validUntil), payouts: request.intent.payouts.map(payout => ({
          ...payout, address: addressFromBech32(payout.address, network), datumHash: null,
        })) } });
    return { ...tx, signed: signTx(tx.cbor, [keys.crank, keys.relayer]) };
  };
  const rotateFeeInput = async (cbor: string) => {
    const address = payer(keys.relayer).address;
    const input = (await chain.getUtxos(decodeTx(cbor).inputs)).find(utxo => utxo.address === address);
    assert.ok(input);
    // A real fee-wallet spend makes the rebuilt body distinct even on an unchanged pool head.
    // Split the input in half, so the output and the change both clear the minimum ADA.
    const builder = (await newTxBuilder({ provider: chain, network }))
      .txOut(address, [{ unit: 'lovelace', quantity: String(input.value.lovelace / 2n) }]);
    const tx = await complete({ provider: chain, network }, builder, { payer: { address, utxos: [input] } });
    await submit(signTx(tx.cbor, [keys.relayer]));
    mineConfirmed();
  };
  // The spend proof a Settle carries, in the request's hex form.
  const settleProof = (txHash: string) => {
    const redeemer = decodeTx(chain.transaction(txHash)!.cbor).redeemers.map(value => decodePoolRedeemer(value.dataCbor))
      .find(value => value.kind === 'Settle');
    assert.ok(redeemer?.kind === 'Settle');
    return { a: hex(redeemer.proof.a), b: hex(redeemer.proof.b), c: hex(redeemer.proof.c) };
  };
  await t.test('REL-06 two settles chain inside one block window', async () => {
    await chained(async (owner, sequencer, settle) => {
      const height = chain.blocks().length;
      const results = await twoPending(owner, settle);
      assert.equal(chain.blocks().length, height);
      assert.deepEqual(mineConfirmed().txIds, results.map(result => result.txHash));
      await sequencer.reconcile();
      for (const result of results) {
        const status = await owner.getSettle(result.id);
        assert.equal(status.status, 'confirmed');
        assert.equal(status.txHash, result.txHash);
      }
    });
  });
  await t.test('REL-07 a dropped parent: both settles are rebuilt and land', async () => {
    await chained(async (owner, sequencer, settle) => {
      const results = await twoPending(owner, settle);
      const original = chain.transaction(results[0]!.txHash)!.cbor;
      assert.deepEqual(chain.dropTransaction(results[0]!.txHash), results.map(result => result.txHash));
      await rotateFeeInput(original);
      await sequencer.reconcile();
      await sequencer.reconcile();
      await waitFor(() => chain.mempoolTxIds().length === 2, 'both dropped settles must be rebuilt');
      const rebuilt = chain.mempoolTxIds();
      assert.deepEqual(mineConfirmed().txIds, rebuilt);
      await sequencer.reconcile();
      for (const result of results) {
        const status = await owner.getSettle(result.id);
        assert.equal(status.status, 'confirmed');
        assert.notEqual(status.txHash, result.txHash);
        assert.equal(await chain.transactionStatus(status.txHash), 'confirmed');
      }
    });
  });
  await t.test('REL-07 a dropped parent near the deadline ends failed', async () => {
    await chained(async (owner, sequencer, settle) => {
      // Reuse proofs bound to this deadline, with only one second left in each new quote.
      now = first.intent.validUntil - 1000;
      chain.mineBlock(timeToSlot(now, network) - (await chain.getTip()).slot, { limit: 0 });
      const results = await twoPending(owner, settle);
      chain.dropTransaction(results[0]!.txHash);
      const before = submissions;
      now = first.intent.validUntil + 1000;
      chain.mineBlock(2);
      await sequencer.reconcile();
      await sequencer.reconcile();
      await delay(50);
      for (const result of results) assert.equal((await owner.getSettle(result.id)).status, 'failed');
      assert.equal(submissions, before, 'expired requests must not submit a rebuild');
      assert.deepEqual(chain.mempoolTxIds(), []);
    }, 1000);
  });
  await t.test('REL-08 another party spends the pool first', async () => {
    await chained(async (owner, sequencer, settle) => {
      const result = await settle(await freshRequest(first, owner));
      chain.dropTransaction(result.txHash);
      const competing = await directSettle(requests[1]!);
      await submit(competing.signed);
      assert.deepEqual(mineConfirmed().txIds, [competing.txId]);
      await sequencer.reconcile();
      await sequencer.reconcile();
      await waitFor(() => chain.mempoolTxIds().length === 1, 'the dropped settle must rebuild on the competing head');
      const rebuilt = chain.mempoolTxIds()[0]!;
      assert.ok(decodeTx(chain.transaction(rebuilt)!.cbor).inputs.some(ref => ref.txId === competing.txId));
      assert.deepEqual(mineConfirmed().txIds, [rebuilt]);
      await sequencer.reconcile();
      const status = await owner.getSettle(result.id);
      assert.equal(status.status, 'confirmed');
      assert.equal(status.txHash, rebuilt);
      assert.notEqual(status.txHash, result.txHash);
      assert.equal(await chain.transactionStatus(status.txHash), 'confirmed');
    });
  });
  await t.test('REL-09 a settle never pays twice', async () => {
    await chained(async (owner, sequencer, settle) => {
      const result = await settle(await freshRequest(first, owner));
      const original = chain.transaction(result.txHash)!.cbor;
      chain.dropTransaction(result.txHash);
      await rotateFeeInput(original);
      await sequencer.reconcile();
      await sequencer.reconcile();
      await waitFor(() => chain.mempoolTxIds().length === 1, 'the dropped settle must be rebuilt before replay');
      const rebuilt = chain.mempoolTxIds()[0]!;
      assert.notEqual(rebuilt, result.txHash);
      try { await submit(original); }
      catch (error) { assert.ok(error instanceof SubmitRejected); }
      const block = mineConfirmed();
      const candidates = [result.txHash, rebuilt];
      assert.equal(block.txIds.filter(txId => candidates.includes(txId)).length, 1);
      assert.equal((await Promise.all(candidates.map(txId => chain.transactionStatus(txId))))
        .filter(status => status === 'confirmed').length, 1);
      await sequencer.reconcile();
      const status = await owner.getSettle(result.id);
      assert.equal(status.status, 'confirmed');
      assert.equal(await chain.transactionStatus(status.txHash), 'confirmed');
      const outputs = await chain.getUtxosAt(first.intent.payouts[0]!.address);
      assert.equal(outputs.reduce((sum, utxo) => sum + utxo.value.lovelace, 0n), 2_000_000n);
    });
  });
  await t.test('REL-03: invalid proofs and mismatched intents never reach submission', async () => {
    const before = submissions;
    await rejects(relayer.settle({ ...await freshRequest(), proof: { ...first.proof, a: first.proof.c } }), 'invalid_proof');
    await rejects(relayer.settle({ ...await freshRequest(), proof: { ...first.proof, a: '00'.repeat(48) } }), 'invalid_proof');
    for (const change of [
      { ...first.intent, payouts: [{ ...first.intent.payouts[0]!, amount: 2_000_001n }] },
      { ...first.intent, relayer: hex(keyHash(keys.crank)) },
      { ...first.intent, poolId: 'ab'.repeat(28) },
      { ...first.intent, validUntil: first.intent.validUntil + 1 },
    ]) await rejects(relayer.settle({ ...first, intent: change }), 'intent_mismatch');
    await rejects(relayer.settle({ ...first, publicInputs: { ...first.publicInputs, withdrawn: first.publicInputs.withdrawn + 1n } }), 'intent_mismatch');
    await rejects(relayer.settle({ ...first, publicInputs: { ...first.publicInputs, context: first.publicInputs.context + 1n } }), 'intent_mismatch');
    await rejects(relayer.settle({ ...await freshRequest(), publicInputs: { ...first.publicInputs, nullifierHash: first.publicInputs.nullifierHash + R } }), 'invalid_proof');
    await rejects(relayer.settle({ ...first, quoteId: 'missing' }), 'not_found');
    assert.equal(submissions, before);
  });
  await t.test('REL-03: invalid proof makes no chain reads and consumes its quote', async () => {
    for (const a of [first.proof.c, '00'.repeat(48)]) {
      let indexerCalls = 0;
      let providerCalls = 0;
      const counted = new Proxy(chain, { get(target, property) {
        const value: unknown = Reflect.get(target, property);
        return typeof value === 'function' ? (...args: unknown[]) => {
          providerCalls++;
          return Reflect.apply(value, target, args);
        } : value;
      } });
      // The sequencer keeps its own provider, so it must count through the same proxy.
      const countedCtx: ChainContext = { ...ctx, provider: counted };
      const owner = new Relayer({ ctx: countedCtx, sequencer: new Sequencer({ ctx: countedCtx, status: counted }), indexer,
        seed: keys.relayer, vkey: artifacts.spend.vkey, quoteTtlMs: 600_000, now: () => now });
      const request = { ...await freshRequest(first, owner), proof: { ...first.proof, a } };
      const getPool = indexer.getPool;
      const getNullifiers = indexer.getNullifiers;
      indexer.getPool = async () => { indexerCalls++; return getPool(); };
      indexer.getNullifiers = async (...args) => { indexerCalls++; return getNullifiers(...args); };
      try {
        await rejects(owner.settle(request), 'invalid_proof');
        assert.equal(indexerCalls, 0);
        assert.equal(providerCalls, 0);
        await rejects(owner.settle(request), 'not_found');
        assert.equal(indexerCalls, 0);
        assert.equal(providerCalls, 0);
      } finally {
        indexer.getPool = getPool;
        indexer.getNullifiers = getNullifiers;
      }
    }
  });
  await t.test('REL-04: stale roots and a full queue report their own errors', async () => {
    const before = submissions;
    const original = indexer.getPool;
    indexer.getPool = async () => ({ ...await original(), roots: [1n] });
    await rejects(relayer.settle(first), 'stale_root');
    indexer.getPool = async () => ({ ...await original(), aspRoot: 1n });
    await rejects(relayer.settle(first), 'stale_asp_root');
    indexer.getPool = async () => ({ ...await original(), queue: Array<bigint>(8).fill(1n) });
    await rejects(relayer.settle(first), 'queue_full');
    indexer.getPool = original;
    assert.equal(submissions, before);
  });
  await t.test('REL-02: failed builds log the underlying error and keep API errors general', async () => {
    const original = chain.getProtocolParameters;
    const underlying = new Error('private build diagnostic');
    chain.getProtocolParameters = async () => { throw underlying; };
    try {
      await assert.rejects(relayer.settle(first), error => error instanceof ApiError
        && error.code === 'internal' && error.message === 'Could not build or submit the settle transaction');
      assert.ok(logs.some(entry => entry.error === underlying));
      assert.equal((await relayer.getSettle(first.quoteId)).error, 'Could not build or submit the settle transaction');
    } finally { chain.getProtocolParameters = original; }
  });
  await t.test('REL-02: a failure before any submit call stays a definite error', async () => {
    const owner = new Relayer({ ctx, sequencer: new Sequencer({ ctx, status: chain }), indexer, seed: keys.relayer, vkey: artifacts.spend.vkey,
      quoteTtlMs: 600_000, retryDelayMs: 5, now: () => now });
    const request = await freshRequest(first, owner);
    const original = chain.getProtocolParameters;
    const before = submissions;
    chain.getProtocolParameters = async () => { throw new Error('private build diagnostic'); };
    try {
      await rejects(owner.settle(request), 'internal');
      assert.equal(submissions, before);
      assert.deepEqual(await owner.getSettle(request.quoteId), {
        id: request.quoteId, status: 'failed', txHash: '00'.repeat(32), confirmations: 0,
        error: 'Could not build or submit the settle transaction',
      });
    } finally { chain.getProtocolParameters = original; }
  });
  // A lost reply is an unknown outcome. The last two cases never reach a mempool, so the sequencer
  // resets them as dropped: a valid quote is rebuilt, and an expired one fails at its deadline.
  for (const [mode, name] of [
    ['landed', 'REL-05: a submit whose reply is lost is uncertain, and its landed transaction confirms'],
    ['late', 'REL-05: a submit whose reply is lost and whose block is late is uncertain'],
    ['rebuilt', 'REL-05: a submit that failed for good stays uncertain until a reset, then is rebuilt and confirms'],
    ['expired', 'REL-05: a submit that failed for good stays uncertain until a reset, then fails at its deadline'],
  ] as const) {
    await t.test(name, async () => {
      const sequencer = new Sequencer({ ctx, status: chain });
      const owner = new Relayer({ ctx, sequencer, indexer, seed: keys.relayer, vkey: artifacts.spend.vkey,
        quoteTtlMs: 600_000, retryDelayMs: 5, now: () => now });
      const request = await freshRequest(first, owner);
      const original = chain.submit;
      const height = chain.blocks().length;
      const spentCount = spent.length;
      const saved = now;
      const lands = mode === 'landed' || mode === 'late';
      let attempts = 0;
      let txHash = '';
      chain.submit = async cbor => {
        attempts++;
        txHash = decodeTx(cbor).txId;
        if (lands) await original(cbor);
        throw new Error('private lost submit reply');
      };
      try {
        const failure = await owner.settle(request).then(() => undefined, (error: unknown) => error);
        assert.ok(failure instanceof ApiError);
        assert.equal(failure.code, 'uncertain');
        assert.equal(failure.status, 503);
        assert.ok(!failure.message.includes('private lost submit reply'));
        // The transaction may be in a mempool, so the sequencer keeps it pending.
        assert.deepEqual(sequencer.pending().map(entry => entry.txId), [txHash], 'an unknown outcome stays pending in the sequencer');
        const status = await owner.getSettle(request.quoteId);
        assert.equal(status.status, 'submitted');
        assert.equal(status.txHash, txHash);
        assert.equal(status.error, null);
        assert.deepEqual(await owner.settle(request), status, 'a replay must keep tracking the same transaction');
        if (mode === 'late') {
          const getPool = indexer.getPool;
          indexer.getPool = async () => { throw new ApiError('internal', 'private indexer diagnostic'); };
          try {
            await assert.rejects(owner.settle(request), error => error instanceof ApiError
              && error.code === 'uncertain' && !error.message.includes('private indexer diagnostic'));
            await rejects(owner.getSettle(request.quoteId), 'uncertain');
          } finally { indexer.getPool = getPool; }
        }
        if (lands) {
          mine();
          await sequencer.reconcile();
          assert.equal(attempts, 1);
          assert.deepEqual(await owner.getSettle(request.quoteId), { ...status, status: 'confirmed', confirmations: 1 });
        } else if (mode === 'rebuilt') {
          // The node answers again, so the rebuild can land.
          chain.submit = original;
          const before = submissions;
          // Two reads that cannot find the transaction reset it as dropped.
          await sequencer.reconcile();
          await sequencer.reconcile();
          await waitFor(() => chain.mempoolTxIds().length === 1, 'a dropped settle with a valid quote must be rebuilt');
          assert.equal(submissions, before + 1, 'one rebuild reaches submission');
          assert.equal((await owner.getSettle(request.quoteId)).status, 'submitted');
          mine();
          await sequencer.reconcile();
          const confirmed = await owner.getSettle(request.quoteId);
          assert.equal(confirmed.status, 'confirmed');
          assert.equal(confirmed.confirmations, 1);
          assert.equal(confirmed.error, null);
          assert.equal(await chain.transactionStatus(confirmed.txHash), 'confirmed');
        } else {
          // The quote expires before the reset, so nothing is rebuilt.
          now = request.intent.validUntil;
          await sequencer.reconcile();
          await sequencer.reconcile();
          assert.equal((await owner.getSettle(request.quoteId)).status, 'submitted', 'wall-clock expiry is not confirmed chain expiry');
          chain.mineBlock(timeToSlot(request.intent.validUntil, network) - (await chain.getTip()).slot + 1);
          await sequencer.reconcile();
          assert.deepEqual(await owner.getSettle(request.quoteId),
            { ...status, status: 'failed', error: 'Expired before confirmation' });
          await rejects(owner.settle(request), 'uncertain');
          assert.equal(attempts, 1, 'a quote that reached submission must not be submitted again');
          assert.deepEqual(chain.mempoolTxIds(), []);
        }
      } finally {
        chain.submit = original;
        now = saved;
        chain.rollback(chain.blocks().length - height);
        spent.length = spentCount;
        pending = [];
      }
    });
  }
  await t.test('REL-02: failed pool reads log the underlying error', async () => {
    const original = chain.getUtxosAt;
    const underlying = new Error('private pool diagnostic');
    chain.getUtxosAt = async () => { throw underlying; };
    try {
      await assert.rejects(relayer.settle(first), error => error instanceof ApiError
        && error.code === 'internal' && error.message === 'Could not read the pool');
      assert.ok(logs.some(entry => entry.error === underlying));
    } finally { chain.getUtxosAt = original; }
  });
  await t.test('REL-03: unexpected verification errors reach the operator log', async () => {
    const underlying = new Error('private verifier diagnostic');
    const vkey = { ...artifacts.spend.vkey, get IC(): never { throw underlying; } };
    const owner = new Relayer({ ctx, sequencer: new Sequencer({ ctx, status: chain }), indexer, seed: keys.relayer, vkey, quoteTtlMs: 600_000,
      now: () => now, log: (message, error) => logs.push({ message, error }) });
    const request = await freshRequest(first, owner);
    await rejects(owner.settle(request), 'invalid_proof');
    assert.ok(logs.some(entry => entry.error === underlying));
    await rejects(owner.settle(request), 'not_found');
  });
  await t.test('REL-02: the queue cap rejects excess work but admits duplicate requests', async () => {
    const owner = new Relayer({ ctx, sequencer: new Sequencer({ ctx, status: chain }), indexer, seed: keys.relayer, vkey: artifacts.spend.vkey,
      quoteTtlMs: 600_000, retryDelayMs: 5, maxQueued: 1, now: () => now });
    const a = await freshRequest(first, owner);
    const b = await freshRequest(first, owner);
    const c = await freshRequest(first, owner);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const original = chain.getUtxosAt;
    let reads = 0;
    chain.getUtxosAt = async () => {
      reads++;
      entered();
      await gate;
      throw new Error('Pool temporarily unavailable');
    };
    const running = owner.settle(a);
    void running.catch(() => undefined);
    await started;
    const repeated = owner.settle(a);
    void repeated.catch(() => undefined);
    const queued = owner.settle(b);
    void queued.catch(() => undefined);
    const duplicate = owner.settle(b);
    void duplicate.catch(() => undefined);
    const before = reads;
    const rejected = Promise.resolve().then(() => owner.settle({ ...c,
      get proof(): never { throw new Error('The full queue must not clone another request'); } }));
    try {
      await assert.rejects(rejected, { code: 'internal', status: 503, message: 'Relayer is busy' });
      assert.equal(reads, before);
      assert.equal(running, repeated);
      assert.equal(queued, duplicate);
    } finally {
      release();
      await Promise.allSettled([running, repeated, queued, duplicate, rejected]);
      chain.getUtxosAt = original;
    }
    await rejects(owner.settle({ quoteId: 'missing' } as SettleRequest), 'not_found');
  });
  await t.test('REL-02: failed submission records expire during settle with a custom retention period', async () => {
    const owner = new Relayer({ ctx, sequencer: new Sequencer({ ctx, status: chain }), indexer, seed: keys.relayer, vkey: artifacts.spend.vkey,
      quoteTtlMs: 600_000, submissionTtlMs: 1000, now: () => now });
    const request = await freshRequest(first, owner);
    const original = chain.getProtocolParameters;
    const saved = now;
    chain.getProtocolParameters = async () => { throw new Error('Build temporarily unavailable'); };
    try {
      await rejects(owner.settle(request), 'internal');
      now = request.intent.validUntil + 999;
      await rejects(owner.settle({ quoteId: 'missing' } as SettleRequest), 'not_found');
      assert.equal((await owner.getSettle(request.quoteId)).status, 'failed');
      now++;
      await rejects(owner.settle({ quoteId: 'missing' } as SettleRequest), 'not_found');
      await rejects(owner.getSettle(request.quoteId), 'not_found');
    } finally { chain.getProtocolParameters = original; now = saved; }
  });
  await t.test('REL-03: quotes expire at their deadline', async () => {
    const saved = now;
    now = first.intent.validUntil;
    await rejects(relayer.settle(first), 'quote_expired');
    now = saved;
  });
  await t.test('REL-02: a dropped settle fails only after the indexer tip passes its deadline', async () => {
    let reads = 0;
    const statusIndexer: IndexerApi = { ...indexer,
      async getPool() { reads++; return indexer.getPool(); },
      async getNullifiers(from, limit) { reads++; return indexer.getNullifiers(from, limit); },
    };
    const owner = new Relayer({ ctx, sequencer: new Sequencer({ ctx, status: chain }), indexer: statusIndexer, seed: keys.relayer, vkey: artifacts.spend.vkey,
      quoteTtlMs: 600_000, now: () => now });
    const request = await freshRequest(first, owner);
    const original = chain.submit;
    const saved = now;
    const height = chain.blocks().length;
    let attempts = 0;
    chain.submit = async cbor => { attempts++; return decodeTx(cbor).txId; };
    try {
      const result = await owner.settle(request);
      assert.equal((await owner.getSettle(result.id)).status, 'submitted');
      now = request.intent.validUntil + 1;
      assert.equal((await owner.getSettle(result.id)).status, 'submitted', 'wall-clock expiry is not confirmed chain expiry');
      chain.mineBlock(timeToSlot(request.intent.validUntil, network) - (await chain.getTip()).slot);
      assert.equal((await owner.getSettle(result.id)).status, 'submitted');
      chain.mineBlock(1);
      const failed = await owner.getSettle(result.id);
      assert.deepEqual(failed, { ...result, status: 'failed', error: 'Expired before confirmation' });
      const before = reads;
      assert.deepEqual(await owner.getSettle(result.id), failed);
      assert.equal(reads, before, 'the terminal failure is stored');
      await rejects(owner.settle(request), 'uncertain');
      assert.equal(attempts, 1);
    } finally {
      chain.submit = original;
      now = saved;
      chain.rollback(chain.blocks().length - height);
    }
  });
  await t.test('REL-02, HTTP: a valid settle is submitted, then confirmed with the exact payout', async () => {
    assert.deepEqual(await client.getPool(), await relayer.getPool());
    const result = await client.settle(first);
    assert.equal(result.status, 'submitted');
    assert.equal((await client.getSettle(result.id)).status, 'submitted');
    assert.deepEqual(await chain.getUtxosAt(payer(sellers[0]!).address), []);
    mine();
    const confirmed = await client.getSettle(result.id);
    assert.equal(confirmed.status, 'confirmed');
    assert.equal(confirmed.confirmations, 1);
    assert.equal(confirmed.txHash, result.txHash);
    assert.equal((await chain.getUtxosAt(payer(sellers[0]!).address)).reduce((sum, u) => sum + u.value.lovelace, 0n), 2_000_000n);
    assert.equal((await readPool(ctx)).datum.feesAccrued, 20_000n);
    const before = submissions;
    assert.deepEqual(await relayer.settle(first), confirmed);
    assert.equal(submissions, before);
  });
  await t.test('REL-05: one stale nullifier list retries without a pool change', async () => {
    const owner = new Relayer({ ctx, sequencer: new Sequencer({ ctx, status: chain }), indexer, seed: keys.relayer, vkey: artifacts.spend.vkey,
      quoteTtlMs: 600_000, retryDelayMs: 5, now: () => now });
    const request = await freshRequest(requests[1]!, owner);
    const original = indexer.getNullifiers;
    const submit = chain.submit;
    let pages = 0;
    let attempts = 0;
    indexer.getNullifiers = async (from, limit) => ++pages === 1 ? { from, nullifiers: [] } : original(from, limit);
    chain.submit = async cbor => { attempts++; return decodeTx(cbor).txId; };
    try {
      assert.equal((await owner.settle(request)).status, 'submitted');
      assert.ok(pages >= 3);
      assert.equal(attempts, 1);
    } finally { indexer.getNullifiers = original; chain.submit = submit; }
  });
  await t.test('REL-02: duplicate running and queued settles share promises', async () => {
    const before = submissions;
    const a = relayer.settle(requests[1]!);
    const b = relayer.settle(requests[2]!);
    const duplicateA = relayer.settle(requests[1]!);
    const duplicateB = relayer.settle(requests[2]!);
    // Attach rejection handlers even if the identity assertion fails during the red run.
    void duplicateA.catch(() => undefined);
    void duplicateB.catch(() => undefined);
    const firstResult = await a;
    assert.equal(submissions, before + 1);
    assert.equal(firstResult.status, 'submitted');
    mine();
    const secondResult = await b;
    assert.equal(secondResult.status, 'submitted');
    assert.equal(submissions, before + 2);
    mine();
    await Promise.allSettled([duplicateA, duplicateB]);
    assert.equal(a, duplicateA);
    assert.equal(b, duplicateB);
    for (const result of [firstResult, secondResult]) assert.equal((await relayer.getSettle(result.id)).status, 'confirmed');
    for (const seller of sellers.slice(1, 3)) {
      assert.equal((await chain.getUtxosAt(payer(seller).address)).reduce((sum, u) => sum + u.value.lovelace, 0n), 2_000_000n);
    }
  });
  await t.test('REL-05: an unchanged pool is uncertain and exposes a safe submitted status', async () => {
    const sequencer = new Sequencer({ ctx, status: chain });
    const owner = new Relayer({ ctx, sequencer, indexer, seed: keys.relayer, vkey: artifacts.spend.vkey,
      quoteTtlMs: 600_000, retryDelayMs: 5, now: () => now, log: (message, error) => logs.push({ message, error }) });
    const request = await freshRequest(requests[3]!, owner);
    const original = chain.submit;
    let attempts = 0;
    // A plain provider error is an unknown outcome, not a refusal, so the relayer never retries it.
    chain.submit = async () => { attempts++; throw new Error('private provider diagnostic'); };
    try {
      const failure = await owner.settle(request).then(() => undefined, (error: unknown) => error);
      assert.ok(failure instanceof ApiError);
      assert.equal(failure.code, 'uncertain');
      assert.ok(!failure.message.includes('private provider diagnostic'));
      assert.equal(attempts, 1);
      const submitted = await owner.getSettle(request.quoteId);
      assert.equal(submitted.status, 'submitted');
      assert.equal(submitted.error, null);
      // The pool output stays reserved, so no other settle can spend it until a reconcile decides.
      assert.deepEqual(sequencer.pending().map(entry => entry.txId), [submitted.txHash], 'an unknown outcome stays pending in the sequencer');
      assert.equal(sequencer.canSubmit('settle'), false);
    } finally { chain.submit = original; }
  });
  await t.test('REL-05: a competing insertion mined during recovery permits a rebuilt settle', async () => {
    const current = await readPool(ctx);
    const plan = planInsert({ poolId: ctx.deployment.poolId, pool: current, config: (await readConfig(ctx)).datum, deposits: [] });
    assert.ok(plan);
    plan.flush = 1;
    plan.slots = plan.slots.slice(0, 1);
    const witness = insertWitness({ tree, slots: plan.slots });
    const proof = await prove(artifacts.insert, witness.input);
    const competing = await buildInsert(ctx, { payer: payer(keys.crank), pool: current, plan,
      proof: proof.cardano, newRoot: witness.newRoot });
    const sequencer = new Sequencer({ ctx, status: chain });
    const owner = new Relayer({ ctx, sequencer, indexer, seed: keys.relayer, vkey: artifacts.spend.vkey,
      quoteTtlMs: 600_000, retryDelayMs: 5, now: () => now });
    const request = await freshRequest(requests[3]!, owner);
    const original = chain.submit;
    const height = chain.blocks().length;
    const spentCount = spent.length;
    let attempts = 0;
    let refusal: unknown;
    chain.submit = async cbor => {
      attempts++;
      if (attempts > 1) return original(cbor);
      // Let evaluation pass, then reserve the confirmed pool in the mempool before the first submit.
      await submit(signTx(competing.cbor, [keys.crank]));
      try { return await original(cbor); }
      catch (error) { refusal = error; throw error; }
      // The insertion confirms after the refusal and before the relayer tries again.
      finally { mine(); }
    };
    try {
      const result = await owner.settle(request);
      assert.ok(refusal instanceof SubmitRejected, 'the node refuses a settle whose pool output is spent in its mempool');
      assert.equal(result.status, 'submitted');
      assert.equal(attempts, 2, 'the refused transaction and its rebuild each reach submission once');
      const tx = decodeTx(chain.transaction(result.txHash)!.cbor);
      assert.ok(tx.inputs.some(ref => ref.txId === competing.txId), 'the rebuild spends the new head');
      assert.deepEqual(settleProof(result.txHash), request.proof, 'the rebuild keeps the spend proof');
      assert.deepEqual(sequencer.pending().map(entry => entry.txId), [result.txHash], 'the rebuild goes through the sequencer');
      mine();
      await sequencer.reconcile();
      assert.equal((await owner.getSettle(result.id)).status, 'confirmed');
    } finally {
      chain.submit = original;
      chain.rollback(chain.blocks().length - height);
      spent.length = spentCount;
      pending = [];
    }
  });
  await t.test('REL-05: recovery stops when the quote expires during the wait', async () => {
    const owner = new Relayer({ ctx, sequencer: new Sequencer({ ctx, status: chain }), indexer, seed: keys.relayer, vkey: artifacts.spend.vkey,
      quoteTtlMs: 600_000, retryDelayMs: 5, now: () => now });
    const request = await freshRequest(requests[3]!, owner);
    const original = chain.submit;
    const saved = now;
    let attempts = 0;
    chain.submit = async () => {
      attempts++;
      now = request.intent.validUntil;
      throw new SubmitRejected('Pool reserved by another transaction', 'bad_inputs');
    };
    try {
      await rejects(owner.settle(request), 'quote_expired');
      assert.equal(attempts, 1);
      assert.deepEqual(chain.mempoolTxIds(), []);
      assert.deepEqual(await chain.getUtxosAt(request.intent.payouts[0]!.address), []);
    } finally { chain.submit = original; now = saved; }
  });
  await t.test('REL-05: two competing pool spends trigger two rebuilds and preserve the spend proof', async () => {
    const sequencer = new Sequencer({ ctx, status: chain });
    const owner = new Relayer({ ctx, sequencer, indexer, seed: keys.relayer, vkey: artifacts.spend.vkey,
      quoteTtlMs: 600_000, retryDelayMs: 5, now: () => now });
    const request = await freshRequest(requests[3]!, owner);
    const original = chain.submit;
    const height = chain.blocks().length;
    const spentCount = spent.length;
    const leafCount = leaves.length;
    const savedTree = tree;
    let races = 0;
    const refusals: unknown[] = [];
    const heads: string[] = [];
    chain.submit = async cbor => {
      if (races < 2) {
        races++;
        // The crank spends the pool first and its block lands, so our settle spends an output that is gone.
        const current = await readPool(ctx);
        const plan = planInsert({ poolId: ctx.deployment.poolId, pool: current, config: (await readConfig(ctx)).datum, deposits: [] });
        assert.ok(plan);
        plan.flush = 1;
        plan.slots = plan.slots.slice(0, 1);
        const witness = insertWitness({ tree, slots: plan.slots });
        const proof = await prove(artifacts.insert, witness.input);
        const tx = await buildInsert(ctx, { payer: payer(keys.crank), pool: current, plan, proof: proof.cardano, newRoot: witness.newRoot });
        await submit(signTx(tx.cbor, [keys.crank]));
        mine();
        tree = witness.tree;
        leaves.push(...witness.leaves);
        heads.push(tx.txId);
        try { return await original(cbor); }
        catch (error) { refusals.push(error); throw error; }
      }
      return original(cbor);
    };
    try {
      const result = await owner.settle(request);
      assert.equal(races, 2);
      assert.equal(refusals.length, 2);
      assert.ok(refusals.every(error => error instanceof SubmitRejected), 'the node refuses each settle on a spent pool output');
      assert.equal(result.status, 'submitted');
      const tx = decodeTx(chain.transaction(result.txHash)!.cbor);
      assert.ok(tx.inputs.some(ref => ref.txId === heads[1]), 'the third attempt spends the newest head');
      assert.deepEqual(settleProof(result.txHash), request.proof, 'every rebuild keeps the spend proof');
      assert.deepEqual(sequencer.pending().map(entry => entry.txId), [result.txHash], 'the rebuild goes through the sequencer');
      const before = submissions;
      assert.deepEqual(await owner.settle(request), result);
      assert.equal(submissions, before);
      mine();
      await sequencer.reconcile();
      assert.equal((await owner.getSettle(result.id)).status, 'confirmed');
      assert.equal((await readPool(ctx)).datum.queue.length, 2);
    } finally {
      chain.submit = original;
      chain.rollback(chain.blocks().length - height);
      tree = savedTree;
      leaves.length = leafCount;
      spent.length = spentCount;
      pending = [];
    }
  });
  await t.test('REL-01: old submissions expire after the default retention period during quote', async () => {
    const saved = now;
    try {
      now = first.intent.validUntil + 3_600_000 - 1;
      await relayer.quote(first.intent.payouts);
      assert.equal((await relayer.getSettle(first.quoteId)).status, 'confirmed');
      now++;
      await relayer.quote(first.intent.payouts);
      await rejects(relayer.getSettle(first.quoteId), 'not_found');
    } finally { now = saved; }
  });
});
