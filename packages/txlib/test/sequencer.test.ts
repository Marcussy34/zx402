import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import {
  Sequencer, SubmitRejected, decodeTx, enterpriseAddress, newTxBuilder, signTx,
  type ChainContext, type Deployment, type PoolTxKind, type Provider, type ResetEvent, type TxStatusReader, type Utxo,
} from '../src/index.js';
import { FakeChain } from '../src/testing/fake-chain.js';

const keys = [randomBytes(32), randomBytes(32), randomBytes(32)] as const;
const addresses = keys.map(key => enterpriseAddress(key));
// Plain key transfers do not read pool deployment data.
const deployment = {} as Deployment;

function setup() {
  const chain = new FakeChain({ startSlot: 100 });
  const input: Utxo = {
    ref: { txId: '10'.repeat(32), index: 0 }, address: addresses[0]!,
    value: { lovelace: 20_000_000n, assets: {} }, inlineDatum: null, datumHash: null, scriptRef: null,
  };
  chain.addUtxo(input);
  const ctx: ChainContext = { provider: chain, deployment };
  return { chain, ctx, input };
}

function providerWith(chain: Provider, overrides: Partial<Provider>): Provider {
  return {
    getUtxosAt: address => chain.getUtxosAt(address), getUtxos: refs => chain.getUtxos(refs),
    getProtocolParameters: () => chain.getProtocolParameters(), getTip: () => chain.getTip(),
    evaluate: (cbor, additional) => chain.evaluate(cbor, additional), submit: cbor => chain.submit(cbor),
    ...overrides,
  };
}

async function payment(ctx: ChainContext, from = 0, to = 1, invalidHereafter: number | null = 200): Promise<string> {
  const source = (await ctx.provider.getUtxosAt(addresses[from]!))[0]!;
  const builder = (await newTxBuilder({ provider: ctx.provider, network: 'mainnet' }))
    .txIn(source.ref.txId, source.ref.index, [{ unit: 'lovelace', quantity: String(source.value.lovelace) }], source.address, 0)
    .txOut(addresses[to]!, [{ unit: 'lovelace', quantity: String(source.value.lovelace - 1_000_000n) }])
    .invalidBefore(100).setFee('1000000').changeAddress(source.address);
  if (invalidHereafter !== null) builder.invalidHereafter(invalidHereafter);
  return signTx(builder.completeSync(), [keys[from]!]);
}

async function submit(sequencer: Sequencer, from = 0, to = 1, kind: PoolTxKind = 'settle', nullifier?: bigint) {
  return sequencer.run(async () => sequencer.submit(await payment(sequencer.ctx, from, to), { kind, nullifier }));
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('SEQ-01 the overlay shows pending outputs and hides pending spends', async () => {
  const { chain, ctx, input } = setup();
  const sequencer = new Sequencer({ ctx, status: chain });
  const result = await submit(sequencer);
  assert.equal(result.status, 'accepted');
  assert.equal(sequencer.ctx.deployment, deployment);
  const outputs = await sequencer.ctx.provider.getUtxosAt(addresses[1]!);
  assert.equal(outputs.length, 1);
  assert.deepEqual(outputs[0]!.ref, { txId: result.txId, index: 0 });
  assert.equal(outputs[0]!.value.lovelace, 19_000_000n);
  assert.deepEqual(await sequencer.ctx.provider.getUtxosAt(addresses[0]!), []);
  assert.deepEqual(await chain.getUtxosAt(addresses[1]!), []);
  assert.deepEqual(await sequencer.ctx.provider.getUtxos([input.ref, outputs[0]!.ref]), [input]);
  assert.deepEqual(sequencer.pending()[0]!.spent, [input.ref]);
  assert.equal(sequencer.pending()[0]!.invalidHereafter, 200);
});

test('SEQ-02 a child chains and both land in one block', async () => {
  const { chain, ctx } = setup();
  const sequencer = new Sequencer({ ctx, status: chain, maxPending: 2 });
  const parent = await submit(sequencer, 0, 1, 'settle', 11n);
  const child = await submit(sequencer, 1, 2, 'settle', 22n);
  assert.equal(parent.status, 'accepted');
  assert.equal(child.status, 'accepted');
  assert.deepEqual(sequencer.pendingNullifiers(), [11n, 22n]);
  assert.deepEqual(await sequencer.ctx.provider.getUtxosAt(addresses[1]!), []);
  assert.equal(await sequencer.transactionStatus(child.txId), 'mempool');
  assert.deepEqual(chain.mineBlock().txIds, [parent.txId, child.txId]);
  assert.equal(await sequencer.reconcile(), null);
  assert.deepEqual(sequencer.pending(), []);
  assert.deepEqual(sequencer.pendingNullifiers(), []);
});

test('SEQ-02 gates follow maxPending and kinds', async () => {
  const { chain, ctx } = setup();
  const sequencer = new Sequencer({ ctx, status: chain });
  assert.equal(sequencer.maxPending, 1);
  assert.deepEqual(['settle', 'insert', 'asp'].map(kind => sequencer.canSubmit(kind as PoolTxKind)), [true, true, true]);
  await submit(sequencer);
  assert.deepEqual(['settle', 'insert', 'asp'].map(kind => sequencer.canSubmit(kind as PoolTxKind)), [false, false, false]);
  const other = setup();
  const asp = new Sequencer({ ctx: other.ctx, status: other.chain });
  await submit(asp, 0, 1, 'asp', 99n);
  assert.deepEqual(['settle', 'insert', 'asp'].map(kind => asp.canSubmit(kind as PoolTxKind)), [false, true, false]);
  assert.deepEqual(asp.pendingNullifiers(), []);
});

test('SEQ-02 an insert blocks another insert but permits a settle and an asp', async () => {
  const { chain, ctx } = setup();
  const sequencer = new Sequencer({ ctx, status: chain, maxPending: 2 });
  await submit(sequencer, 0, 1, 'insert');
  assert.deepEqual(['settle', 'insert', 'asp'].map(kind => sequencer.canSubmit(kind as PoolTxKind)), [true, false, true]);
});

test('SEQ-02 maxPending must be an integer from one to eight', () => {
  const { chain, ctx } = setup();
  for (const maxPending of [0, 9, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => new Sequencer({ ctx, status: chain, maxPending }), RangeError);
  }
  assert.equal(new Sequencer({ ctx, status: chain, maxPending: 8 }).maxPending, 8);
});

test('SEQ-03 a dropped parent resets the chain', async () => {
  const { chain, ctx } = setup();
  const sequencer = new Sequencer({ ctx, status: chain, maxPending: 2 });
  const parent = await submit(sequencer, 0, 1, 'settle', 11n);
  const child = await submit(sequencer, 1, 2, 'settle', 22n);
  const events: ResetEvent[] = [];
  sequencer.onReset(event => { events.push(event); });
  assert.deepEqual(chain.dropTransaction(parent.txId), [parent.txId, child.txId]);
  assert.equal(await sequencer.reconcile(), null);
  const event = await sequencer.reconcile();
  assert.equal(event?.reason, 'dropped');
  assert.deepEqual(event.dropped.map(entry => entry.txId), [parent.txId, child.txId]);
  assert.deepEqual(events, [event]);
  assert.deepEqual(sequencer.pending(), []);
  assert.deepEqual(sequencer.pendingNullifiers(), []);
  assert.equal(await sequencer.reconcile(), null);
  assert.equal(events.length, 1);
});

test('SEQ-03 a foreign spend resets the chain as dropped', async () => {
  const { chain, ctx } = setup();
  const sequencer = new Sequencer({ ctx, status: chain });
  const parent = await submit(sequencer);
  chain.dropTransaction(parent.txId);
  const conflict = await chain.submit(await payment(ctx, 0, 2));
  assert.deepEqual(chain.mineBlock().txIds, [conflict]);
  assert.equal(await sequencer.reconcile(), null);
  assert.equal((await sequencer.reconcile())?.reason, 'dropped');
});

test('SEQ-03 an expired entry resets the chain', async () => {
  const { chain, ctx } = setup();
  const sequencer = new Sequencer({ ctx, status: chain });
  await sequencer.run(async () => sequencer.submit(await payment(ctx, 0, 1, 105), { kind: 'settle' }));
  chain.advanceSlots(6);
  assert.equal((await sequencer.reconcile())?.reason, 'expired');
  assert.deepEqual(sequencer.pending(), []);
});

test('SEQ-03 a transaction without an upper bound does not expire', async () => {
  const { chain, ctx } = setup();
  const sequencer = new Sequencer({ ctx, status: chain });
  await sequencer.run(async () => sequencer.submit(await payment(ctx, 0, 1, null), { kind: 'insert' }));
  chain.advanceSlots(100_000);
  assert.equal(await sequencer.reconcile(), null);
  assert.equal(sequencer.pending().length, 1);
});

test('SEQ-03 reset listeners can run and a throwing listener does not stop the next', { timeout: 2000 }, async () => {
  const { chain, ctx } = setup();
  const logs: string[] = [];
  const sequencer = new Sequencer({ ctx, status: chain, unseenLimit: 1, log: line => { logs.push(line); } });
  const parent = await submit(sequencer);
  const order: string[] = [];
  sequencer.onReset(async () => {
    await sequencer.run(async () => { order.push('first'); });
    throw new Error('listener failure');
  });
  sequencer.onReset(() => { order.push('second'); });
  chain.dropTransaction(parent.txId);
  assert.equal((await sequencer.reconcile())?.reason, 'dropped');
  assert.deepEqual(order, ['first', 'second']);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /listener failure/);
});

test('SEQ-04 one unknown read does not reset', async () => {
  const { chain, ctx } = setup();
  let reads = 0;
  const status: TxStatusReader = { transactionStatus: txId => ++reads === 1 ? Promise.resolve('unknown') : chain.transactionStatus(txId) };
  const sequencer = new Sequencer({ ctx, status });
  await submit(sequencer);
  chain.mineBlock();
  assert.equal(await sequencer.reconcile(), null);
  assert.equal(sequencer.pending()[0]!.unseen, 1);
  assert.equal(await sequencer.reconcile(), null);
  assert.deepEqual(sequencer.pending(), []);
});

test('SEQ-04 a child with BadInputsUTxO is retried', async () => {
  const { chain, ctx } = setup();
  let childCalls = 0;
  const provider = providerWith(chain, { submit: cbor => {
    if (decodeTx(cbor).inputs.some(ref => ref.txId !== '10'.repeat(32)) && ++childCalls <= 2) {
      throw new SubmitRejected('BadInputsUTxO', 'bad_inputs');
    }
    return chain.submit(cbor);
  } });
  const sequencer = new Sequencer({ ctx: { ...ctx, provider }, status: chain, maxPending: 2, childRetryMs: 1 });
  const parent = await submit(sequencer);
  const child = await submit(sequencer, 1, 2);
  assert.equal(child.status, 'accepted');
  assert.equal(childCalls, 3);
  assert.deepEqual(chain.mempoolTxIds(), [parent.txId, child.txId]);
});

test('SEQ-04 an ambiguous submit stays pending and can confirm', async () => {
  const { chain, ctx } = setup();
  const provider = providerWith(chain, { submit: async cbor => {
    await chain.submit(cbor);
    throw new Error('response lost');
  } });
  const sequencer = new Sequencer({ ctx: { ...ctx, provider }, status: chain });
  const result = await submit(sequencer, 0, 1, 'settle', 11n);
  assert.equal(result.status, 'unknown');
  assert.deepEqual(sequencer.pendingNullifiers(), [11n]);
  assert.deepEqual(chain.mineBlock().txIds, [result.txId]);
  assert.equal(await sequencer.reconcile(), null);
  assert.deepEqual(sequencer.pending(), []);
});

test('SEQ-04 an unknown outcome logs the provider diagnostic on one line', async () => {
  const { chain, ctx } = setup();
  const provider = providerWith(chain, { submit: async () => { throw new Error('socket hang up\nafter 30 s'); } });
  const logs: string[] = [];
  const sequencer = new Sequencer({ ctx: { ...ctx, provider }, status: chain, log: line => { logs.push(line); } });
  const result = await submit(sequencer);
  assert.equal(result.status, 'unknown');
  assert.deepEqual(logs, [`Sequencer submit outcome unknown for ${result.txId}: socket hang up after 30 s`]);
});

test('SEQ-04 a rejected nonchild has no entry and does not reset', async () => {
  const { chain, ctx } = setup();
  const signed = await payment(ctx);
  await chain.submit(signed);
  const sequencer = new Sequencer({ ctx, status: chain, childRetryMs: 1, childRetryForMs: 0 });
  const events: ResetEvent[] = [];
  sequencer.onReset(event => { events.push(event); });
  const result = await sequencer.run(() => sequencer.submit(signed, { kind: 'settle' }));
  assert.equal(result.status, 'rejected');
  if (result.status === 'rejected') assert.equal(result.reason, 'bad_inputs');
  assert.deepEqual(sequencer.pending(), []);
  assert.deepEqual(events, []);
});

test('SEQ-04 an exhausted child resets after run releases the lock', { timeout: 2000 }, async () => {
  const { chain, ctx } = setup();
  const sequencer = new Sequencer({ ctx, status: chain, maxPending: 2, childRetryMs: 1, childRetryForMs: 0 });
  const parent = await submit(sequencer, 0, 1, 'settle', 11n);
  const child = await payment(sequencer.ctx, 1, 2);
  chain.dropTransaction(parent.txId);
  const order: string[] = [];
  sequencer.onReset(async event => {
    assert.equal(event.reason, 'rejected_child');
    assert.deepEqual(event.dropped.map(entry => entry.txId), [parent.txId]);
    await sequencer.run(async () => { order.push('listener'); });
  });
  await sequencer.run(async () => {
    const result = await sequencer.submit(child, { kind: 'settle' });
    assert.equal(result.status, 'rejected');
    assert.equal(order.length, 0);
    order.push('run end');
  });
  assert.deepEqual(order, ['run end', 'listener']);
  assert.deepEqual(sequencer.pending(), []);
});

test('SEQ-04 mempool resets unseen and reconciliation stops at the oldest pending entry', async () => {
  const { chain, ctx } = setup();
  const statuses = ['unknown', 'mempool', 'unknown'] as const;
  const reads: string[] = [];
  const status: TxStatusReader = { transactionStatus: async txId => {
    reads.push(txId);
    return statuses[reads.length - 1] ?? 'mempool';
  } };
  const sequencer = new Sequencer({ ctx, status, maxPending: 2 });
  const parent = await submit(sequencer);
  await submit(sequencer, 1, 2);
  for (const unseen of [1, 0, 1]) {
    assert.equal(await sequencer.reconcile(), null);
    assert.equal(sequencer.pending()[0]!.unseen, unseen);
  }
  assert.deepEqual(reads, [parent.txId, parent.txId, parent.txId]);
});

test('SEQ-04 confirmed parents are removed while their child stays pending', async () => {
  const { chain, ctx } = setup();
  const sequencer = new Sequencer({ ctx, status: chain, maxPending: 2 });
  const parent = await submit(sequencer, 0, 1, 'settle', 11n);
  const child = await submit(sequencer, 1, 2, 'settle', 22n);
  assert.deepEqual(chain.mineBlock(20, { limit: 1 }).txIds, [parent.txId]);
  assert.equal(await sequencer.reconcile(), null);
  assert.deepEqual(sequencer.pendingNullifiers(), [22n]);
  assert.deepEqual(sequencer.pending().map(entry => entry.txId), [child.txId]);
  assert.deepEqual(await sequencer.ctx.provider.getUtxosAt(addresses[1]!), []);
});

test('SEQ-05 a throw inside run leaves pending unchanged', async () => {
  const { chain, ctx } = setup();
  const sequencer = new Sequencer({ ctx, status: chain });
  await submit(sequencer);
  const before = structuredClone(sequencer.pending());
  await assert.rejects(sequencer.run(async () => { throw new Error('no fee input'); }), /no fee input/);
  assert.deepEqual(sequencer.pending(), before);
  assert.equal(await sequencer.run(async () => 'released'), 'released');
});

test('SEQ-06 reconcile waits for run', async () => {
  const { chain, ctx } = setup();
  const sequencer = new Sequencer({ ctx, status: chain });
  const entered = deferred();
  const release = deferred();
  const order: string[] = [];
  const running = sequencer.run(async () => {
    entered.resolve();
    await release.promise;
    order.push('run end');
  });
  await entered.promise;
  const reconciling = sequencer.reconcile().then(result => { order.push('reconcile end'); return result; });
  await setImmediate();
  assert.deepEqual(order, []);
  release.resolve();
  assert.equal(await reconciling, null);
  await running;
  assert.deepEqual(order, ['run end', 'reconcile end']);
});

test('SEQ-06 queued runs keep FIFO order after a callback throws', async () => {
  const { chain, ctx } = setup();
  const sequencer = new Sequencer({ ctx, status: chain });
  const entered = deferred();
  const release = deferred();
  const order: number[] = [];
  const first = sequencer.run(async () => { entered.resolve(); await release.promise; throw new Error('build failed'); });
  const rejected = assert.rejects(first, /build failed/);
  await entered.promise;
  const second = sequencer.run(async () => { order.push(2); });
  const third = sequencer.run(async () => { order.push(3); });
  release.resolve();
  await Promise.all([rejected, second, third]);
  assert.deepEqual(order, [2, 3]);
});

test('SEQ-07 a held sequencer admits no new settle until the ASP update is submitted', async () => {
  const { chain, ctx } = setup();
  const sequencer = new Sequencer({ ctx, status: chain, maxPending: 2 });
  await submit(sequencer, 0, 1, 'settle', 11n);
  // maxPending 2 leaves room for another Settle.
  assert.equal(sequencer.canSubmit('settle'), true);
  sequencer.holdForAsp();
  assert.equal(sequencer.canSubmit('settle'), false);
  // A hold only stops Settles.
  assert.equal(sequencer.canSubmit('insert'), true);
  // The held Settle confirms, so the ASP update is now free to go.
  chain.mineBlock();
  assert.equal(await sequencer.reconcile(), null);
  assert.equal(sequencer.canSubmit('asp'), true);
  const update = await submit(sequencer, 1, 2, 'asp');
  assert.equal(update.status, 'accepted');
  // The ASP entry itself blocks Settles until it confirms.
  assert.equal(sequencer.canSubmit('settle'), false);
  chain.mineBlock();
  assert.equal(await sequencer.reconcile(), null);
  assert.equal(sequencer.canSubmit('settle'), true);
});

test('SEQ-07 a hold expires after aspHoldMs', () => {
  const { chain, ctx } = setup();
  let now = 1_000;
  const sequencer = new Sequencer({ ctx, status: chain, aspHoldMs: 5_000, now: () => now });
  sequencer.holdForAsp();
  assert.equal(sequencer.canSubmit('settle'), false);
  now += 4_999;
  assert.equal(sequencer.canSubmit('settle'), false);
  now += 1;
  assert.equal(sequencer.canSubmit('settle'), true);
});

test('SEQ-07 aspHoldMs must be a positive safe integer, and defaults to 120000', () => {
  const { chain, ctx } = setup();
  for (const aspHoldMs of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new Sequencer({ ctx, status: chain, aspHoldMs }), RangeError);
  }
  let now = 0;
  const sequencer = new Sequencer({ ctx, status: chain, now: () => now });
  sequencer.holdForAsp();
  now = 119_999;
  assert.equal(sequencer.canSubmit('settle'), false);
  now = 120_000;
  assert.equal(sequencer.canSubmit('settle'), true);
});
