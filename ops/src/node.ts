import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { ApiError, relayerRoutes, serveJson } from '@zx402/api';
import { AspService } from '@zx402/asp';
import { Crank } from '@zx402/crank';
import { vkToCardano, type SnarkjsVk } from '@zx402/crypto';
import { Indexer, serveIndexer } from '@zx402/indexer';
import {
  loadArtifacts, loadDevArtifacts, loadDevVkey, shutdown,
  type CircuitArtifacts, type CircuitManifest, type CircuitName,
} from '@zx402/prover';
import { Relayer } from '@zx402/relayer';
import {
  blockfrostProvider, Sequencer, vkToHex,
  type ChainContext, type ChainHistory, type Deployment, type TxStatusReader,
} from '@zx402/txlib';
import { readSettings } from './env.js';
import { roleSeed } from './roles.js';

export interface NodeOptions {
  ctx: ChainContext;
  /** The provider or FakeChain must answer transaction status for the sequencer. */
  history: ChainHistory & TxStatusReader;
  seeds: { crank: Uint8Array; relayer: Uint8Array; asp: Uint8Array };
  insertArtifacts: CircuitArtifacts;
  spendVkey: SnarkjsVk;
  ports?: { indexer?: number; relayer?: number };
  intervalMs?: number;
  idleRetryMs?: number;
  /** Pool transactions the node may chain. Defaults to 1. */
  maxPending?: number;
  now?: () => number;
  aspStorePath?: string;
  log?: (line: string) => void;
}
export interface Zx402Node {
  indexer: Indexer; crank: Crank; asp: AspService; relayer: Relayer; sequencer: Sequencer;
  urls: { indexer: string; relayer: string };
  /** Sync, run pending work, and sync after changes. Concurrent callers share one round. */
  tick(): Promise<void>;
  close(): Promise<void>;
}

/** Keep each error on one line and redact credentials even in a nested provider message. */
export function redactedLog(log: (line: string) => void, secrets: string[]): (line: string) => void {
  return line => {
    for (const secret of secrets.filter(Boolean)) {
      for (const value of [secret, secret.toLowerCase(), secret.toUpperCase()]) line = line.split(value).join('[redacted]');
    }
    log(line.replace(/[\r\n]+/g, ' '));
  };
}
const message = (error: unknown): string => error instanceof Error ? error.message : 'Unknown failure';

export async function startNode(o: NodeOptions): Promise<Zx402Node> {
  const intervalMs = o.intervalMs ?? 10_000;
  const idleRetryMs = o.idleRetryMs ?? 20_000;
  const now = o.now ?? Date.now;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 0 || intervalMs > 2_147_483_647) {
    throw new RangeError('intervalMs must be a nonnegative timer interval');
  }
  const log = redactedLog(o.log ?? (() => {}), Object.values(o.seeds).map(seed => Buffer.from(seed).toString('hex')));
  if (o.aspStorePath) await mkdir(dirname(o.aspStorePath), { recursive: true });
  // One sequencer owns the pool output for every service in this process.
  const sequencer = new Sequencer({ ctx: o.ctx, status: o.history, maxPending: o.maxPending ?? 1,
    log: line => log(`sequencer: ${line}`) });
  let asp: AspService;
  const indexer = new Indexer({ ctx: o.ctx, history: o.history, aspLeaves: root => asp.leaves(root) });
  asp = new AspService({ ctx: o.ctx, sequencer, indexer, payerSeed: o.seeds.asp, operatorSeeds: [o.seeds.asp], storePath: o.aspStorePath });
  const crank = new Crank({ ctx: o.ctx, sequencer, indexer, seed: o.seeds.crank, artifacts: o.insertArtifacts });
  const relayer = new Relayer({ ctx: o.ctx, sequencer, indexer, seed: o.seeds.relayer, vkey: o.spendVkey,
    log: (line, error) => log(`relayer: ${line}${error === undefined ? '' : `: ${message(error)}`}`) });
  const indexerServer = await serveIndexer(indexer, { port: o.ports?.indexer ?? 4010, syncMs: 0,
    onError: error => log(`indexer: ${message(error)}`) });
  let closed = false;
  const requests = new Set<Promise<unknown>>();
  let relayerServer;
  try {
    relayerServer = await serveJson(relayerRoutes(relayer).map(route => ({ ...route, handle: request => {
      if (closed) throw new ApiError('internal', 'Node is stopping', 503);
      // An accepted settlement must finish before the CLI terminates the prover workers.
      const pending = Promise.resolve().then(() => route.handle(request)).then(result => {
        const status = (result as { status?: string }).status;
        if (route.method === 'POST' && route.path === '/v1/settle' && (status === 'submitted' || status === 'confirmed')) {
          indexer.expectChange();
        }
        return result;
      }).finally(() => { requests.delete(pending); });
      requests.add(pending);
      return pending;
    } })), o.ports?.relayer ?? 4011);
  }
  catch (error) { await indexerServer.close(); throw error; }
  let running: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const idle = new Map<string, { fingerprint: string; at: number }>();

  async function step(name: 'crank' | 'asp', snapshot: unknown[], run: () => Promise<boolean>): Promise<void> {
    const fingerprint = createHash('sha256').update(JSON.stringify(snapshot,
      (_key, value) => typeof value === 'bigint' ? value.toString() : value)).digest('hex');
    const previous = idle.get(name);
    if (previous?.fingerprint === fingerprint && now() - previous.at < idleRetryMs) return;
    // Only a completed no-op delays retries. Failures and progress clear the old delay.
    idle.delete(name);
    if (!await run()) idle.set(name, { fingerprint, at: now() });
  }

  function tick(): Promise<void> {
    if (closed) return Promise.resolve();
    if (running) return running;
    running = (async () => {
      const events: string[] = [];
      async function sync() {
        try {
          const count = await indexer.sync();
          if (count > 0) events.push(`indexed ${count}`);
        } catch (error) { log(`indexer: ${message(error)}`); }
      }
      await sync();
      if (indexer.syncedAt === undefined) return;
      // A reset empties the pending list, so the next build starts from the new confirmed head.
      try {
        const reset = await sequencer.reconcile();
        if (reset !== null) events.push(`sequencer: reset (${reset.reason}, ${reset.dropped.length} dropped)`);
      } catch (error) { log(`sequencer: ${message(error)}`); }
      try {
        const pool = await indexer.getPool();
        const pending = (await indexer.getDeposits()).filter(d => d.status === 'pending');
        if (pool.queue.length > 0 || pending.length > 0) {
          await step('crank', [pool.roots, pool.queue, pool.config, pending], async () => {
            const result = await crank.tick();
            if (result) {
              indexer.expectChange();
              events.push(`insert ${result.txId} (${result.deposits} deposits, ${result.notes} notes)`);
              await sync();
            }
            return result !== null;
          });
        }
      } catch (error) { log(`crank: ${message(error)}`); }
      try {
        const approved = asp.leaves();
        const pool = await indexer.getPool();
        const deposits = await indexer.getDeposits();
        if (deposits.some(d => d.status === 'absorbed' && d.label !== null && !approved.includes(d.label))
          || !isDeepStrictEqual(asp.leaves(pool.aspRoot), approved)) {
          await step('asp', [pool.aspRoot, deposits.filter(d => d.status === 'absorbed').map(d => d.label), approved], async () => {
            const result = await asp.tick();
            if (result.txId) {
              indexer.expectChange();
              events.push(`asp ${result.txId} (${result.approved} approvals)`);
            }
            if (result.txId || result.approved > 0) await sync();
            return result.txId !== null || result.approved > 0;
          });
        }
      } catch (error) { log(`asp: ${message(error)}`); }
      if (events.length > 0) log(`round: ${events.join('; ')}`);
    })().finally(() => { running = undefined; });
    return running;
  }
  function schedule() {
    timer = setTimeout(() => { void tick().finally(() => { if (!closed) schedule(); }); }, intervalMs);
    timer.unref();
  }
  // The initial round warms the HTTP snapshot, including a slow cold replay.
  await tick();
  if (intervalMs > 0) schedule();
  return { indexer, crank, asp, relayer, sequencer, urls: { indexer: indexerServer.url, relayer: relayerServer.url }, tick,
    close() {
      closing ??= (async () => {
        closed = true;
        clearTimeout(timer);
        await running;
        await Promise.allSettled([...requests]);
        await Promise.all([indexerServer.close(), relayerServer.close()]);
      })();
      return closing;
    },
  };
}

/** Select the setup by its verification keys, never by which local key directory exists. */
export async function deploymentArtifacts(deployment: Deployment, root = fileURLToPath(new URL('../../', import.meta.url))): Promise<{
  spendVkey: SnarkjsVk; load(circuit: CircuitName): Promise<CircuitArtifacts>;
}> {
  const names = ['spend', 'insert', 'ragequit'] as const;
  const dev = await Promise.all(names.map(name => loadDevVkey(name, root)));
  const matches = (keys: SnarkjsVk[]) => names.every((name, i) =>
    isDeepStrictEqual(vkToHex(vkToCardano(keys[i]!)), deployment.vkeys[name]));
  if (matches(dev)) return { spendVkey: dev[0]!, load: circuit => loadDevArtifacts(circuit, root) };
  const published = join(root, `deployments/${deployment.network}/keys`);
  const manifest = JSON.parse(await readFile(join(published, 'manifest.json'), 'utf8')) as { circuits: CircuitManifest };
  const keys = await Promise.all(names.map(async name => {
    const bytes = await readFile(join(published, `${name}_vkey.json`));
    if (createHash('sha256').update(bytes).digest('hex') !== manifest.circuits[name]?.vkey_sha256) {
      throw new Error(`Verification key hash mismatch for ${name}`);
    }
    return JSON.parse(bytes.toString('utf8')) as SnarkjsVk;
  }));
  if (!matches(keys)) throw new Error('Verification keys do not match the deployment record');
  return { spendVkey: keys[0]!, load: circuit => loadArtifacts({ circuit, manifest: manifest.circuits,
    wasmPath: join(root, `circuits/build/${circuit}_js/${circuit}.wasm`),
    zkeyPath: join(root, `circuits/build/keys-${deployment.network}/${circuit}.zkey`),
    vkeyPath: join(published, `${circuit}_vkey.json`),
  }) };
}

async function main(): Promise<void> {
  const integer = (name: string, fallback: number): number => {
    const value = process.env[name];
    if (value === undefined) return fallback;
    if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value))) {
      throw new Error(`${name} must be a nonnegative safe integer`);
    }
    return Number(value);
  };
  const bounded = (name: string, fallback: number, min: number, max: number): number => {
    const value = process.env[name];
    if (value === undefined) return fallback;
    if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) {
      throw new Error(`${name} must be an integer from ${min} to ${max}`);
    }
    return Number(value);
  };
  const intervalMs = integer('ZX402_INTERVAL_MS', 10_000);
  const idleRetryMs = integer('ZX402_IDLE_RETRY_MS', 20_000);
  // Chaining stays off until the Preprod measurement sets a higher default.
  const maxPending = bounded('ZX402_MAX_PENDING', 1, 1, 8);
  const ports = { indexer: integer('ZX402_INDEXER_PORT', 4010), relayer: integer('ZX402_RELAYER_PORT', 4011) };
  const settings = readSettings();
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const deployment = JSON.parse(await readFile(join(root, `deployments/${settings.network}.json`), 'utf8')) as Deployment;
  if (deployment.network !== settings.network) throw new Error('Deployment network does not match NETWORK');
  const provider = blockfrostProvider(settings.blockfrostProjectId, settings.network);
  const keys = await deploymentArtifacts(deployment, root);
  const seeds = { crank: roleSeed(settings.operatorSeed, 'crank'), relayer: roleSeed(settings.operatorSeed, 'relayer'),
    asp: roleSeed(settings.operatorSeed, 'asp') };
  const log = redactedLog(console.log, [settings.blockfrostProjectId, Buffer.from(settings.operatorSeed).toString('hex'),
    ...Object.values(seeds).map(seed => Buffer.from(seed).toString('hex'))]);
  if (settings.network === 'mainnet') log('CAUTION: the node spends real ADA. Submitted transactions cannot be undone.');
  const node = await startNode({ ctx: { provider, deployment }, history: provider, seeds, intervalMs, idleRetryMs, maxPending, ports,
    insertArtifacts: await keys.load('insert'), spendVkey: keys.spendVkey,
    // One approval store per pool, so a new pool never reads the labels of an old one.
    aspStorePath: join(root, `deployments/${settings.network}/asp-store-${deployment.poolId.slice(0, 8)}.json`), log });
  log(`Indexer ${node.urls.indexer}; relayer ${node.urls.relayer}`);
  const stop = () => {
    void node.close().then(shutdown).catch(error => { log(message(error)); process.exitCode = 1; }).finally(() => {
      settings.operatorSeed.fill(0);
      Object.values(seeds).forEach(seed => seed.fill(0));
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); }
  catch (error) {
    redactedLog(console.error, [process.env.OPERATOR_SEED_HEX ?? '', process.env.BLOCKFROST_PROJECT_ID ?? ''])(message(error));
    await shutdown();
    process.exitCode = 1;
  }
}
