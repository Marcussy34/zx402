import { hkdfSync } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { IndexerClient, RelayerClient, type SettleStatus } from '@zx402/api';
import { createZx402, fileStore, type Zx402 } from '@zx402/core';
import { shutdown, type CircuitArtifacts } from '@zx402/prover';
import {
  blockfrostProvider, complete, decodeTx, enterpriseAddress, newTxBuilder, signTx,
  type ChainContext, type ChainHistory, type Deployment,
} from '@zx402/txlib';
import { readSettings } from './env.js';
import { deploymentArtifacts, redactedLog } from './node.js';
import { roleSeed } from './roles.js';

const PAYOUT = 1_000_000n;
const DEFAULT_DEPOSIT = 6_000_000n;

export interface BurstSeeds { operator: Uint8Array; relayer: Uint8Array; user: Uint8Array; agent: Uint8Array }
export interface BurstOptions {
  ctx: ChainContext;
  history: ChainHistory;
  indexerUrl: string;
  relayerUrl: string;
  seeds: BurstSeeds;
  artifacts: { spend: CircuitArtifacts; ragequit: CircuitArtifacts };
  storeDir: string;
  count: number;
  depositAmount?: bigint;
  now?: () => number;
  poll?: { intervalMs?: number; timeoutMs?: number; onPoll?: () => void | Promise<void> };
  log?: (line: string) => void;
}
export interface BurstRow {
  index: number;
  settleId: string | null;
  txHash: string | null;
  status: 'submitted' | 'confirmed' | 'failed' | 'start_failed';
  blockHeight: number | null;
  seconds: number | null;
  error: string | null;
}
export interface BurstReport {
  network: string;
  poolId: string;
  count: number;
  payout: string;
  rows: BurstRow[];
  confirmed: number;
  blocks: number;
  lastSeconds: number | null;
  summary: string;
}

export async function runBurst(o: BurstOptions): Promise<BurstReport> {
  if (!Number.isSafeInteger(o.count) || o.count <= 0) throw new RangeError('count must be a positive safe integer');
  const depositAmount = o.depositAmount ?? DEFAULT_DEPOSIT;
  if (typeof depositAmount !== 'bigint' || depositAmount <= 0n) throw new RangeError('depositAmount must be a positive bigint');
  for (const [name, seed] of Object.entries(o.seeds)) {
    if (!(seed instanceof Uint8Array) || seed.length !== 32) throw new Error(`${name} seed must be exactly 32 bytes`);
  }
  const now = o.now ?? Date.now;
  const intervalMs = o.poll?.intervalMs ?? 3_000;
  const timeoutMs = o.poll?.timeoutMs ?? 900_000;
  const log = o.log ?? (() => {});
  await mkdir(o.storeDir, { recursive: true });
  const { network, poolId } = o.ctx.deployment;
  const elapsed = (since: number) => (now() - since) / 1_000;
  const relayer = new RelayerClient(o.relayerUrl);

  // Top up the relayer once, before any payment, so it can pay fees for every settle plus a margin.
  const relayerAddress = enterpriseAddress(o.seeds.relayer, network);
  const threshold = (BigInt(o.count) * 3n + 10n) * 1_000_000n;
  const funded = (await o.ctx.provider.getUtxosAt(relayerAddress)).reduce((sum, utxo) => sum + utxo.value.lovelace, 0n);
  if (funded >= threshold) log(`Relayer holds ${funded} lovelace; no top-up is needed`);
  else {
    const start = now();
    const difference = threshold - funded;
    const built = await complete({ provider: o.ctx.provider, network },
      (await newTxBuilder({ provider: o.ctx.provider, network }))
        .txOut(relayerAddress, [{ unit: 'lovelace', quantity: String(difference) }]),
      { payer: { address: enterpriseAddress(o.seeds.operator, network) } });
    const txId = await o.ctx.provider.submit(signTx(built.cbor, [o.seeds.operator]));
    log(`Relayer top-up ${txId} submitted in ${elapsed(start).toFixed(3)} seconds`);
    const index = decodeTx(built.cbor).outputs.findIndex(output =>
      output.address === relayerAddress && output.value.lovelace === difference);
    if (index < 0) throw new Error('Top-up transaction has no relayer output');
    const deadline = now() + timeoutMs;
    for (;;) {
      await o.poll?.onPoll?.();
      if ((await o.ctx.provider.getUtxos([{ txId, index }])).length > 0) break;
      if (now() >= deadline) throw new Error(`Timed out waiting for relayer top-up ${txId}`);
      await delay(Math.min(intervalMs, Math.max(0, deadline - now())));
    }
    log(`Relayer top-up ${txId} confirmed in ${elapsed(start).toFixed(3)} seconds`);
  }

  // One SDK wallet per payment, derived from the agent seed so runs are repeatable.
  const sdks: Zx402[] = [];
  for (let index = 0; index < o.count; index++) {
    const seed = new Uint8Array(hkdfSync('sha256', o.seeds.agent, new Uint8Array(), `zx402/burst/${index}/v1`, 32));
    try {
      sdks.push(createZx402({ seed, ctx: o.ctx, indexer: new IndexerClient(o.indexerUrl),
        relayer: new RelayerClient(o.relayerUrl), artifacts: o.artifacts,
        store: fileStore(join(o.storeDir, `burst-store-${poolId.slice(0, 8)}-${index}.json`)), poll: o.poll }));
    } finally { seed.fill(0); }
  }

  // Deposits are sequential: every one pays from the same wallet, so concurrent builds would pick the same UTXO.
  const userAddress = enterpriseAddress(o.seeds.user, network);
  for (const [index, sdk] of sdks.entries()) {
    await sdk.sync();
    const quote = await relayer.quote([{ address: userAddress, amount: PAYOUT, datumHash: null }]);
    let note = sdk.listNotes().filter(record => record.status === 'spendable' && !record.pending
      && record.value !== null && record.value >= quote.withdrawn)
      .sort((a, b) => a.value! < b.value! ? -1 : a.value! > b.value! ? 1 : 0)[0];
    if (note) log(`Wallet ${index} reuses note ${note.id}`);
    else {
      if (depositAmount < quote.withdrawn) {
        throw new Error(`Wallet ${index} deposit of ${depositAmount} cannot cover the quote of ${quote.withdrawn}`);
      }
      const start = now();
      const deposit = await sdk.deposit({ amount: depositAmount, walletSeed: o.seeds.user });
      log(`Wallet ${index} deposit ${deposit.txId} submitted in ${elapsed(start).toFixed(3)} seconds`);
      note = await sdk.waitForNote(deposit.prepared.noteId);
      if (note.value === null || note.value < quote.withdrawn) {
        throw new Error(`Wallet ${index} note ${note.id} does not cover the quote of ${quote.withdrawn}`);
      }
      log(`Wallet ${index} note ${note.id} spendable with ${note.value} in ${elapsed(start).toFixed(3)} seconds`);
    }
  }
  log(`All ${o.count} wallets are spendable`);

  // Start every payment at the same moment. One shared clock measures the last confirmation.
  const paymentStart = now();
  const results = await Promise.allSettled(sdks.map(sdk => sdk.settlePrivately({
    payouts: [{ address: userAddress, amount: PAYOUT, datumHash: null }] })));
  const rows = results.map((result, index): BurstRow => {
    if (result.status === 'fulfilled') {
      const receipt = result.value;
      log(`Wallet ${index} settle ${receipt.id} submitted as ${receipt.txHash} in ${elapsed(paymentStart).toFixed(3)} seconds`);
      return { index, settleId: receipt.id, txHash: receipt.txHash, status: 'submitted', blockHeight: null, seconds: null, error: null };
    }
    const error = result.reason instanceof Error ? result.reason.message : String(result.reason);
    log(`Wallet ${index} settle failed to start: ${error}`);
    return { index, settleId: null, txHash: null, status: 'start_failed', blockHeight: null, seconds: null, error };
  });

  const pending = () => rows.some(row => row.status === 'submitted');
  const deadline = paymentStart + timeoutMs;
  while (pending() && now() < deadline) {
    await o.poll?.onPoll?.();
    for (const row of rows) {
      if (row.status !== 'submitted' || row.settleId === null) continue;
      let status: SettleStatus;
      try { status = await relayer.getSettle(row.settleId); }
      catch (error) {
        // A failed read says nothing about the payment, so keep polling.
        row.error = error instanceof Error ? error.message : String(error);
        continue;
      }
      if (status.status === 'confirmed') {
        const seconds = elapsed(paymentStart);
        row.status = 'confirmed';
        row.txHash = status.txHash;
        row.seconds = seconds;
        row.error = null;
        log(`Settle ${row.settleId} confirmed in ${seconds.toFixed(3)} seconds`);
      } else if (status.status === 'failed') {
        row.status = 'failed';
        row.error = status.error;
        log(`Settle ${row.settleId} failed: ${status.error ?? 'unknown error'}`);
      } else row.error = null;
    }
    if (pending()) await delay(Math.min(intervalMs, Math.max(0, deadline - now())));
  }

  // Blockfrost can lag a new block, so retry the history read for up to a minute.
  const confirmedRows = rows.filter(row => row.status === 'confirmed');
  if (confirmedRows.length > 0) {
    const heightsDeadline = now() + 60_000;
    let heights = new Map<string, number>();
    for (;;) {
      const records = await o.history.getTransactionsAt(o.ctx.deployment.scripts.pool.address);
      heights = new Map(records.map(record => [record.txId, record.blockHeight]));
      const hashes = confirmedRows.flatMap(row => row.txHash === null ? [] : [row.txHash]);
      if (hashes.every(hash => heights.has(hash))) break;
      if (now() >= heightsDeadline) break;
      await o.poll?.onPoll?.();
      await delay(Math.min(intervalMs, Math.max(0, heightsDeadline - now())));
    }
    for (const row of confirmedRows) row.blockHeight = row.txHash === null ? null : heights.get(row.txHash) ?? null;
  }

  log(`${'index'.padEnd(5)}  ${'settle'.padEnd(66)}  ${'status'.padEnd(11)}  ${'block'.padEnd(5)}  seconds`);
  for (const row of rows) {
    log(`${String(row.index).padEnd(5)}  ${(row.txHash ?? '-').padEnd(66)}  ${row.status.padEnd(11)}  `
      + `${(row.blockHeight === null ? '-' : String(row.blockHeight)).padEnd(5)}  ${row.seconds === null ? '-' : row.seconds.toFixed(3)}`);
  }
  const blocks = new Set(confirmedRows.flatMap(row => row.blockHeight === null ? [] : [row.blockHeight])).size;
  const lastSeconds = confirmedRows.reduce<number | null>((max, row) => row.seconds === null ? max
    : max === null ? row.seconds : Math.max(max, row.seconds), null);
  const summary = confirmedRows.length === 0
    ? `Burst of ${o.count}: no confirmed payments`
    : `Burst of ${o.count}: ${confirmedRows.length} confirmed in ${blocks} distinct blocks, last confirmation after ${(lastSeconds ?? 0).toFixed(3)} seconds`;
  log(summary);
  return { network, poolId, count: o.count, payout: PAYOUT.toString(), rows, confirmed: confirmedRows.length, blocks, lastSeconds, summary };
}

async function main(): Promise<void> {
  const { values: flags } = parseArgs({ options: {
    count: { type: 'string' },
    deposit: { type: 'string' },
    'relayer-url': { type: 'string' },
    'indexer-url': { type: 'string' },
    json: { type: 'string' },
  } });
  const positive = (name: string, value: string | undefined): number | undefined => {
    if (value === undefined) return undefined;
    if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
      throw new Error(`--${name} must be a positive safe integer`);
    }
    return Number(value);
  };
  const positiveBigInt = (name: string, value: string | undefined): bigint | undefined => {
    if (value === undefined) return undefined;
    if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`--${name} must be a positive integer`);
    return BigInt(value);
  };
  const count = positive('count', flags.count);
  if (count === undefined) throw new Error('--count is required');
  const depositAmount = positiveBigInt('deposit', flags.deposit) ?? DEFAULT_DEPOSIT;
  const relayerUrl = flags['relayer-url'] ?? process.env.RELAYER_URL ?? 'http://127.0.0.1:4011';
  const indexerUrl = flags['indexer-url'] ?? process.env.INDEXER_URL ?? 'http://127.0.0.1:4010';
  const settings = readSettings();
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const deployment = JSON.parse(await readFile(join(root, `deployments/${settings.network}.json`), 'utf8')) as Deployment;
  if (deployment.network !== settings.network) throw new Error('Deployment network does not match NETWORK');
  const provider = blockfrostProvider(settings.blockfrostProjectId, settings.network);
  const keys = await deploymentArtifacts(deployment, root);
  const seeds = { operator: settings.operatorSeed, relayer: roleSeed(settings.operatorSeed, 'relayer'),
    user: roleSeed(settings.operatorSeed, 'user'), agent: roleSeed(settings.operatorSeed, 'agent') };
  const log = redactedLog(console.log, [settings.blockfrostProjectId,
    ...Object.values(seeds).map(seed => Buffer.from(seed).toString('hex'))]);
  if (settings.network === 'mainnet') log('CAUTION: this burst spends real funds. Submitted transactions cannot be undone.');
  try {
    const report = await runBurst({ ctx: { provider, deployment }, history: provider, indexerUrl, relayerUrl, seeds,
      artifacts: { spend: await keys.load('spend'), ragequit: await keys.load('ragequit') },
      storeDir: join(root, `deployments/${settings.network}`), count, depositAmount, log });
    if (flags.json !== undefined) await writeFile(flags.json, JSON.stringify(report, null, 2) + '\n');
  } finally {
    for (const seed of Object.values(seeds)) seed.fill(0);
    await shutdown();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); }
  catch (error) {
    redactedLog(console.error, [process.env.OPERATOR_SEED_HEX ?? '', process.env.BLOCKFROST_PROJECT_ID ?? ''])(
      error instanceof Error ? error.message : 'Burst failed');
    process.exitCode = 1;
  }
}
