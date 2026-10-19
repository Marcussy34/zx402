import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MerkleTree, NETWORKS, contextFor, deriveNoteSecrets, insertWitness, precommitment, spendWitness, type Note,
} from '@zx402/crypto';
import { devKeysPresent, loadDevArtifacts, prove, shutdown } from '@zx402/prover';
import {
  Sequencer, buildDeposit, buildInsert, buildSettle, enterpriseAddress, keyHash, nullifierInsertion,
  planInsert, readAsp, readConfig, readDeposits, readPool, signTx,
} from '@zx402/txlib';
import { startDevnet } from '@zx402/txlib/testing/devnet';
import { Indexer } from '@zx402/indexer';
import { AspService } from '../src/index.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
after(shutdown);

test('ASP-01, IDX-01: current and previous confirmed leaves survive indexer lag and restart', async t => {
  const { chain, ctx, keys } = await startDevnet();
  const build = fileURLToPath(new URL('../build/', import.meta.url));
  mkdirSync(build, { recursive: true });
  const directory = mkdtempSync(join(build, 'asp-live-test-'));
  t.after(() => rmSync(directory, { recursive: true }));
  const storePath = join(directory, 'labels.json');
  // A version 1 store has no published list. Its pending approval must preserve genesis.
  writeFileSync(storePath, JSON.stringify({ version: 1, poolId: ctx.deployment.poolId, leaves: ['11'], removed: [] }));
  let service: AspService;
  const indexer = new Indexer({ ctx, history: chain, aspLeaves: root => service.leaves(root) });
  const sequencer = new Sequencer({ ctx, status: chain });
  const options = { ctx, sequencer, indexer, payerSeed: keys.operator, operatorSeeds: [keys.asp], storePath };
  service = new AspService(options);
  await indexer.sync();
  assert.deepEqual((await indexer.getAspLeaves(0, 10)).leaves, []);
  assert.deepEqual(service.leaves(), [11n]);
  assert.deepEqual(service.leaves(123n), []);
  assert.ok((await service.tick()).txId);
  await indexer.sync();
  assert.deepEqual((await indexer.getAspLeaves(0, 10)).leaves, []);
  chain.mineBlock();
  // The node reconciles after each block, so the confirmed update leaves the pending list.
  await sequencer.reconcile();
  await indexer.sync();
  assert.deepEqual((await indexer.getAspLeaves(0, 10)).leaves, [11n]);
  const publishedRoot = (await indexer.getPool()).aspRoot;
  assert.deepEqual(await service.tick(), { approved: 0, txId: null });
  assert.deepEqual(JSON.parse(readFileSync(storePath, 'utf8')).published, ['11']);
  service.remove(11n);
  assert.ok((await service.tick()).txId);
  await indexer.sync();
  assert.deepEqual((await indexer.getAspLeaves(0, 10)).leaves, [11n]);
  service = new AspService(options);
  assert.deepEqual(service.leaves(), [0n]);
  assert.deepEqual(service.leaves(publishedRoot), [11n]);
  const copy = service.leaves(publishedRoot);
  copy[0] = 99n;
  assert.deepEqual(service.leaves(publishedRoot), [11n]);
  await indexer.sync();
  assert.deepEqual((await indexer.getAspLeaves(0, 10)).leaves, [11n]);
  const oldTip = await chain.getTip();
  chain.mineBlock();
  await sequencer.reconcile();
  await service.tick();
  const currentRoot = (await readAsp(ctx)).datum.root;
  // The ASP sees confirmation before the indexer's provider advances its tip.
  const lag = t.mock.method(chain, 'getTip', async () => oldTip);
  try {
    for (let restart = 0; restart < 2; restart += 1) {
      if (restart) service = new AspService(options);
      await indexer.sync();
      assert.deepEqual(await indexer.getAspLeaves(0, 10), { from: 0, leaves: [11n], root: publishedRoot });
      assert.deepEqual(service.leaves(publishedRoot), [11n]);
      assert.deepEqual(service.leaves(currentRoot), [0n]);
      const copy = service.leaves(publishedRoot);
      copy[0] = 99n;
      assert.deepEqual(service.leaves(publishedRoot), [11n]);
      assert.deepEqual(await service.tick(), { approved: 0, txId: null });
    }
  } finally { lag.mock.restore(); }
  await indexer.sync();
  assert.deepEqual(await indexer.getAspLeaves(0, 10), { from: 0, leaves: [0n], root: currentRoot });
  assert.deepEqual(JSON.parse(readFileSync(storePath, 'utf8')).previous, ['11']);
});

test('ASP-01: unchanged approved and published lists reuse cached roots', async t => {
  const { chain, ctx, keys } = await startDevnet();
  const indexer = new Indexer({ ctx, history: chain });
  await indexer.sync();
  const service = new AspService({ ctx, sequencer: new Sequencer({ ctx, status: chain }), indexer,
    payerSeed: keys.operator, operatorSeeds: [keys.asp] });
  const root = (await readAsp(ctx)).datum.root;
  const hashes = t.mock.method(MerkleTree, 'fromLeaves');
  for (let i = 0; i < 3; i += 1) {
    assert.deepEqual(service.leaves(root), []);
    assert.deepEqual(await service.tick(), { approved: 0, txId: null });
  }
  service.remove(99n);
  assert.deepEqual(service.leaves(root), []);
  assert.equal(hashes.mock.callCount(), 0);
});

test('ASP-01: a dropped submission is retried after two reconciles', async t => {
  const { chain, ctx, keys } = await startDevnet();
  const build = fileURLToPath(new URL('../build/', import.meta.url));
  mkdirSync(build, { recursive: true });
  const directory = mkdtempSync(join(build, 'asp-retry-test-'));
  t.after(() => rmSync(directory, { recursive: true }));
  const storePath = join(directory, 'labels.json');
  writeFileSync(storePath, JSON.stringify({ version: 1, poolId: ctx.deployment.poolId, leaves: ['11'], removed: [] }));
  const indexer = new Indexer({ ctx, history: chain });
  await indexer.sync();
  const submit = chain.submit.bind(chain);
  let submissions = 0;
  t.mock.method(chain, 'submit', async (cbor: string) => {
    submissions += 1;
    return submit(cbor);
  });
  const sequencer = new Sequencer({ ctx, status: chain });
  const service = new AspService({ ctx, sequencer, indexer, payerSeed: keys.operator, operatorSeeds: [keys.asp], storePath });
  const first = await service.tick();
  assert.ok(first.txId);
  // While the update is pending and not dropped, another round submits nothing.
  assert.deepEqual(await service.tick(), { approved: 0, txId: null });
  assert.equal(submissions, 1);
  // Two unknown status reads in a row mean the transaction was dropped.
  chain.dropTransaction(first.txId);
  assert.equal(await sequencer.reconcile(), null);
  assert.equal((await sequencer.reconcile())?.reason, 'dropped');
  const retry = await service.tick();
  assert.ok(retry.txId);
  assert.equal(submissions, 2);
  assert.deepEqual(chain.mempoolTxIds(), [retry.txId]);
  chain.mineBlock();
  await sequencer.reconcile();
  assert.equal((await readAsp(ctx)).datum.root, MerkleTree.fromLeaves([11n]).root);
  assert.deepEqual(await service.tick(), { approved: 0, txId: null });
  assert.equal(submissions, 2);
});

test('ASP-01, TX-07: automatic approval, denial, removal, and persistence', {
  timeout: 900_000,
  skip: devKeysPresent(repoRoot) ? false : 'Development proving keys are absent: circuits/build/dev/manifest.json',
}, async t => {
  const { chain, ctx, keys, run } = await startDevnet();
  chain.advanceSlots(NETWORKS[ctx.deployment.network].zeroSlot);
  const payer = (seed: Uint8Array) => ({ address: enterpriseAddress(seed, ctx.deployment.network) });
  const secrets = keys.users.slice(0, 2).map(seed => deriveNoteSecrets(seed, 0));
  for (const i of [0, 1]) {
    await run(await buildDeposit(ctx, { payer: payer(keys.users[i]!), amount: 10_000_000n,
      precommitment: precommitment(secrets[i]!.nullifier, secrets[i]!.secret),
      refundKeyHash: hex(keyHash(keys.users[i]!)) }), [keys.users[i]!]);
  }
  const pool = await readPool(ctx);
  const plan = planInsert({ poolId: ctx.deployment.poolId, pool,
    config: (await readConfig(ctx)).datum, deposits: await readDeposits(ctx) });
  assert.ok(plan);
  const witness = insertWitness({ tree: MerkleTree.empty(), slots: plan.slots });
  const proof = await prove(await loadDevArtifacts('insert', repoRoot), witness.input);
  await run(await buildInsert(ctx, { payer: payer(keys.crank), pool, plan, proof: proof.cardano,
    newRoot: witness.newRoot }), [keys.crank]);
  let service: AspService;
  const indexer = new Indexer({ ctx, history: chain, aspLeaves: root => service?.leaves(root) ?? [] });
  await indexer.sync();
  const labels = plan.credited.map(credit => credit.label);
  const sequencer = new Sequencer({ ctx, status: chain });
  const options = { ctx, sequencer, indexer, payerSeed: keys.operator, operatorSeeds: [keys.asp] };
  const build = fileURLToPath(new URL('../build/', import.meta.url));
  mkdirSync(build, { recursive: true });
  const directory = mkdtempSync(join(build, 'asp-test-'));
  const storePath = join(directory, 'labels.json');
  t.after(() => rmSync(directory, { recursive: true }));

  await t.test('ASP-01: absorbed labels produce the confirmed Merkle root once', async () => {
    service = new AspService({ ...options, storePath });
    const result = await service.tick();
    assert.equal(result.approved, 2);
    assert.ok(result.txId);
    assert.deepEqual(service.leaves(), labels);
    // Confirmation is explicit. A second tick must not double-spend the old ASP UTXO.
    assert.notEqual((await readAsp(ctx)).datum.root, MerkleTree.fromLeaves(labels).root);
    assert.deepEqual(await service.tick(), { approved: 0, txId: null });
    await indexer.sync();
    assert.deepEqual((await indexer.getAspLeaves(0, 10)).leaves, []);
    chain.mineBlock();
    await sequencer.reconcile();
    assert.equal((await readAsp(ctx)).datum.root, MerkleTree.fromLeaves(labels).root);
    await indexer.sync();
    assert.deepEqual((await indexer.getAspLeaves(0, 10)).leaves, labels);
    assert.deepEqual(await service.tick(), { approved: 0, txId: null });
  });

  await t.test('ASP-01: a denied deposit is omitted', async () => {
    const denied = new AspService({ ...options, deny: deposit => deposit.label === labels[1] });
    const result = await denied.tick();
    assert.equal(result.approved, 1);
    assert.ok(result.txId);
    assert.deepEqual(denied.leaves(), [labels[0]]);
    chain.mineBlock();
    await sequencer.reconcile();
    assert.equal((await readAsp(ctx)).datum.root, MerkleTree.fromLeaves([labels[0]!]).root);
    const restore = await service.tick();
    assert.ok(restore.txId);
    chain.mineBlock();
    await sequencer.reconcile();
  });

  await t.test('ASP-01: removal stays removed and prevents building a spend witness', async () => {
    const user = keys.users.findIndex(seed => hex(keyHash(seed)) === plan.deposits[0]!.datum.refund);
    const note: Note = { ...secrets[user]!, ...plan.credited[0]! };
    const fresh = deriveNoteSecrets(keys.users[user]!, 1);
    const args = { note, stateTree: witness.tree, stateIndex: 0, aspIndex: 0, withdrawn: 1_000_000n,
      newNullifier: fresh.nullifier, newSecret: fresh.secret, context: 0n };
    assert.doesNotThrow(() => spendWitness({ ...args, aspTree: MerkleTree.fromLeaves(service.leaves()) }));
    service.remove(labels[0]!);
    assert.deepEqual(service.leaves(), [0n, labels[1]]);
    const result = await service.tick();
    assert.equal(result.approved, 0);
    assert.ok(result.txId);
    chain.mineBlock();
    await sequencer.reconcile();
    assert.equal((await readAsp(ctx)).datum.root, MerkleTree.fromLeaves([0n, labels[1]!]).root);
    assert.throws(() => spendWitness({ ...args, aspTree: MerkleTree.fromLeaves(service.leaves()) }), /aspTree leaf/);
    assert.deepEqual(await service.tick(), { approved: 0, txId: null });
  });

  await t.test('ASP-01: restart preserves order and removal tombstones', async () => {
    service = new AspService({ ...options, storePath });
    assert.deepEqual(service.leaves(), [0n, labels[1]]);
    assert.deepEqual(await service.tick(), { approved: 0, txId: null });
    const copy = service.leaves();
    copy.push(42n);
    assert.equal(service.leaves().length, 2);
  });

  await t.test('ASP-01: missing operator signatures cannot post a root', async () => {
    const unauthorized = new AspService({ ...options, operatorSeeds: [] });
    const before = await readAsp(ctx);
    await assert.rejects(unauthorized.tick(), /threshold|operator|sign/i);
    assert.deepEqual(await readAsp(ctx), before);
  });

  await t.test('REL-10 a waiting ASP update holds new settles', async () => {
    const held = new Sequencer({ ctx, status: chain, maxPending: 2 });
    const aspTree = MerkleTree.fromLeaves(service.leaves());
    const user = keys.users.findIndex(seed => hex(keyHash(seed)) === plan.deposits[1]!.datum.refund);
    const note: Note = { ...secrets[user]!, ...plan.credited[1]! };
    const intent = { poolId: Buffer.from(ctx.deployment.poolId, 'hex'), relayer: keyHash(keys.relayer),
      payouts: [{ address: { payment: { kind: 'key' as const, hash: keyHash(keys.users[0]!) }, stake: null },
        amount: 1_000_000n, datumHash: null }],
      validUntil: BigInt((await chain.getTip()).time + 300_000) };
    const fresh = deriveNoteSecrets(keys.users[user]!, 1);
    const spend = spendWitness({ note, stateTree: witness.tree, stateIndex: 1, aspTree, aspIndex: 1,
      withdrawn: 1_000_000n, newNullifier: fresh.nullifier, newSecret: fresh.secret, context: contextFor(intent) });
    const spendProof = await prove(await loadDevArtifacts('spend', repoRoot), spend.input);
    const trie = await nullifierInsertion([], spend.public.nullifierHash);
    const settle = await held.run(async () => {
      const pool = await readPool(held.ctx);
      const tx = await buildSettle(held.ctx, { payer: payer(keys.relayer), pool, proof: spendProof.cardano,
        ...spend.public, withdrawn: 1_000_000n, intent, nullifierProof: trie.proofCbor, newNullifierRoot: trie.newRoot });
      return held.submit(signTx(tx.cbor, [keys.relayer]), { kind: 'settle', nullifier: spend.public.nullifierHash });
    });
    assert.equal(settle.status, 'accepted');
    // maxPending 2 leaves room for another Settle.
    assert.equal(held.canSubmit('settle'), true);
    // An approved label that is not yet published gives the service a new root.
    const waitingPath = join(directory, 'waiting.json');
    writeFileSync(waitingPath, JSON.stringify({ version: 1, poolId: ctx.deployment.poolId,
      leaves: ['0', String(labels[1]), '7'], removed: [] }));
    const waiting = new AspService({ ...options, sequencer: held, storePath: waitingPath, deny: () => true });
    assert.deepEqual(await waiting.tick(), { approved: 0, txId: null });
    assert.deepEqual(chain.mempoolTxIds(), [settle.txId]);
    // The waiting update stops the sequencer admitting new Settles.
    assert.equal(held.canSubmit('settle'), false);
    // Drop the Settle so the next test builds on the same confirmed head.
    assert.deepEqual(chain.dropTransaction(settle.txId), [settle.txId]);
    assert.equal(await held.reconcile(), null);
    assert.equal((await held.reconcile())?.reason, 'dropped');
  });

  await t.test('REL-10: the ASP gate waits for a pending Settle', async () => {
    const aspTree = MerkleTree.fromLeaves(service.leaves());
    const user = keys.users.findIndex(seed => hex(keyHash(seed)) === plan.deposits[1]!.datum.refund);
    const note: Note = { ...secrets[user]!, ...plan.credited[1]! };
    const intent = { poolId: Buffer.from(ctx.deployment.poolId, 'hex'), relayer: keyHash(keys.relayer),
      payouts: [{ address: { payment: { kind: 'key' as const, hash: keyHash(keys.users[0]!) }, stake: null },
        amount: 1_000_000n, datumHash: null }],
      validUntil: BigInt((await chain.getTip()).time + 300_000) };
    const fresh = deriveNoteSecrets(keys.users[user]!, 1);
    const spend = spendWitness({ note, stateTree: witness.tree, stateIndex: 1, aspTree, aspIndex: 1,
      withdrawn: 1_000_000n, newNullifier: fresh.nullifier, newSecret: fresh.secret, context: contextFor(intent) });
    const spendProof = await prove(await loadDevArtifacts('spend', repoRoot), spend.input);
    const trie = await nullifierInsertion([], spend.public.nullifierHash);
    const settle = await sequencer.run(async () => {
      const pool = await readPool(sequencer.ctx);
      const tx = await buildSettle(sequencer.ctx, { payer: payer(keys.relayer), pool, proof: spendProof.cardano,
        ...spend.public, withdrawn: 1_000_000n, intent, nullifierProof: trie.proofCbor, newNullifierRoot: trie.newRoot });
      return sequencer.submit(signTx(tx.cbor, [keys.relayer]), { kind: 'settle', nullifier: spend.public.nullifierHash });
    });
    assert.equal(settle.status, 'accepted');
    // A pending Settle uses the current ASP output, so the update must wait.
    service.remove(labels[1]!);
    assert.deepEqual(await service.tick(), { approved: 0, txId: null });
    assert.deepEqual(chain.mempoolTxIds(), [settle.txId]);
    chain.mineBlock();
    await sequencer.reconcile();
    const update = await service.tick();
    assert.ok(update.txId);
    // A pending ASP update blocks the next Settle.
    assert.equal(sequencer.canSubmit('settle'), false);
    chain.mineBlock();
    await sequencer.reconcile();
    assert.equal((await readAsp(ctx)).datum.root, MerkleTree.fromLeaves(service.leaves()).root);
  });
});
