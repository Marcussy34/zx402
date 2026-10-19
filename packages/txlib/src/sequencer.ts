import { setTimeout } from 'node:timers/promises';
import type { ChainContext } from './context.js';
import { decodeTx, outputsOf } from './txview.js';
import { SubmitRejected, type Provider, type TxStatus, type TxStatusReader, type Utxo, type UtxoRef } from './types.js';

export type PoolTxKind = 'settle' | 'insert' | 'asp';
export interface PendingEntry {
  kind: PoolTxKind; txId: string; nullifier: bigint | null;
  invalidHereafter: number; spent: UtxoRef[]; outputs: Utxo[]; unseen: number;
}
export type SubmitResult =
  | { status: 'accepted' | 'unknown'; txId: string }
  | { status: 'rejected'; txId: string; reason: 'bad_inputs' | 'other'; message: string };
export interface ResetEvent { reason: 'dropped' | 'expired' | 'rejected_child'; dropped: PendingEntry[] }

const refKey = (ref: UtxoRef): string => `${ref.txId}#${ref.index}`;

export class Sequencer {
  readonly ctx: ChainContext;
  readonly maxPending: number;
  private readonly provider: Provider;
  private readonly status: TxStatusReader;
  private readonly childRetryMs: number;
  private readonly childRetryForMs: number;
  private readonly unseenLimit: number;
  private readonly aspHoldMs: number;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private entries: PendingEntry[] = [];
  private holdUntil = 0;
  private lock: Promise<void> = Promise.resolve();
  private resets: ResetEvent[] = [];
  private readonly listeners: ((event: ResetEvent) => void | Promise<void>)[] = [];

  constructor(a: {
    ctx: ChainContext; status: TxStatusReader; maxPending?: number;
    childRetryMs?: number; childRetryForMs?: number; unseenLimit?: number;
    aspHoldMs?: number; now?: () => number;
    log?: (line: string) => void;
  }) {
    this.maxPending = a.maxPending ?? 1;
    // Bound the number of transactions lost with a dropped parent.
    if (!Number.isInteger(this.maxPending) || this.maxPending < 1 || this.maxPending > 8) {
      throw new RangeError('maxPending must be an integer from 1 to 8');
    }
    this.aspHoldMs = a.aspHoldMs ?? 120_000;
    if (!Number.isSafeInteger(this.aspHoldMs) || this.aspHoldMs <= 0) {
      throw new RangeError('aspHoldMs must be a positive safe integer');
    }
    this.now = a.now ?? Date.now;
    this.provider = a.ctx.provider;
    this.status = a.status;
    this.childRetryMs = a.childRetryMs ?? 2000;
    this.childRetryForMs = a.childRetryForMs ?? 20000;
    this.unseenLimit = a.unseenLimit ?? 2;
    this.log = a.log ?? (() => {});
    const provider = this.provider;
    this.ctx = { deployment: a.ctx.deployment, provider: {
      getUtxosAt: async address => {
        const confirmed = await provider.getUtxosAt(address);
        const spent = new Set(this.entries.flatMap(entry => entry.spent.map(refKey)));
        // A confirmed output may still be pending until the next reconcile.
        const outputs = new Map(confirmed.map(output => [refKey(output.ref), output]));
        for (const entry of this.entries) {
          for (const output of entry.outputs) if (output.address === address) outputs.set(refKey(output.ref), output);
        }
        // Filter after adding outputs, because a child can spend a pending output.
        return structuredClone([...outputs.values()].filter(output => !spent.has(refKey(output.ref))));
      },
      // complete needs confirmed reads to identify additional evaluator inputs.
      getUtxos: refs => provider.getUtxos(refs),
      getProtocolParameters: () => provider.getProtocolParameters(),
      getTip: () => provider.getTip(),
      evaluate: (cbor, additional) => provider.evaluate(cbor, additional),
      // Call sequencer.submit instead, so the outcome reserves its inputs.
      submit: cbor => provider.submit(cbor),
    } };
  }

  run<T>(fn: () => Promise<T>): Promise<T> { return this.withLock(fn); }

  /** Ask the sequencer to stop admitting Settles until an ASP update is submitted. */
  holdForAsp(): void {
    // An update already in flight already blocks Settles.
    if (this.entries.some(entry => entry.kind === 'asp')) return;
    this.holdUntil = this.now() + this.aspHoldMs;
  }

  canSubmit(kind: PoolTxKind): boolean {
    const settle = this.entries.some(entry => entry.kind === 'settle');
    const insert = this.entries.some(entry => entry.kind === 'insert');
    const asp = this.entries.some(entry => entry.kind === 'asp');
    const count = this.entries.filter(entry => entry.kind !== 'asp').length;
    // ASP updates and Settles cannot race over the ASP reference output.
    if (kind === 'asp') return !asp && !settle;
    if (kind === 'insert') return count < this.maxPending && !insert;
    // A waiting ASP update reserves Settle capacity, so approvals cannot starve.
    return count < this.maxPending && !asp && this.now() >= this.holdUntil;
  }

  /** Call inside run: submission shares the build's lock and must not acquire it again. */
  async submit(signedCbor: string, meta: { kind: PoolTxKind; nullifier?: bigint }): Promise<SubmitResult> {
    const view = decodeTx(signedCbor);
    const pendingOutputs = new Set(this.entries.flatMap(entry => entry.outputs.map(output => refKey(output.ref))));
    const child = view.inputs.some(ref => pendingOutputs.has(refKey(ref)));
    const deadline = performance.now() + this.childRetryForMs;
    let status: 'accepted' | 'unknown' = 'accepted';
    for (;;) {
      try { await this.provider.submit(signedCbor); break; }
      catch (error) {
        // A lost response may hide an accepted transaction. Keep its reservations.
        if (!(error instanceof SubmitRejected)) { status = 'unknown'; break; }
        if (error.reason === 'bad_inputs' && child) {
          const remaining = deadline - performance.now();
          // Different backend nodes may learn the parent at different times.
          if (remaining > 0) { await setTimeout(Math.min(this.childRetryMs, remaining)); continue; }
          this.reset('rejected_child');
        }
        return { status: 'rejected', txId: view.txId, reason: error.reason, message: error.message };
      }
    }
    this.entries.push({ kind: meta.kind, txId: view.txId, nullifier: meta.nullifier ?? null,
      // An absent upper bound must never trigger expiry.
      invalidHereafter: view.invalidHereafter ?? Infinity, spent: view.inputs, outputs: outputsOf(view), unseen: 0 });
    // The update is submitted, so the hold has done its job.
    if (meta.kind === 'asp') this.holdUntil = 0;
    return { status, txId: view.txId };
  }

  reconcile(): Promise<ResetEvent | null> {
    return this.withLock(async () => {
      while (this.entries.length > 0) {
        const entry = this.entries[0]!;
        const status = await this.transactionStatus(entry.txId);
        if (status === 'confirmed') { this.entries.shift(); continue; }
        if (status === 'mempool') entry.unseen = 0;
        // One missing read can be indexing lag after a block, rather than eviction.
        else if (++entry.unseen >= this.unseenLimit) return this.reset('dropped');
        break;
      }
      if (this.entries.length > 0) {
        const tip = await this.provider.getTip();
        if (this.entries.some(entry => entry.invalidHereafter < tip.slot)) return this.reset('expired');
      }
      // Spent-input checks would misclassify transactions during indexing lag.
      return null;
    });
  }

  transactionStatus(txId: string): Promise<TxStatus> { return this.status.transactionStatus(txId); }
  pending(): readonly PendingEntry[] { return structuredClone(this.entries); }
  pendingNullifiers(): bigint[] {
    return this.entries.flatMap(entry => entry.kind === 'settle' && entry.nullifier !== null ? [entry.nullifier] : []);
  }
  onReset(listener: (event: ResetEvent) => void | Promise<void>): void { this.listeners.push(listener); }

  private reset(reason: ResetEvent['reason']): ResetEvent {
    const event = { reason, dropped: this.entries };
    this.entries = [];
    this.resets.push(event);
    return event;
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.lock;
    let release!: () => void;
    // Reserve the queue position before awaiting, so run and reconcile stay FIFO.
    this.lock = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await fn(); }
    finally {
      const resets = this.resets;
      this.resets = [];
      release();
      // Detach events before releasing: listeners may enter run to rebuild.
      for (const event of resets) {
        for (const listener of this.listeners) {
          try { await listener(event); }
          catch (error) { this.log(`Sequencer reset listener failed: ${String(error)}`); }
        }
      }
    }
  }
}
