import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { IndexerApi } from '@zx402/api';
import {
  MerkleTree, NETWORKS, commitment, contextFor, deriveNoteSecrets, insertWitness,
  nullifierHash, precommitment, spendWitness, type Note,
} from '@zx402/crypto';
import { devKeysPresent, loadDevArtifacts, prove, shutdown } from '@zx402/prover';
import {
  Sequencer, buildAspUpdate, buildDeposit, buildSettle, decodeTx, encodeDepositDatum, enterpriseAddress, keyHash,
  nullifierInsertion, planInsert, readAsp, readConfig, readDeposits, readPool, signTx,
} from '@zx402/txlib';
import { startDevnet } from '@zx402/txlib/testing/devnet';
import { Crank } from '../src/index.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
after(shutdown);

test('CRK-01, CRK-02, CRK-03: real proof crank rounds', {
  timeout: 900_000,
  skip: devKeysPresent(repoRoot) ? false : 'Development proving keys are absent: circuits/build/dev/manifest.json is required',
}, async t => {
  const { chain, ctx, keys, run } = await startDevnet();
  const network = ctx.deployment.network;
  chain.advanceSlots(NETWORKS[network].zeroSlot);
  const payer = (seed: Uint8Array) => ({ address: enterpriseAddress(seed, network) });
  let tree = MerkleTree.empty();
  let leaves: bigint[] = [];
  const indexer: IndexerApi = {
    async getPool() {
      const [pool, config, asp, tip] = await Promise.all([readPool(ctx), readConfig(ctx), readAsp(ctx), chain.getTip()]);
      const { depositsPaused, minDeposit, maxDeposit, poolCap, depositFeeBps, settleFeeBps, crankFee } = config.datum;
      return { poolId: ctx.deployment.poolId, asset: 'lovelace', ...pool.datum, aspRoot: asp.datum.root,
        config: { depositsPaused, minDeposit, maxDeposit, poolCap, depositFeeBps, settleFeeBps, crankFee },
        tip: { slot: tip.slot, hash: tip.blockHash } };
    },
    async getLeaves(from, limit) {
      // Short pages exercise pagination even with only a few leaves.
      return { from, leaves: leaves.slice(from, from + Math.min(limit, 1)), size: leaves.length,
        root: MerkleTree.fromLeaves(leaves).root };
    },
    async getAspLeaves(from) { return { from, leaves: [], root: (await readAsp(ctx)).datum.root }; },
    async getNullifiers(from) { return { from, nullifiers: [] }; },
    async getDeposits() {
      return (await readDeposits(ctx)).map(({ utxo, datum }) => ({ ...utxo.ref, gross: utxo.value.lovelace,
        precommitment: datum.precommitment, refundKeyHash: datum.refund, status: 'pending' as const,
        value: null, label: null, leafIndex: null }));
    },
  };
  const artifacts = await loadDevArtifacts('insert', repoRoot);
  const sequencer = new Sequencer({ ctx, status: chain });
  const crank = new Crank({ ctx, indexer, seed: keys.crank, artifacts, sequencer });
  let submissions = 0;
  const submit = chain.submit.bind(chain);
  chain.submit = async cbor => { submissions++; return submit(cbor); };
  const secrets = keys.users.map(key => deriveNoteSecrets(key, 0));
  const deposit = async (user: number, amount: bigint) => {
    const key = keys.users[user]!;
    const note = secrets[user]!;
    await run(await buildDeposit(ctx, { payer: payer(key), amount,
      precommitment: precommitment(note.nullifier, note.secret), refundKeyHash: hex(keyHash(key)) }), [key]);
  };
  async function insert() {
    const pool = await readPool(ctx);
    const plan = planInsert({ poolId: ctx.deployment.poolId, pool, config: (await readConfig(ctx)).datum,
      deposits: await readDeposits(ctx) });
    assert.ok(plan);
    const expected = insertWitness({ tree, slots: plan.slots });
    const result = await crank.tick();
    assert.ok(result);
    assert.deepEqual({ notes: result.notes, deposits: result.deposits }, { notes: plan.flush, deposits: plan.deposits.length });
    assert.equal((await readPool(ctx)).datum.size, tree.size, 'submission does not imply confirmation');
    const block = chain.mineBlock();
    assert.ok(block.txIds.includes(result.txId));
    // The node reconciles after each block, so the confirmed Insert leaves the pending list.
    await sequencer.reconcile();
    leaves.push(...expected.leaves);
    tree = expected.tree;
    const next = await readPool(ctx);
    assert.equal(next.datum.roots[0], tree.root);
    assert.equal(next.datum.size, tree.size);
    return plan;
  }
  await t.test('CRK-01: an empty round submits nothing', async () => {
    assert.equal(await crank.tick(), null);
    assert.equal(submissions, 0);
  });
  let firstNote: Note;
  let firstIndex = 0;
  await t.test('CRK-02: two deposits enter the on-chain tree', async () => {
    await deposit(0, 20_000_000n);
    await deposit(1, 20_000_000n);
    const plan = await insert();
    assert.equal(plan.deposits.length, 2);
    firstIndex = plan.deposits.findIndex(d => d.datum.refund === hex(keyHash(keys.users[0]!)));
    firstNote = { ...secrets[0]!, value: plan.credited[firstIndex]!.value, label: plan.credited[firstIndex]!.label };
  });
  await t.test('CRK-01: a behind or inconsistent indexer submits nothing', async () => {
    await deposit(2, 10_000_000n);
    const before = submissions;
    const completeLeaves = leaves;
    leaves = [];
    assert.equal(await crank.tick(), null);
    leaves = completeLeaves.map(leaf => leaf + 1n);
    assert.equal(await crank.tick(), null);
    leaves = completeLeaves;
    assert.equal(submissions, before);
  });
  await t.test('CRK-02: queued change precedes a pending deposit', async () => {
    const aspTree = MerkleTree.fromLeaves([firstNote.label]);
    await run(await buildAspUpdate(ctx, { payer: payer(keys.asp), root: aspTree.root,
      signers: [hex(keyHash(keys.asp))] }), [keys.asp]);
    const intent = { poolId: Buffer.from(ctx.deployment.poolId, 'hex'), relayer: keyHash(keys.relayer),
      payouts: [{ address: { payment: { kind: 'key' as const, hash: keyHash(keys.users[0]!) }, stake: null },
        amount: 2_000_000n, datumHash: null }], validUntil: BigInt((await chain.getTip()).time + 300_000) };
    const fresh = deriveNoteSecrets(keys.users[0]!, 1);
    const witness = spendWitness({ note: firstNote, stateTree: tree, stateIndex: firstIndex, aspTree, aspIndex: 0,
      withdrawn: 3_000_000n, newNullifier: fresh.nullifier, newSecret: fresh.secret, context: contextFor(intent) });
    const proof = await prove(await loadDevArtifacts('spend', repoRoot), witness.input);
    const trie = await nullifierInsertion([], witness.public.nullifierHash);
    await run(await buildSettle(ctx, { payer: payer(keys.relayer), pool: await readPool(ctx), proof: proof.cardano,
      ...witness.public, withdrawn: 3_000_000n, intent, nullifierProof: trie.proofCbor, newNullifierRoot: trie.newRoot }), [keys.relayer]);
    const start = tree.size;
    const plan = await insert();
    assert.equal(plan.flush, 1);
    assert.equal(plan.deposits.length, 1);
    assert.equal(tree.leaf(start), commitment(witness.changeNote));
    assert.equal(plan.slots[0]!.kind, 'note');
    assert.equal(plan.slots[1]!.kind, 'deposit');
    assert.deepEqual((await readPool(ctx)).datum.queue, []);
  });
  await t.test('CRK-03: a below-minimum deposit and missing datum do not stall a valid deposit', async () => {
    const address = ctx.deployment.scripts.deposit.address;
    const invalid = chain.addUtxo({ address, value: { lovelace: 2_000_000n, assets: {} },
      inlineDatum: encodeDepositDatum({ precommitment: 42n, refund: hex(keyHash(keys.users[0]!)) }), datumHash: null, scriptRef: null });
    const noDatum = chain.addUtxo({ address, value: { lovelace: 10_000_000n, assets: {} },
      inlineDatum: null, datumHash: null, scriptRef: null });
    await deposit(0, 10_000_000n);
    assert.equal((await insert()).deposits.length, 1);
    assert.equal((await chain.getUtxos([invalid, noDatum])).length, 2);
    const before = submissions;
    assert.equal(await crank.tick(), null);
    assert.equal(submissions, before);
  });
  await t.test('CRK-01: pending insertion waits for confirmation before proving again', async () => {
    await deposit(0, 10_000_000n);
    const before = submissions;
    const plan = planInsert({ poolId: ctx.deployment.poolId, pool: await readPool(ctx),
      config: (await readConfig(ctx)).datum, deposits: await readDeposits(ctx) });
    assert.ok(plan);
    const expected = insertWitness({ tree, slots: plan.slots });
    const result = await crank.tick();
    assert.ok(result);
    assert.equal(submissions, before + 1);
    let leafReads = 0;
    const getLeaves = indexer.getLeaves;
    indexer.getLeaves = async (...args) => { leafReads++; return getLeaves(...args); };
    try {
      assert.equal(await crank.tick(), null);
      assert.equal(submissions, before + 1);
      assert.equal(leafReads, 0, 'waiting does not start witness construction');
    } finally {
      indexer.getLeaves = getLeaves;
      chain.mineBlock();
      await sequencer.reconcile();
      leaves.push(...expected.leaves);
      tree = expected.tree;
    }
    await deposit(1, 10_000_000n);
    assert.equal((await insert()).deposits.length, 1);
    assert.equal(submissions, before + 3);
  });
  await t.test('CRK-01: a dropped insertion retries after two reconciles', async () => {
    await deposit(0, 10_000_000n);
    // The sequencer counts a missing read once per unseenGapMs, so the test steps its clock between reconciles.
    let skew = 0;
    const retrySequencer = new Sequencer({ ctx, status: chain, now: () => Date.now() + skew });
    const retrying = new Crank({ ctx, indexer, seed: keys.crank, artifacts, sequencer: retrySequencer });
    const original = chain.submit.bind(chain);
    let attempts = 0;
    chain.submit = async cbor => { attempts++; return original(cbor); };
    try {
      const first = await retrying.tick();
      assert.ok(first);
      assert.equal(attempts, 1);
      // While the Insert is pending and not dropped, another round submits nothing.
      assert.equal(await retrying.tick(), null);
      assert.equal(attempts, 1);
      // Two unknown status reads in a row mean the transaction was dropped.
      chain.dropTransaction(first.txId);
      assert.equal(await retrySequencer.reconcile(), null);
      skew += 5_000;
      assert.equal((await retrySequencer.reconcile())?.reason, 'dropped');
      const plan = planInsert({ poolId: ctx.deployment.poolId, pool: await readPool(ctx),
        config: (await readConfig(ctx)).datum, deposits: await readDeposits(ctx) });
      assert.ok(plan);
      const second = await retrying.tick();
      assert.ok(second);
      assert.equal(attempts, 2);
      assert.deepEqual(chain.mempoolTxIds(), [second.txId]);
      // Confirm the retried Insert so the next round starts from a clean head.
      chain.mineBlock();
      await retrySequencer.reconcile();
      const expected = insertWitness({ tree, slots: plan.slots });
      leaves.push(...expected.leaves);
      tree = expected.tree;
    } finally { chain.submit = original; }
  });
  await t.test('CRK-04: an Insert chains on top of a pending Settle', async () => {
    // User 2's deposit nullifier is still unspent, so this note can settle once.
    await deposit(2, 20_000_000n);
    const stateIndex = tree.size;
    const plan = await insert();
    const creditIndex = plan.deposits.findIndex(d => d.datum.refund === hex(keyHash(keys.users[2]!)));
    assert.ok(creditIndex >= 0);
    const note: Note = { ...secrets[2]!, ...plan.credited[creditIndex]! };
    assert.equal(tree.leaf(stateIndex), commitment(note));
    // The spend proof needs the note's label in the confirmed ASP tree.
    const aspTree = MerkleTree.fromLeaves([note.label]);
    await run(await buildAspUpdate(ctx, { payer: payer(keys.asp), root: aspTree.root,
      signers: [hex(keyHash(keys.asp))] }), [keys.asp]);
    const intent = { poolId: Buffer.from(ctx.deployment.poolId, 'hex'), relayer: keyHash(keys.relayer),
      payouts: [{ address: { payment: { kind: 'key' as const, hash: keyHash(keys.users[0]!) }, stake: null },
        amount: 2_000_000n, datumHash: null }],
      validUntil: BigInt((await chain.getTip()).time + 300_000) };
    const fresh = deriveNoteSecrets(keys.users[2]!, 1);
    const spend = spendWitness({ note, stateTree: tree, stateIndex, aspTree, aspIndex: 0,
      withdrawn: 3_000_000n, newNullifier: fresh.nullifier, newSecret: fresh.secret, context: contextFor(intent) });
    const proof = await prove(await loadDevArtifacts('spend', repoRoot), spend.input);
    const chaining = new Sequencer({ ctx, status: chain, maxPending: 2 });
    const chained = new Crank({ ctx, indexer, seed: keys.crank, artifacts, sequencer: chaining });
    const trie = await nullifierInsertion([nullifierHash(firstNote.nullifier)], spend.public.nullifierHash);
    const settle = await chaining.run(async () => {
      const pool = await readPool(chaining.ctx);
      const tx = await buildSettle(chaining.ctx, { payer: payer(keys.relayer), pool, proof: proof.cardano,
        ...spend.public, withdrawn: 3_000_000n, intent, nullifierProof: trie.proofCbor, newNullifierRoot: trie.newRoot });
      return chaining.submit(signTx(tx.cbor, [keys.relayer]), { kind: 'settle', nullifier: spend.public.nullifierHash });
    });
    assert.equal(settle.status, 'accepted');
    const chainedResult = await chained.tick();
    assert.ok(chainedResult);
    // The Insert spends the pending Settle's pool output, not the confirmed one.
    const settleView = decodeTx(chain.transaction(settle.txId)!.cbor);
    const poolIndex = settleView.outputs.findIndex(output => output.address === ctx.deployment.scripts.pool.address);
    assert.ok(poolIndex >= 0);
    const insertView = decodeTx(chain.transaction(chainedResult.txId)!.cbor);
    assert.ok(insertView.inputs.some(ref => ref.txId === settle.txId && ref.index === poolIndex));
    // One block confirms the parent and the child.
    chain.mineBlock();
    await chaining.reconcile();
    const confirmed = await readPool(ctx);
    assert.ok(!confirmed.datum.queue.includes(spend.public.newCommitment));
    assert.deepEqual(confirmed.datum.queue, []);
  });
});
