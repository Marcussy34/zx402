import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { devKeysPresent, loadDevArtifacts, loadDevVkey, shutdown } from '@zx402/prover';
import { timeToSlot } from '@zx402/txlib';
import { startDevnet } from '@zx402/txlib/testing/devnet';
import { relayerTopUp, runBurst } from '../src/burst.js';
import { startNode } from '../src/node.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
after(shutdown);

test('OPS-07 burst reports blocks and time', {
  timeout: 900_000,
  skip: devKeysPresent(root) ? false : 'Development proving keys are absent: circuits/build/dev/manifest.json is required',
}, async t => {
  const { chain, ctx, keys } = await startDevnet();
  const network = ctx.deployment.network;
  chain.advanceSlots(timeToSlot(Date.now(), network));
  // Keep the chain at wall time, because the relayer quotes real deadlines.
  const mine = async () => chain.mineBlock(Math.max(0, timeToSlot(Date.now(), network) - (await chain.getTip()).slot));
  const node = await startNode({ ctx, history: chain, seeds: { crank: keys.crank, relayer: keys.relayer, asp: keys.asp },
    maxPending: 2, intervalMs: 0, ports: { indexer: 0, relayer: 0 },
    insertArtifacts: await loadDevArtifacts('insert', root), spendVkey: await loadDevVkey('spend', root) });
  t.after(() => node.close());
  const storeDir = await mkdtemp(join(tmpdir(), 'zx402-burst-'));
  t.after(() => rm(storeDir, { recursive: true, force: true }));
  const logs: string[] = [];
  const report = await runBurst({ ctx, history: chain, indexerUrl: node.urls.indexer, relayerUrl: node.urls.relayer,
    seeds: { operator: keys.operator, relayer: keys.relayer, user: keys.users[0]!, agent: keys.users[1]! },
    artifacts: { spend: await loadDevArtifacts('spend', root), ragequit: await loadDevArtifacts('ragequit', root) },
    storeDir, count: 2, now: Date.now,
    poll: { intervalMs: 0, timeoutMs: 900_000, onPoll: async () => { await mine(); await node.tick(); } },
    log: line => { logs.push(line); t.diagnostic(line); } });
  assert.equal(report.count, 2);
  assert.equal(report.rows.length, 2);
  assert.equal(report.confirmed, 2);
  for (const row of report.rows) {
    assert.equal(row.status, 'confirmed');
    assert.match(row.txHash ?? '', /^[0-9a-f]{64}$/);
    assert.equal(typeof row.blockHeight, 'number');
    assert.ok((row.blockHeight ?? 0) > 0);
    assert.equal(typeof row.seconds, 'number');
    assert.ok((row.seconds ?? -1) >= 0);
  }
  assert.equal(report.rows[0]!.blockHeight, report.rows[1]!.blockHeight, 'Both Settles must land in one block');
  assert.equal(report.blocks, 1);
  assert.equal(typeof report.lastSeconds, 'number');
  assert.ok(logs.some(line => /^Burst of 2: 2 confirmed in 1 distinct blocks, last confirmation after [0-9.]+ seconds$/.test(line)));
});

// A token pool leaves the relayer's change holding its fee tokens, so the wallet must keep one ADA-only output for collateral.
// Token outputs hold mostly their minimum ADA, so only ADA-only outputs other than the collateral count as the float.
test('OPS-07 the relayer top-up keeps an ADA-only collateral output and an ADA-only float', () => {
  const ADA = 1_000_000n;
  const utxo = (lovelace: bigint, tokens = 0n) => ({ ref: { txId: '00'.repeat(32), index: 0 }, address: 'addr_test1', inlineDatum: null,
    datumHash: null, scriptRef: null, value: { lovelace, assets: tokens > 0n ? { ['ab'.repeat(28) + 'cd']: tokens } : {} } });
  // Only token-bearing outputs: a collateral output and the whole float.
  assert.deepEqual(relayerTopUp([utxo(17n * ADA, 1n), utxo(5n * ADA, 1n)], 30n * ADA), [5n * ADA, 30n * ADA]);
  assert.deepEqual(relayerTopUp([], 30n * ADA), [5n * ADA, 30n * ADA]);
  // An ADA-only output of at least 5 ADA serves as collateral, and does not count as float.
  assert.deepEqual(relayerTopUp([utxo(6n * ADA), utxo(30n * ADA, 1n)], 30n * ADA), [30n * ADA]);
  // The smallest qualifying output is the collateral, as complete() picks it; the larger ones are float.
  assert.deepEqual(relayerTopUp([utxo(5n * ADA), utxo(12n * ADA)], 30n * ADA), [18n * ADA]);
  assert.deepEqual(relayerTopUp([utxo(5n * ADA), utxo(40n * ADA)], 30n * ADA), []);
});
