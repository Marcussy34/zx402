import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import {
  CborWriter, Datum, Ed25519KeyHashHex, Hash, Hash32ByteBase16, Transaction, TransactionOutput, TxCBOR, deserializePlutusData,
} from '@meshsdk/core-cst';
import { blake2b } from '@noble/hashes/blake2.js';
import {
  R, NETWORKS, MerkleTree, commitment, contextFor, deriveNoteSecrets, deriveOneTimeKey, insertWitness,
  labelFor, precommitment, ragequitWitness, spendWitness,
  type Note, type Payout, type SettleIntent,
} from '@zx402/crypto';
import { devKeysPresent, loadDevArtifacts, prove, shutdown } from '@zx402/prover';
import { buildAspUpdate } from '../src/admin.js';
import { decodePoolDatum, decodePoolRedeemer, encodeDepositDatum, encodePoolDatum, encodePoolRedeemer, type ConfigDatum } from '../src/codec.js';
import { readAsp, readConfig, readDeposits, readPool, type DepositUtxo, type PoolState } from '../src/context.js';
import { PV11_COST_MODELS } from '../src/cost-models.js';
import { buildDeposit, buildRefund } from '../src/deposit.js';
import { buildInsert, planInsert } from '../src/insert.js';
import { enterpriseAddress, keyHash, signTx, verifyWitnesses } from '../src/keys.js';
import { nullifierInsertion, nullifierRoot } from '../src/nullifiers.js';
import { buildRagequit } from '../src/ragequit.js';
import { buildSettle } from '../src/settle.js';
import { buildStealthPayment, stealthFee } from '../src/stealth.js';
import { startDevnet } from '../src/testing/devnet.js';
import { LedgerError, type LedgerRule } from '../src/testing/fake-chain.js';
import { decodeTx } from '../src/txview.js';
import { ScriptFailure, slotToTime, timeToSlot, type BuiltTx } from '../src/types.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
after(shutdown);

test('TX-05, TX-06: nullifier roots are canonical sets and reject repeated spends', async () => {
  assert.equal(await nullifierRoot([]), '00'.repeat(32));
  const first = await nullifierInsertion([], 1n);
  assert.equal(first.oldRoot, '00'.repeat(32));
  assert.equal(first.newRoot, await nullifierRoot([1n]));
  assert.match(first.proofCbor, /^[0-9a-f]+$/);
  const next = await nullifierInsertion([1n], 2n);
  assert.equal(next.oldRoot, first.newRoot);
  assert.equal(next.newRoot, await nullifierRoot([2n, 1n]));
  await assert.rejects(nullifierInsertion([1n], 1n), /already|duplicate/i);
  for (const invalid of [-1n, R]) {
    await assert.rejects(nullifierInsertion([], invalid), /nullifier|canonical|field/i);
    await assert.rejects(nullifierRoot([invalid]), /nullifier|canonical|field/i);
  }
});

test('TX-04: planning prioritizes queue entries, sorts deposits, and skips invalid deposits', () => {
  const poolId = 'ab'.repeat(28);
  const datum = { roots: [MerkleTree.empty().root], size: 0, queue: [11n, 12n], nullifierRoot: '00'.repeat(32), feesAccrued: 0n };
  const pool: PoolState = { datum, balance: 6_000_000n, utxo: {
    ref: { txId: '00'.repeat(32), index: 0 }, address: '', value: { lovelace: 6_000_000n, assets: {} },
    inlineDatum: encodePoolDatum(datum), datumHash: null, scriptRef: null,
  } };
  const config: ConfigDatum = {
    admins: ['aa'.repeat(28)], adminThreshold: 1, treasury: { payment: { kind: 'key', hash: new Uint8Array(28) }, stake: null },
    depositsPaused: false, minDeposit: 5_000_000n, maxDeposit: 50_000_000n, poolCap: 500_000_000n,
    depositFeeBps: 100, settleFeeBps: 0, crankFee: 300_000n,
  };
  const deposit = (index: number, amount = 10_000_037n, pc = 42n): DepositUtxo => {
    const datum = { precommitment: pc, refund: 'aa'.repeat(28) };
    return { datum, utxo: { ref: { txId: 'bb'.repeat(32), index }, address: '',
      value: { lovelace: amount, assets: {} }, inlineDatum: encodeDepositDatum(datum), datumHash: null, scriptRef: null } };
  };
  const deposits = [deposit(10), deposit(3), deposit(2), deposit(0, 4_000_000n), deposit(1, 10_000_000n, R)];
  const plan = planInsert({ poolId, pool, config, deposits });
  assert.ok(plan);
  assert.equal(plan.flush, 2);
  assert.deepEqual(plan.deposits.map(d => d.utxo.ref.index), [2, 3]);
  assert.deepEqual(plan.slots.slice(0, 2), [{ kind: 'note', commitment: 11n }, { kind: 'note', commitment: 12n }]);
  assert.deepEqual(plan.credited.map(c => [c.value, c.fee]), [[9_600_037n, 100_000n], [9_600_037n, 100_000n]]);
  assert.equal(plan.credited[0]!.label, labelFor({ poolId: Buffer.from(poolId, 'hex'),
    txId: Buffer.from(deposits[2]!.utxo.ref.txId, 'hex'), outputIndex: 2, refundKeyHash: Buffer.from('aa'.repeat(28), 'hex') }));
  assert.deepEqual(deposits.map(d => d.utxo.ref.index), [10, 3, 2, 0, 1]);
  assert.equal(planInsert({ poolId, pool: { ...pool, datum: { ...datum, queue: [] } }, config, deposits: [] }), null);
  assert.equal(planInsert({ poolId, pool, config: { ...config, depositsPaused: true }, deposits })!.deposits.length, 0);
  assert.equal(planInsert({ poolId, pool, config: { ...config, poolCap: 6_000_000n }, deposits })!.deposits.length, 0);
  const malformed = deposit(0);
  malformed.utxo.inlineDatum = 'd87980';
  assert.equal(planInsert({ poolId, pool, config, deposits: [malformed] })!.deposits.length, 0);
  const noCredit = { ...config, crankFee: 10_000_000n };
  assert.equal(planInsert({ poolId, pool, config: noCredit, deposits: [deposit(0, 10_000_000n)] })!.deposits.length, 0);
});

test('TX-02 to TX-09: real proof pool story and rejected attacks', {
  timeout: 900_000,
  skip: devKeysPresent(repoRoot) ? false : 'Development proving keys are absent; the local pool story needs circuits/build/dev/manifest.json',
}, async t => {
  const { chain, ctx, keys, run } = await startDevnet();
  const network = ctx.deployment.network;
  // Aiken's slot conversion starts at the network's configured Shelley-era origin.
  chain.advanceSlots(NETWORKS[network].zeroSlot);
  const userA = keys.users[0]!;
  const userB = keys.users[1]!;
  const userC = keys.users[2]!;
  const payer = (key: Uint8Array) => ({ address: enterpriseAddress(key, network) });
  const totalAt = async (address: string) => (await chain.getUtxosAt(address)).reduce((sum, u) => sum + u.value.lovelace, 0n);
  const sellerKeys = Array.from({ length: 4 }, (_, i) => new Uint8Array(32).fill(100 + i));
  const payout = (key: Uint8Array, amount: bigint): Payout => ({ address: { payment: { kind: 'key', hash: keyHash(key) }, stake: null }, amount, datumHash: null });
  const artifacts = {
    insert: await loadDevArtifacts('insert', repoRoot), spend: await loadDevArtifacts('spend', repoRoot),
    ragequit: await loadDevArtifacts('ragequit', repoRoot),
  };
  let tree = MerkleTree.empty();
  let aspTree = MerkleTree.empty();
  const spent: bigint[] = [];
  const recorded: { name: string; tx: BuiltTx; signed: string }[] = [];
  const submit = async (name: string, tx: BuiltTx, seeds: Uint8Array[]) => {
    const signed = signTx(tx.cbor, seeds);
    await run(tx, seeds);
    recorded.push({ name, tx, signed });
  };
  const refused = async (cbor: string, seeds: Uint8Array[], rule: LedgerRule = 'script_failure') => {
    const before = chain.allUtxos();
    const signed = signTx(cbor, seeds);
    await assert.rejects(chain.submit(signed), (error: unknown) => error instanceof LedgerError && error.rule === rule);
    assert.deepEqual(chain.allUtxos(), before);
    assert.equal(chain.transaction(decodeTx(signed).txId), undefined);
  };
  const edit = (tx: BuiltTx, change: (tx: Transaction) => void): string => {
    const decoded = Transaction.fromCbor(TxCBOR(tx.cbor));
    change(decoded);
    // An attacker who edits a redeemer also fixes the script data hash, so the validator must be what refuses.
    // These transactions carry PlutusV3 redeemers and no witness datums.
    const redeemers = decoded.witnessSet().redeemers();
    if (redeemers && redeemers.size() > 0) {
      const writer = new CborWriter();
      writer.writeEncodedValue(Buffer.from(redeemers.toCbor(), 'hex'));
      writer.writeStartMap(1);
      writer.writeInt(2);
      writer.writeStartArray(PV11_COST_MODELS.PlutusV3.length);
      PV11_COST_MODELS.PlutusV3.forEach(cost => writer.writeInt(cost));
      const body = decoded.body();
      body.setScriptDataHash(Hash32ByteBase16(Buffer.from(blake2b(Buffer.from(writer.encodeAsHex(), 'hex'), { dkLen: 32 })).toString('hex')));
      decoded.setBody(body);
    }
    const result = decoded.toCbor();
    assert.notEqual(result, tx.cbor, 'The attack must change the serialized transaction');
    return result;
  };
  let deposits: DepositUtxo[] = [];
  let noteA: Note;
  let noteB: Note;
  let indexA = 0;
  let indexB = 0;
  let depositB: DepositUtxo;
  const secretsA = deriveNoteSecrets(userA, 0);
  const secretsB = deriveNoteSecrets(userB, 0);

  await t.test('TX-02: A deposits 10 ADA and B deposits 20 ADA', async () => {
    for (const [key, secrets, amount, name] of [
      [userA, secretsA, 10_000_000n, 'Deposit A'], [userB, secretsB, 20_000_000n, 'Deposit B'],
    ] as const) {
      const tx = await buildDeposit(ctx, { payer: payer(key), amount,
        precommitment: precommitment(secrets.nullifier, secrets.secret), refundKeyHash: hex(keyHash(key)) });
      await submit(name, tx, [key]);
    }
    deposits = await readDeposits(ctx);
    assert.equal(deposits.length, 2);
  });

  async function insert(name: string, attack = false, step = t) {
    const pool = await readPool(ctx);
    const config = await readConfig(ctx);
    const plan = planInsert({ poolId: ctx.deployment.poolId, pool, config: config.datum, deposits: await readDeposits(ctx) });
    assert.ok(plan);
    const witness = insertWitness({ tree, slots: plan.slots });
    const proof = await prove(artifacts.insert, witness.input);
    assert.deepEqual(proof.publicSignals, witness.publicInputs);
    const args = { payer: payer(keys.crank), pool, plan, proof: proof.cardano, newRoot: witness.newRoot };
    const tx = await buildInsert(ctx, args);
    if (attack) {
      await step.test('TX-04 attack: an insert root off by one fails evaluation and submission', async () => {
        await assert.rejects(buildInsert(ctx, { ...args, newRoot: witness.newRoot + 1n }), ScriptFailure);
        const bad = edit(tx, changed => {
          const body = changed.body();
          const outputs = body.outputs();
          const datum = decodePoolDatum(outputs[0]!.datum()!.asInlineData()!.toCbor());
          datum.roots[0] = datum.roots[0]! + 1n;
          outputs[0]!.setDatum(Datum.newInlineData(deserializePlutusData(encodePoolDatum(datum))));
          outputs[0] = TransactionOutput.fromCore(outputs[0]!.toCore());
          body.setOutputs(outputs);
          changed.setBody(body);
        });
        await refused(bad, [keys.crank]);
      });
    }
    const before = await totalAt(payer(keys.crank).address);
    await submit(name, tx, [keys.crank]);
    const crankFees = BigInt(plan.deposits.length) * config.datum.crankFee;
    assert.equal(await totalAt(payer(keys.crank).address), before + crankFees - tx.fee);
    tree = witness.tree;
    const after = await readPool(ctx);
    assert.equal(after.datum.size, tree.size);
    assert.equal(after.datum.roots[0], tree.root);
    assert.deepEqual(after.datum.queue, pool.datum.queue.slice(plan.flush));
    assert.equal(after.balance, pool.balance + plan.credited.reduce((sum, c) => sum + c.value + c.fee, 0n));
    return plan;
  }

  await t.test('TX-04: insert both deposits and pay the crank', async step => {
    const plan = await insert('Insert deposits', true, step);
    indexA = plan.deposits.findIndex(d => d.datum.refund === hex(keyHash(userA)));
    indexB = plan.deposits.findIndex(d => d.datum.refund === hex(keyHash(userB)));
    depositB = plan.deposits[indexB]!;
    noteA = { ...secretsA, value: plan.credited[indexA]!.value, label: plan.credited[indexA]!.label };
    noteB = { ...secretsB, value: plan.credited[indexB]!.value, label: plan.credited[indexB]!.label };
    assert.equal(noteA.value, 9_700_000n);
    assert.equal(noteB.value, 19_700_000n);
    assert.equal((await readPool(ctx)).balance, 35_400_000n);
  });

  await t.test('TX-07: ASP approves only A', async () => {
    aspTree = MerkleTree.fromLeaves([noteA.label]);
    const tx = await buildAspUpdate(ctx, { payer: payer(keys.asp), root: aspTree.root, signers: [hex(keyHash(keys.asp))] });
    await submit('ASP update', tx, [keys.asp]);
    assert.equal((await readAsp(ctx)).datum.root, aspTree.root);
  });

  await t.test('TX-05 attack: B cannot prove an unapproved note', () => {
    const before = chain.allUtxos();
    const fresh = deriveNoteSecrets(userB, 1);
    assert.throws(() => spendWitness({ note: noteB, stateTree: tree, stateIndex: indexB,
      aspTree, aspIndex: 0, withdrawn: 4_000_000n, newNullifier: fresh.nullifier, newSecret: fresh.secret, context: 0n }), /aspTree leaf/);
    assert.deepEqual(chain.allUtxos(), before);
  });

  async function prepare(payouts: Payout[], withdrawn: bigint, relayer: Uint8Array | null, noteIndex: number) {
    const pool = await readPool(ctx);
    const tip = await chain.getTip();
    const intent: SettleIntent = { poolId: Buffer.from(ctx.deployment.poolId, 'hex'), payouts,
      relayer, validUntil: BigInt(tip.time + 300_999) };
    const fresh = deriveNoteSecrets(userA, noteIndex);
    const witness = spendWitness({ note: noteA, stateTree: tree, stateIndex: indexA, aspTree, aspIndex: 0,
      withdrawn, newNullifier: fresh.nullifier, newSecret: fresh.secret, context: contextFor(intent) });
    const proof = await prove(artifacts.spend, witness.input);
    assert.deepEqual(proof.publicSignals, witness.publicInputs);
    const trie = await nullifierInsertion(spent, witness.public.nullifierHash);
    assert.equal(trie.oldRoot, pool.datum.nullifierRoot);
    const args = { payer: payer(keys.relayer), pool, proof: proof.cardano, nullifierHash: witness.public.nullifierHash,
      newCommitment: witness.public.newCommitment, withdrawn, stateRoot: witness.public.stateRoot,
      intent, nullifierProof: trie.proofCbor, newNullifierRoot: trie.newRoot };
    return { args, witness, tx: await buildSettle(ctx, args) };
  }
  async function settle(name: string, prepared: Awaited<ReturnType<typeof prepare>>) {
    const { args, tx, witness } = prepared;
    const view = decodeTx(tx.cbor);
    assert.equal(view.invalidHereafter, timeToSlot(Number(args.intent.validUntil), network));
    assert.ok(BigInt(slotToTime(view.invalidHereafter!, network)) <= args.intent.validUntil);
    assert.deepEqual(view.requiredSigners, args.intent.relayer === null ? [] : [hex(args.intent.relayer)]);
    assert.ok(view.referenceInputs.some(ref => ref.txId === ctx.deployment.refScripts.pool.txId && ref.index === ctx.deployment.refScripts.pool.index));
    assert.equal(view.witnessScriptHashes.length, 0);
    assert.equal(view.witnessKeyHashes.length, 0);
    await submit(name, tx, [keys.relayer]);
    spent.push(args.nullifierHash);
    noteA = witness.changeNote;
    const pool = await readPool(ctx);
    assert.equal(pool.balance, args.pool.balance - args.withdrawn);
    assert.deepEqual(pool.datum.queue, [...args.pool.datum.queue, commitment(noteA)]);
    assert.equal(pool.datum.nullifierRoot, await nullifierRoot(spent));
    assert.deepEqual(pool.datum.roots, args.pool.datum.roots);
    assert.equal(pool.datum.size, args.pool.datum.size);
  }
  let first: Awaited<ReturnType<typeof prepare>>;
  await t.test('TX-05: A pays 3 ADA with a named relayer and withdraws 4 ADA', async step => {
    first = await prepare([payout(sellerKeys[0]!, 3_000_000n)], 4_000_000n, keyHash(keys.relayer), 1);
    await step.test('TX-05 attack: raising one payout after proving fails', async () => {
      const bad = edit(first.tx, changed => {
        const body = changed.body();
        const outputs = body.outputs();
        outputs[1]!.amount().setCoin(outputs[1]!.amount().coin() + 1n);
        outputs[outputs.length - 1]!.amount().setCoin(outputs[outputs.length - 1]!.amount().coin() - 1n);
        body.setOutputs(outputs.map(output => TransactionOutput.fromCore(output.toCore())));
        changed.setBody(body);
      });
      await refused(bad, [keys.relayer]);
    });
    await step.test('TX-05 attack: submission at the exclusive expiry and a past intent fail', async () => {
      chain.advanceSlots(decodeTx(first.tx.cbor).invalidHereafter! - (await chain.getTip()).slot);
      await refused(first.tx.cbor, [keys.relayer], 'outside_validity_interval');
      chain.advanceSlots(1);
      assert.ok(BigInt((await chain.getTip()).time) > first.args.intent.validUntil);
      await refused(first.tx.cbor, [keys.relayer], 'outside_validity_interval');
      await assert.rejects(buildSettle(ctx, first.args), /expired|past|validUntil/i);
      first = await prepare([payout(sellerKeys[0]!, 3_000_000n)], 4_000_000n, keyHash(keys.relayer), 1);
    });
    await settle('Settle one payout', first);
    assert.equal(await totalAt(payer(sellerKeys[0]!).address), 3_000_000n);
    assert.equal(noteA.value, 5_700_000n);
  });

  await t.test('TX-04: insert A change without deposits', async () => {
    indexA = tree.size;
    const plan = await insert('Insert first change');
    assert.equal(plan.flush, 1);
    assert.deepEqual(plan.deposits, []);
  });

  await t.test('TX-05: A pays four outputs without naming a relayer', async step => {
    const prepared = await prepare(sellerKeys.map(key => payout(key, 900_000n)), 3_600_000n, null, 2);
    await step.test('TX-05 attack: reusing the first nullifier fails at the current pool', async () => {
      const bad = edit(prepared.tx, changed => {
        const witnesses = changed.witnessSet();
        const redeemers = witnesses.redeemers()!;
        const entry = redeemers.values()[0]!;
        // Only the spent nullifier changes; the transaction still spends the current pool input.
        // Use the codec to preserve the complete redeemer shape and proof bytes.
        const { dataCbor } = decodeTx(prepared.tx.cbor).redeemers[0]!;
        const decoded = decodePoolRedeemer(dataCbor);
        assert.equal(decoded.kind, 'Settle');
        entry.setData(deserializePlutusData(encodePoolRedeemer({ ...decoded, nullifierHash: first.args.nullifierHash })));
        redeemers.setValues([entry]);
        witnesses.setRedeemers(redeemers);
        changed.setWitnessSet(witnesses);
      });
      await refused(bad, [keys.relayer]);
    });
    await settle('Settle four payouts', prepared);
    assert.deepEqual(decodeTx(prepared.tx.cbor).outputs.slice(1, 5).map(o => o.value.lovelace), [900_000n, 900_000n, 900_000n, 900_000n]);
    assert.equal(noteA.value, 2_100_000n);
  });

  await t.test('TX-04, TX-09: insert change and pay through a one-time key', async () => {
    indexA = tree.size;
    await insert('Insert second change');
    const oneTimeSeed = deriveOneTimeKey(userA, 0);
    const price = 1_000_000n;
    const payTo = payer(sellerKeys[1]!).address;
    const legContext = { provider: chain, network };
    const fee = await stealthFee(legContext, { price, payTo });
    const prepared = await prepare([payout(oneTimeSeed, price + fee)], 2_000_000n, null, 3);
    await settle('Stealth funding', prepared);
    const [oneTimeUtxo] = await chain.getUtxosAt(payer(oneTimeSeed).address);
    assert.ok(oneTimeUtxo);
    const before = await totalAt(payTo);
    const tx = await buildStealthPayment(legContext, { oneTimeUtxo, oneTimeSeed, price, payTo });
    const view = decodeTx(tx.cbor);
    assert.equal(view.inputs.length, 1);
    assert.equal(view.outputs.length, 1);
    assert.equal(view.outputs[0]!.value.lovelace, price);
    assert.equal(tx.fee, oneTimeUtxo.value.lovelace - price);
    assert.equal(tx.fee, fee);
    assert.equal(view.witnessKeyHashes.length, 1);
    assert.ok(verifyWitnesses(tx.cbor));
    await submit('Stealth payment', tx, []);
    assert.equal(await totalAt(payTo), before + price);
    assert.deepEqual(await chain.getUtxosAt(payer(oneTimeSeed).address), []);
  });

  await t.test('TX-06: B exits without ASP approval and pays the network fee', async step => {
    const pool = await readPool(ctx);
    const witness = ragequitWitness({ note: noteB, stateTree: tree, stateIndex: indexB });
    const proof = await prove(artifacts.ragequit, witness.input);
    assert.deepEqual(proof.publicSignals, witness.publicInputs);
    const trie = await nullifierInsertion(spent, witness.nullifierHash);
    const args = { payer: payer(userB), pool, proof: proof.cardano, nullifierHash: witness.nullifierHash,
      value: noteB.value, stateRoot: witness.stateRoot, depositRef: depositB.utxo.ref, refundKeyHash: hex(keyHash(userB)),
      nullifierProof: trie.proofCbor, newNullifierRoot: trie.newRoot, payTo: payer(userB).address };
    const tx = await buildRagequit(ctx, args);
    assert.deepEqual(decodeTx(tx.cbor).requiredSigners, [hex(keyHash(userB))]);
    await step.test('TX-06 attack: replacing the refund signer fails', async () => {
      const fundedByRelayer = await buildRagequit(ctx, { ...args, payer: payer(keys.relayer) });
      const bad = edit(fundedByRelayer, changed => {
        const body = changed.body();
        const signers = body.requiredSigners()!;
        signers.setValues([Hash.fromCore(Ed25519KeyHashHex(hex(keyHash(keys.relayer))))]);
        body.setRequiredSigners(signers);
        changed.setBody(body);
      });
      // The relayer can fund fees but cannot authorize B's exit.
      await refused(bad, [keys.relayer]);
    });
    const before = await totalAt(payer(userB).address);
    await submit('Ragequit B', tx, [userB]);
    assert.equal(await totalAt(payer(userB).address), before + 19_700_000n - tx.fee);
    spent.push(witness.nullifierHash);
    const after = await readPool(ctx);
    assert.equal(after.balance, pool.balance - noteB.value);
    assert.deepEqual(after.datum, { ...pool.datum, nullifierRoot: await nullifierRoot(spent) });
  });

  await t.test('TX-03: C deposits and refunds before insertion', async () => {
    const secrets = deriveNoteSecrets(userC, 0);
    await submit('Deposit C', await buildDeposit(ctx, { payer: payer(userC), amount: 5_000_000n,
      precommitment: precommitment(secrets.nullifier, secrets.secret), refundKeyHash: hex(keyHash(userC)) }), [userC]);
    const [deposit] = await readDeposits(ctx);
    assert.ok(deposit);
    await submit('Refund C', await buildRefund(ctx, { payer: payer(userC), deposit, payTo: payer(userC).address }), [userC]);
    assert.deepEqual(await readDeposits(ctx), []);
    const plan = planInsert({ poolId: ctx.deployment.poolId, pool: await readPool(ctx), config: (await readConfig(ctx)).datum,
      deposits: await readDeposits(ctx) });
    assert.deepEqual(plan?.deposits ?? [], []);
  });

  await t.test('TX-08, BUD-01: every story transaction stays within 80 percent of the limits', async () => {
    const parameters = await chain.getProtocolParameters();
    const rows = recorded.map(({ name, tx, signed }) => {
      const view = decodeTx(signed);
      assert.deepEqual(view.mint, {});
      assert.equal(view.hasWithdrawals, false);
      assert.equal(view.hasCertificates, false);
      const cpu = tx.exUnits.reduce((sum, u) => sum + u.steps, 0n);
      const mem = tx.exUnits.reduce((sum, u) => sum + u.mem, 0n);
      assert.ok(cpu * 5n < parameters.maxTxExSteps * 4n, `${name}: CPU budget`);
      assert.ok(mem * 5n < parameters.maxTxExMem * 4n, `${name}: memory budget`);
      assert.ok(view.size * 5 < parameters.maxTxSize * 4, `${name}: signed size budget`);
      return { transaction: name, cpu: String(cpu), mem: String(mem), bytes: view.size, fee: String(tx.fee) };
    });
    console.table(rows);
  });
});

test('TX-15 Insert and ASP updates carry a deadline', {
  timeout: 900_000,
  skip: devKeysPresent(repoRoot) ? false : 'Development proving keys are absent; the deadline test needs circuits/build/dev/manifest.json',
}, async () => {
  const { chain, ctx, keys, run } = await startDevnet();
  const network = ctx.deployment.network;
  // Aiken's slot conversion starts at the network's configured Shelley-era origin.
  chain.advanceSlots(NETWORKS[network].zeroSlot);
  const user = keys.users[0]!;
  const payer = (key: Uint8Array) => ({ address: enterpriseAddress(key, network) });
  const secrets = deriveNoteSecrets(user, 0);
  await run(await buildDeposit(ctx, { payer: payer(user), amount: 10_000_000n,
    precommitment: precommitment(secrets.nullifier, secrets.secret), refundKeyHash: hex(keyHash(user)) }), [user]);
  const pool = await readPool(ctx);
  const config = await readConfig(ctx);
  const plan = planInsert({ poolId: ctx.deployment.poolId, pool, config: config.datum, deposits: await readDeposits(ctx) });
  assert.ok(plan);
  const witness = insertWitness({ tree: MerkleTree.empty(), slots: plan.slots });
  const proof = (await prove(await loadDevArtifacts('insert', repoRoot), witness.input)).cardano;
  const args = { payer: payer(keys.crank), pool, plan, proof, newRoot: witness.newRoot };
  const tip = await chain.getTip();
  const tx = await buildInsert(ctx, { ...args, validForMs: 120_000 });
  assert.equal(decodeTx(tx.cbor).invalidHereafter, timeToSlot(tip.time + 120_000, network));
  // No option means the ten-minute default.
  const fallback = await buildInsert(ctx, args);
  assert.equal(decodeTx(fallback.cbor).invalidHereafter, timeToSlot(tip.time + 600_000, network));
  for (const validForMs of [0, -1, 1.5]) {
    await assert.rejects(buildInsert(ctx, { ...args, validForMs }), /positive safe integer/);
  }
});
