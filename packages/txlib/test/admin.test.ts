import assert from 'node:assert/strict';
import { after, test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  MerkleTree, NETWORKS, addressToBech32, contextFor, deriveNoteSecrets, insertWitness,
  precommitment, spendWitness, type SettleIntent,
} from '@zx402/crypto';
import { devKeysPresent, loadDevArtifacts, prove, shutdown } from '@zx402/prover';
import * as admin from '../src/admin.js';
import {
  buildDeposit, buildInsert, buildSettle, decodeTx, enterpriseAddress, keyHash, nullifierInsertion,
  planInsert, readAsp, readConfig, readDeposits, readPool, ScriptFailure, signTx, timeToSlot,
  type BuiltTx, type ConfigDatum, type Utxo,
} from '../src/index.js';
import { startDevnet } from '../src/testing/devnet.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
const sum = (utxos: Utxo[]): bigint => utxos.reduce((total, u) => total + u.value.lovelace, 0n);
const measured = (t: TestContext, name: string, tx: BuiltTx, seeds: Uint8Array[]) => t.diagnostic(JSON.stringify({
  name, size: tx.size, signedSize: decodeTx(signTx(tx.cbor, seeds)).size, fee: tx.fee, exUnits: tx.exUnits,
}, (_, value: unknown) => typeof value === 'bigint' ? String(value) : value));
after(shutdown);

test('ADM-01: pause preserves config state and blocks deposits; unpause restores deposits', { timeout: 180_000 }, async t => {
  const { ctx, chain, keys, run } = await startDevnet();
  const before = await readConfig(ctx);
  const payer = { address: enterpriseAddress(keys.operator, ctx.deployment.network) };
  const signers = keys.admin.map(seed => hex(keyHash(seed)));
  const paused = { ...before.datum, depositsPaused: true };
  const tx = await admin.buildConfigUpdate(ctx, { payer, config: paused, signers });
  measured(t, 'config update', tx, [keys.operator, ...keys.admin]);
  await run(tx, [keys.operator, ...keys.admin]);
  const after = await readConfig(ctx);
  assert.deepEqual(after.datum, paused);
  assert.equal(after.utxo.address, before.utxo.address);
  assert.deepEqual(after.utxo.value.assets, before.utxo.value.assets);
  const deposit = { payer, amount: 10_000_000n, precommitment: 42n, refundKeyHash: hex(keyHash(keys.operator)) };
  await assert.rejects(buildDeposit(ctx, deposit), /paused/i);
  await run(await admin.buildConfigUpdate(ctx, { payer, config: before.datum, signers }), [keys.operator, ...keys.admin]);
  await run(await buildDeposit(ctx, deposit), [keys.operator]);
  assert.equal((await readDeposits(ctx)).length, 1);
  assert.equal((await readConfig(ctx)).datum.depositsPaused, false);
  assert.equal(chain.blocks().at(-1)?.txIds.length, 1);
});

test('ADM-01: missing admin authorization fails evaluation and invalid config fails before building', { timeout: 180_000 }, async () => {
  const { ctx, keys, chain } = await startDevnet();
  const { datum } = await readConfig(ctx);
  const payer = { address: enterpriseAddress(keys.operator, ctx.deployment.network) };
  const signers = keys.admin.map(seed => hex(keyHash(seed)));
  await assert.rejects(admin.buildConfigUpdate(ctx, { payer, config: datum, signers: [] }), ScriptFailure);
  const signedByPayer = await admin.buildConfigUpdate(ctx, { payer, config: datum, signers });
  await assert.rejects(chain.submit(signTx(signedByPayer.cbor, [keys.operator])), /missing_signature/);
  const changes: Partial<ConfigDatum>[] = [
    { depositFeeBps: 101 }, { depositFeeBps: -1 }, { depositFeeBps: 0.5 },
    { settleFeeBps: 1001 }, { settleFeeBps: -1 }, { settleFeeBps: Number.NaN },
    { crankFee: 1_000_001n }, { crankFee: -1n }, { minDeposit: 0n },
    { minDeposit: datum.maxDeposit + 1n }, { poolCap: -1n }, { admins: [] },
    { admins: [datum.admins[0]!, datum.admins[0]!] },
    { admins: ['ab'.repeat(28), 'AB'.repeat(28)] }, { admins: ['12'] },
    { adminThreshold: 0 }, { adminThreshold: 2 }, { adminThreshold: 1.5 },
  ];
  // Invalid datums must be rejected before any provider request or transaction construction.
  const blocked = new Proxy(ctx.provider, { get() { throw new Error('Unexpected provider access'); } });
  for (const change of changes) {
    await assert.rejects(admin.buildConfigUpdate({ ...ctx, provider: blocked }, { payer, config: { ...datum, ...change }, signers }), /Invalid config/i);
  }
});

test('ADM-01: a larger admin datum takes its minimum lovelace increase from the payer', { timeout: 180_000 }, async () => {
  const { ctx, chain, keys, run } = await startDevnet();
  const old = await readConfig(ctx);
  const payer = { address: enterpriseAddress(keys.operator, ctx.deployment.network) };
  const before = sum(await chain.getUtxosAt(payer.address));
  const config = { ...old.datum, admins: [...old.datum.admins,
    ...Array.from({ length: 20 }, (_, i) => (i + 30).toString(16).padStart(56, '0'))] };
  const tx = await admin.buildConfigUpdate(ctx, { payer, config, signers: old.datum.admins });
  await run(tx, [keys.operator, ...keys.admin]);
  const next = await readConfig(ctx);
  assert.deepEqual(next.datum, config);
  const extra = next.utxo.value.lovelace - old.utxo.value.lovelace;
  assert.ok(extra > 0n);
  assert.equal(before - sum(await chain.getUtxosAt(payer.address)), extra + tx.fee);
  assert.deepEqual(next.utxo.value.assets, old.utxo.value.assets);
});

test('TX-15 Insert and ASP updates carry a deadline', { timeout: 180_000 }, async () => {
  const { chain, ctx, keys } = await startDevnet();
  const network = ctx.deployment.network;
  // Aiken's slot conversion starts at the network's configured Shelley-era origin.
  chain.advanceSlots(NETWORKS[network].zeroSlot);
  const payer = { address: enterpriseAddress(keys.asp, network) };
  const root = (await readAsp(ctx)).datum.root;
  const signers = [hex(keyHash(keys.asp))];
  const tip = await chain.getTip();
  const tx = await admin.buildAspUpdate(ctx, { payer, root, signers, validForMs: 120_000 });
  assert.equal(decodeTx(tx.cbor).invalidHereafter, timeToSlot(tip.time + 120_000, network));
  // No option means the ten-minute default.
  const fallback = await admin.buildAspUpdate(ctx, { payer, root, signers });
  assert.equal(decodeTx(fallback.cbor).invalidHereafter, timeToSlot(tip.time + 600_000, network));
  for (const validForMs of [0, -1, 1.5]) {
    await assert.rejects(admin.buildAspUpdate(ctx, { payer, root, signers, validForMs }), /positive safe integer/);
  }
});

test('ADM-02: zero, negative, and unaccrued fee collections are refused', { timeout: 180_000 }, async () => {
  const { ctx, keys } = await startDevnet();
  const payer = { address: enterpriseAddress(keys.operator, ctx.deployment.network) };
  for (const amount of [0n, -1n]) await assert.rejects(admin.buildCollectFees(ctx, { payer, amount }), /positive/i);
  await assert.rejects(admin.buildCollectFees(ctx, { payer, amount: 1n }), /accrued/i);
});

test('ADM-02, ADM-03: real proofs accrue fees and preserve exits during a pause', {
  timeout: 1_200_000,
  skip: devKeysPresent(repoRoot) ? false : 'Development proving keys are absent: circuits/build/dev/manifest.json is required',
}, async t => {
  const { ctx, chain, keys, run } = await startDevnet();
  const network = ctx.deployment.network;
  chain.advanceSlots(NETWORKS[network].zeroSlot);
  const payer = (seed: Uint8Array) => ({ address: enterpriseAddress(seed, network) });
  const original = (await readConfig(ctx)).datum;
  const config = { ...original, settleFeeBps: 100 };
  await run(await admin.buildConfigUpdate(ctx, { payer: payer(keys.operator), config, signers: original.admins }), [keys.operator, ...keys.admin]);
  const user = keys.users[0]!;
  const secrets = deriveNoteSecrets(user, 0);
  const deposit = async () => run(await buildDeposit(ctx, { payer: payer(user), amount: 20_000_000n,
    precommitment: precommitment(secrets.nullifier, secrets.secret), refundKeyHash: hex(keyHash(user)) }), [user]);
  await deposit();
  const pool = await readPool(ctx);
  const plan = planInsert({ poolId: ctx.deployment.poolId, pool, config, deposits: await readDeposits(ctx) });
  assert.ok(plan);
  const insertArtifact = await loadDevArtifacts('insert', repoRoot);
  const insertion = insertWitness({ tree: MerkleTree.empty(), slots: plan.slots });
  await run(await buildInsert(ctx, { payer: payer(keys.crank), pool, plan,
    proof: (await prove(insertArtifact, insertion.input)).cardano, newRoot: insertion.newRoot }), [keys.crank]);
  const note = { ...secrets, value: plan.credited[0]!.value, label: plan.credited[0]!.label };
  const aspTree = MerkleTree.fromLeaves([note.label]);
  await run(await admin.buildAspUpdate(ctx, { payer: payer(keys.asp), root: aspTree.root, signers: [hex(keyHash(keys.asp))] }), [keys.asp]);

  await t.test('ADM-03: a previously valid pending deposit Insert fails only after pausing', async () => {
    await deposit();
    const pool = await readPool(ctx);
    const plan = planInsert({ poolId: ctx.deployment.poolId, pool, config, deposits: await readDeposits(ctx) });
    assert.ok(plan);
    const witness = insertWitness({ tree: insertion.tree, slots: plan.slots });
    const args = { payer: payer(keys.crank), pool, plan,
      proof: (await prove(insertArtifact, witness.input)).cardano, newRoot: witness.newRoot };
    await buildInsert(ctx, args);
    await run(await admin.buildConfigUpdate(ctx, { payer: payer(keys.operator), config: { ...config, depositsPaused: true }, signers: config.admins }), [keys.operator, ...keys.admin]);
    await assert.rejects(buildInsert(ctx, args), ScriptFailure);
    assert.equal((await readDeposits(ctx)).length, 1);
  });

  await t.test('ADM-03: an existing note still settles while deposits are paused', async () => {
    const pool = await readPool(ctx);
    const intent: SettleIntent = { poolId: Buffer.from(ctx.deployment.poolId, 'hex'), relayer: null,
      validUntil: BigInt((await chain.getTip()).time + 300_000),
      payouts: [{ address: config.treasury, amount: 2_000_000n, datumHash: null }] };
    const fresh = deriveNoteSecrets(user, 1);
    const witness = spendWitness({ note, stateTree: insertion.tree, stateIndex: 0, aspTree, aspIndex: 0,
      withdrawn: 2_020_000n, newNullifier: fresh.nullifier, newSecret: fresh.secret, context: contextFor(intent) });
    const proof = await prove(await loadDevArtifacts('spend', repoRoot), witness.input);
    const trie = await nullifierInsertion([], witness.public.nullifierHash);
    await run(await buildSettle(ctx, { payer: payer(keys.relayer), pool, proof: proof.cardano,
      nullifierHash: witness.public.nullifierHash, newCommitment: witness.public.newCommitment,
      withdrawn: 2_020_000n, stateRoot: witness.public.stateRoot, intent,
      nullifierProof: trie.proofCbor, newNullifierRoot: trie.newRoot }), [keys.relayer]);
    assert.equal((await readPool(ctx)).datum.feesAccrued, 20_000n);
    assert.equal((await readConfig(ctx)).datum.depositsPaused, true);
  });

  await t.test('ADM-02: partial and remaining fees reach the treasury with a payer-funded minimum', async () => {
    const treasury = addressToBech32(config.treasury, network);
    for (const amount of [1n, 19_999n]) {
      const pool = await readPool(ctx);
      const treasuryBefore = sum(await chain.getUtxosAt(treasury));
      const payerBefore = sum(await chain.getUtxosAt(payer(keys.relayer).address));
      await assert.rejects(admin.buildCollectFees(ctx, { payer: payer(keys.relayer), amount: pool.datum.feesAccrued + 1n }), /accrued/i);
      const tx = await admin.buildCollectFees(ctx, { payer: payer(keys.relayer), amount });
      measured(t, 'fee collection', tx, [keys.relayer]);
      const view = decodeTx(tx.cbor);
      assert.equal(view.outputs[0]!.address, pool.utxo.address);
      assert.equal(view.outputs[1]!.address, treasury);
      assert.ok(view.outputs[1]!.value.lovelace > amount);
      assert.equal(view.hasWithdrawals, false);
      assert.equal(view.hasCertificates, false);
      assert.deepEqual(view.mint, {});
      await run(tx, [keys.relayer]);
      const next = await readPool(ctx);
      assert.equal(next.balance, pool.balance - amount);
      assert.deepEqual(next.datum, { ...pool.datum, feesAccrued: pool.datum.feesAccrued - amount });
      assert.deepEqual(next.utxo.value.assets, pool.utxo.value.assets);
      const received = sum(await chain.getUtxosAt(treasury)) - treasuryBefore;
      assert.equal(received, view.outputs[1]!.value.lovelace);
      assert.equal(payerBefore - sum(await chain.getUtxosAt(payer(keys.relayer).address)), tx.fee + received - amount);
    }
  });
});
