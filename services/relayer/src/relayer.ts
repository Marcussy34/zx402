import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { bls12_381 } from '@noble/curves/bls12-381.js';
import {
  ApiError, type IndexerApi, type IntentRequest, type PayoutRequest, type PoolView, type ProofHex,
  type Quote, type RelayerApi, type SettleRequest, type SettleStatus,
} from '@zx402/api';
import {
  addressFromBech32, contextFor, type CardanoProof, type SettleIntent, type SnarkjsProof, type SnarkjsVk,
} from '@zx402/crypto';
import { verify } from '@zx402/prover';
import {
  assetWireUnit, buildSettle, enterpriseAddress, isAdaAsset, keyHash, nullifierInsertion, readPool, signTx, slotToTime,
  type ChainContext, type PoolState, type Sequencer, type SubmitResult,
} from '@zx402/txlib';

interface StoredQuote { quote: Quote; payouts: PayoutRequest[] }
/** txHashes lists every transaction sent for this request, oldest first. A reset can rebuild it with a new hash. */
interface Submission {
  status: SettleStatus; nullifier: bigint; validUntil: number; sent: boolean; request: SettleRequest; txHashes: string[];
}
type Sent = Extract<SubmitResult, { status: 'accepted' | 'unknown' }>;
/** The build failed or every submit was refused, so no version is in a mempool. The cause is already logged. */
class NotSent extends Error {}
const notSentMessage = 'Could not build or submit the settle transaction';

function proofBytes(proof: ProofHex): CardanoProof {
  const bytes = (value: string, length: number) => {
    if (typeof value !== 'string' || value.length !== length * 2 || !/^[0-9a-f]+$/.test(value)) {
      throw new Error('Invalid compressed proof');
    }
    return Buffer.from(value, 'hex');
  };
  return { a: bytes(proof.a, 48), b: bytes(proof.b, 96), c: bytes(proof.c, 48) };
}

/** The API carries compressed points; snarkjs verifies affine coordinates. */
function snarkjsProof(proof: CardanoProof): SnarkjsProof {
  const a = bls12_381.G1.Point.fromBytes(proof.a);
  const b = bls12_381.G2.Point.fromBytes(proof.b);
  const c = bls12_381.G1.Point.fromBytes(proof.c);
  for (const point of [a, b, c]) {
    point.assertValidity();
    if (point.is0()) throw new Error('Proof points must not be infinity');
  }
  const aa = a.toAffine();
  const bb = b.toAffine();
  const cc = c.toAffine();
  return { pi_a: [String(aa.x), String(aa.y), '1'],
    pi_b: [[String(bb.x.c0), String(bb.x.c1)], [String(bb.y.c0), String(bb.y.c1)], ['1', '0']],
    pi_c: [String(cc.x), String(cc.y), '1'], protocol: 'groth16', curve: 'bls12381' };
}

export class Relayer implements RelayerApi {
  private readonly ctx: ChainContext;
  private readonly sequencer: Sequencer;
  private readonly indexer: IndexerApi;
  private readonly seed: Uint8Array;
  private readonly vkey: SnarkjsVk;
  private readonly relayerFee: bigint;
  private readonly payoutLovelace: bigint;
  private readonly quoteTtlMs: number;
  private readonly retryDelayMs: number;
  private readonly maxQuotes: number;
  private readonly submissionTtlMs: number;
  private readonly maxQueued: number;
  private readonly now: () => number;
  private readonly log: (message: string, error?: unknown) => void;
  private readonly relayerKeyHash: string;
  private readonly quotes = new Map<string, StoredQuote>();
  private readonly submissions = new Map<string, Submission>();
  private readonly inFlight = new Map<string, Promise<SettleStatus>>();
  private serial: Promise<unknown> = Promise.resolve();

  constructor(a: {
    ctx: ChainContext; indexer: IndexerApi; seed: Uint8Array; vkey: SnarkjsVk;
    /** Owns the pool output: every Settle builds on its head and submits through it. */
    sequencer: Sequencer;
    /** The relayer fee is in pool asset units. */
    relayerFee?: bigint;
    payoutLovelace?: bigint; quoteTtlMs?: number; retryDelayMs?: number; now?: () => number;
    maxQuotes?: number; submissionTtlMs?: number; maxQueued?: number;
    log?: (message: string, error?: unknown) => void;
  }) {
    this.ctx = a.ctx;
    this.sequencer = a.sequencer;
    this.indexer = a.indexer;
    this.seed = a.seed.slice();
    this.vkey = a.vkey;
    this.relayerFee = a.relayerFee ?? 1_000_000n;
    const adaPool = isAdaAsset(this.ctx.deployment.asset);
    this.payoutLovelace = a.payoutLovelace ?? (adaPool ? 0n : 2_000_000n);
    if (this.payoutLovelace < 0n || (adaPool ? this.payoutLovelace !== 0n : this.payoutLovelace < 1_000_000n)) {
      throw new RangeError('payoutLovelace must be 0 in an ADA pool or at least 1000000 in a token pool');
    }
    this.quoteTtlMs = a.quoteTtlMs ?? 300_000;
    this.retryDelayMs = a.retryDelayMs ?? 20_000;
    this.maxQuotes = a.maxQuotes ?? 1000;
    this.submissionTtlMs = a.submissionTtlMs ?? 3_600_000;
    this.maxQueued = a.maxQueued ?? 16;
    this.now = a.now ?? Date.now;
    this.log = a.log ?? (() => undefined);
    this.relayerKeyHash = Buffer.from(keyHash(this.seed)).toString('hex');
    if (this.relayerFee < 0n || !Number.isSafeInteger(this.quoteTtlMs) || this.quoteTtlMs <= 0
      || !Number.isSafeInteger(this.retryDelayMs) || this.retryDelayMs < 1) {
      throw new RangeError('Fees must be nonnegative and delays must be positive safe integers');
    }
    // Listeners run while the caller of run or reconcile waits, so only enqueue rebuilds here.
    this.sequencer.onReset(event => {
      for (const entry of event.dropped) {
        if (entry.kind !== 'settle') continue;
        const job = this.serial.then(() => this.rebuild(entry.txId));
        this.serial = job.catch(() => undefined);
      }
    });
  }

  getPool(): Promise<PoolView> { return this.indexer.getPool(); }

  async quote(payouts: PayoutRequest[]): Promise<Quote> {
    this.cleanSubmissions();
    for (const [id, { quote }] of this.quotes) {
      if (this.now() >= quote.validUntil) this.quotes.delete(id);
    }
    if (this.quotes.size >= this.maxQuotes) throw new ApiError('internal', 'Relayer is busy', 503);
    if (!Array.isArray(payouts) || payouts.length < 1 || payouts.length > 4) {
      throw new ApiError('bad_request', 'A quote requires one to four payouts');
    }
    // The relayer funds token outputs with ADA, so token amounts can be smaller.
    const minimumPayout = isAdaAsset(this.ctx.deployment.asset) ? 1_000_000n : 1n;
    const saved = payouts.map(payout => {
      try {
        addressFromBech32(payout.address, this.ctx.deployment.network);
        if (typeof payout.amount !== 'bigint' || payout.amount < minimumPayout) throw new Error('Invalid amount');
        if (payout.datumHash !== null && !/^[0-9a-f]{64}$/.test(payout.datumHash)) throw new Error('Invalid datum hash');
      } catch {
        throw new ApiError('bad_request', `Payouts need a valid network address, datum hash, and at least the minimum payout (${minimumPayout})`);
      }
      return { ...payout };
    });
    const view = await this.getPool();
    if (view.asset !== assetWireUnit(this.ctx.deployment.asset)) {
      throw new ApiError('internal', 'Indexer serves another pool asset');
    }
    const paid = saved.reduce((sum, payout) => sum + payout.amount, 0n);
    const protocolFee = paid * BigInt(view.config.settleFeeBps) / 10_000n;
    // In a token pool every payout costs this relayer payoutLovelace of its own ADA, so the fee is per payout.
    const relayerFee = isAdaAsset(this.ctx.deployment.asset) ? this.relayerFee : this.relayerFee * BigInt(saved.length);
    const withdrawn = paid + protocolFee + relayerFee;
    if (withdrawn >= 1n << 64n) throw new ApiError('bad_request', 'Withdrawal must fit in 64 bits');
    const quote: Quote = { quoteId: randomUUID(), poolId: this.ctx.deployment.poolId, withdrawn, protocolFee,
      relayerFee, payoutLovelace: this.payoutLovelace,
      relayerKeyHash: this.relayerKeyHash, validUntil: this.now() + this.quoteTtlMs };
    // Other quote requests can finish while the indexer read is in flight.
    if (this.quotes.size >= this.maxQuotes) throw new ApiError('internal', 'Relayer is busy', 503);
    this.quotes.set(quote.quoteId, { quote, payouts: saved });
    return { ...quote };
  }

  settle(request: SettleRequest): Promise<SettleStatus> {
    this.cleanSubmissions();
    const existing = this.inFlight.get(request.quoteId);
    if (existing) return existing;
    const submission = this.submissions.get(request.quoteId);
    if (submission?.sent) {
      return this.getSettle(request.quoteId).then(status => {
        // Polling reports expiry, but a submitted quote must never become a new refusal.
        if (status.status === 'failed') throw new ApiError('uncertain', 'Could not determine the settle transaction outcome');
        return status;
      });
    }
    // One slot belongs to the active request; only the rest wait in the serial queue.
    if (this.inFlight.size >= this.maxQueued + 1) return Promise.reject(new ApiError('internal', 'Relayer is busy', 503));
    // Callers can mutate their own objects while another request waits for the pool.
    const snapshot = structuredClone(request);
    const result = this.serial.then(() => this.submit(snapshot)).finally(() => this.inFlight.delete(snapshot.quoteId));
    this.inFlight.set(snapshot.quoteId, result);
    this.serial = result.catch(() => undefined);
    return result;
  }

  async getSettle(id: string): Promise<SettleStatus> {
    const entry = this.submissions.get(id);
    if (!entry) throw new ApiError('not_found', 'Settle not found');
    if (entry.status.status !== 'failed') {
      try {
        const view = await this.getPool();
        const confirmed = (await this.nullifiers()).includes(entry.nullifier);
        if (!confirmed && slotToTime(view.tip.slot, this.ctx.deployment.network) > entry.validUntil) {
          entry.status = { ...entry.status, status: 'failed', confirmations: 0, error: 'Expired before confirmation' };
          this.quotes.delete(id);
          return { ...entry.status };
        }
        const txHash = confirmed ? await this.landedHash(entry) : entry.status.txHash;
        return { ...entry.status, txHash, status: confirmed ? 'confirmed' : 'submitted', confirmations: confirmed ? 1 : 0 };
      } catch (error) {
        this.log('Could not read the settle transaction outcome', error);
        throw new ApiError('uncertain', 'Could not determine the settle transaction outcome');
      }
    }
    return { ...entry.status };
  }

  private cleanSubmissions(): void {
    const now = this.now();
    for (const [id, entry] of this.submissions) {
      if (now - entry.validUntil >= this.submissionTtlMs) this.submissions.delete(id);
    }
  }

  /** The nullifier proves one version landed. Every version spends that nullifier, so only one can be in a block. */
  private async landedHash(entry: Submission): Promise<string> {
    try {
      for (const hash of [...entry.txHashes].reverse()) {
        if (await this.sequencer.transactionStatus(hash) === 'confirmed') return hash;
      }
    } catch (error) {
      this.log('Could not read the status of a settle transaction', error);
    }
    return entry.status.txHash;
  }

  private checkExpiry(quote: { validUntil: number }): void {
    if (this.now() >= quote.validUntil) throw new ApiError('quote_expired', 'Quote has expired');
  }

  private intent(request: IntentRequest): SettleIntent {
    return { poolId: Buffer.from(request.poolId, 'hex'), relayer: Buffer.from(this.relayerKeyHash, 'hex'),
      validUntil: BigInt(request.validUntil), payouts: request.payouts.map(payout => ({
        address: addressFromBech32(payout.address, this.ctx.deployment.network), amount: payout.amount,
        datumHash: payout.datumHash === null ? null : Buffer.from(payout.datumHash, 'hex'),
      })) };
  }

  private async nullifiers(): Promise<bigint[]> {
    const values: bigint[] = [];
    for (;;) {
      const page = await this.indexer.getNullifiers(values.length, 1000);
      if (page.from !== values.length) throw new ApiError('internal', 'Indexer returned an inconsistent nullifier page');
      if (page.nullifiers.length === 0) return values;
      values.push(...page.nullifiers);
    }
  }

  /** Rebuilds one dropped Settle on the new head. Any failure leaves the submission for getSettle to decide. */
  private async rebuild(txId: string): Promise<void> {
    const entry = [...this.submissions.values()].find(submission => submission.sent && submission.txHashes.includes(txId));
    // An expired quote is not rebuilt: getSettle fails it once the chain passes the deadline.
    if (!entry || entry.status.status === 'failed' || this.now() >= entry.validUntil) return;
    try {
      // A reset can be wrong while the indexer lags, and the dropped version may have landed.
      if ((await this.spentNullifiers()).includes(entry.nullifier)) return;
      const sent = await this.send({ validUntil: entry.validUntil }, entry.request);
      if (!entry.txHashes.includes(sent.txId)) entry.txHashes.push(sent.txId);
      entry.status = { ...entry.status, txHash: sent.txId };
    } catch (error) {
      this.log('Could not rebuild the settle transaction', error);
    }
  }

  /**
   * Builds on the sequencer's head and submits, in up to three attempts. A refusal is definite,
   * so the next attempt builds on the newer head. Throws NotSent when no attempt reached a mempool.
   */
  private async send(quote: { validUntil: number }, request: SettleRequest): Promise<Sent> {
    const intent = this.intent(request.intent);
    const proof = proofBytes(request.proof);
    let attempts = 0;
    for (;;) {
      await this.waitForRoom(quote);
      const result = await this.sequencer.run(() => this.buildAndSubmit(quote, request.publicInputs, intent, proof));
      // Another run closed the gate after the room check. That is more waiting, not a failed attempt.
      if (result === 'wait') continue;
      if (result !== 'behind' && result.status !== 'rejected') return result;
      if (result !== 'behind') this.log('The node refused the settle transaction', new Error(result.message));
      if (++attempts === 3) {
        if (result === 'behind') this.log(notSentMessage, new Error('Indexer nullifiers are behind the pool'));
        throw new NotSent();
      }
      // The next room check reconciles first, so a confirmed or reset head is current again.
      await this.pause(quote);
    }
  }

  /** Waits until the sequencer admits a Settle. Each reconcile can confirm or reset pending entries. */
  private async waitForRoom(quote: { validUntil: number }): Promise<void> {
    for (;;) {
      this.checkExpiry(quote);
      await this.sequencer.reconcile();
      if (this.sequencer.canSubmit('settle')) return;
      await this.pause(quote);
    }
  }

  /** Sleeps retryDelayMs, but never past the quote's deadline, so an expired request answers at the deadline. */
  private async pause(quote: { validUntil: number }): Promise<void> {
    this.checkExpiry(quote);
    await delay(Math.min(this.retryDelayMs, quote.validUntil - this.now()));
  }

  /** The indexer's nullifiers, plus pending and recently confirmed Settles it may not have synced yet. */
  private async spentNullifiers(): Promise<bigint[]> {
    return [...new Set([...await this.nullifiers(), ...this.sequencer.recentNullifiers()])];
  }

  /** Runs under the sequencer's lock, so the head, the pending nullifiers and the submit stay consistent. */
  private async buildAndSubmit(quote: { validUntil: number }, inputs: SettleRequest['publicInputs'], intent: SettleIntent,
    proof: CardanoProof): Promise<SubmitResult | 'behind' | 'wait'> {
    // A run queued ahead of this one may have filled the gate since the room check.
    if (!this.sequencer.canSubmit('settle')) return 'wait';
    let pool: PoolState;
    try { pool = await readPool(this.sequencer.ctx); }
    catch (error) {
      this.log('Could not read the pool', error);
      throw new ApiError('internal', 'Could not read the pool');
    }
    const view = await this.getPool();
    // The Settle spends the head. The confirmed indexer view can lag a pending or just confirmed Insert.
    if (!pool.datum.roots.includes(inputs.stateRoot)) throw new ApiError('stale_root', 'State root is no longer in the pool history');
    // No ASP update is pending while the gate is open, so the confirmed ASP root is the one the Settle references.
    if (view.aspRoot !== inputs.aspRoot) throw new ApiError('stale_asp_root', 'ASP root has changed');
    const spent = await this.spentNullifiers();
    if (spent.includes(inputs.nullifierHash)) throw new ApiError('nullifier_spent', 'Nullifier is already spent');
    if (pool.datum.queue.length >= 8) throw new ApiError('queue_full', 'Pool queue is full');
    try {
      this.checkExpiry(quote);
      const trie = await nullifierInsertion(spent, inputs.nullifierHash);
      // The indexer can lag behind the head. Retry outside the lock.
      if (trie.oldRoot !== pool.datum.nullifierRoot) return 'behind';
      // In a token pool every payout output also gets payoutLovelace from this relayer's ADA.
      const tx = await buildSettle(this.sequencer.ctx, { payer: { address: enterpriseAddress(this.seed, this.ctx.deployment.network) }, payoutLovelace: this.payoutLovelace,
        pool, proof, nullifierHash: inputs.nullifierHash, newCommitment: inputs.newCommitment,
        withdrawn: inputs.withdrawn, stateRoot: inputs.stateRoot, intent,
        nullifierProof: trie.proofCbor, newNullifierRoot: trie.newRoot });
      this.checkExpiry(quote);
      // The ASP service can set a hold during the build without the lock.
      if (!this.sequencer.canSubmit('settle')) return 'wait';
      return await this.sequencer.submit(signTx(tx.cbor, [this.seed]), { kind: 'settle', nullifier: inputs.nullifierHash });
    } catch (error) {
      if (error instanceof ApiError && error.code === 'quote_expired') throw error;
      this.log(notSentMessage, error);
      throw new NotSent();
    }
  }

  private async submit(request: SettleRequest): Promise<SettleStatus> {
    const stored = this.quotes.get(request.quoteId);
    if (!stored) throw new ApiError('not_found', 'Quote not found');
    const { quote, payouts } = stored;
    this.checkExpiry(quote);
    const { intent: proposed, publicInputs: inputs } = request;
    if (proposed.poolId !== quote.poolId || proposed.relayer !== this.relayerKeyHash || proposed.validUntil !== quote.validUntil
      || proposed.payouts.length !== payouts.length || proposed.payouts.some((payout, i) => {
        const expected = payouts[i]!;
        return payout.address !== expected.address || payout.amount !== expected.amount || payout.datumHash !== expected.datumHash;
      })) throw new ApiError('intent_mismatch', 'Intent does not match the quote');
    const intent = this.intent(proposed);
    if (inputs.withdrawn !== quote.withdrawn || inputs.context !== contextFor(intent)) {
      throw new ApiError('intent_mismatch', 'Public inputs do not match the intent');
    }
    let proof: CardanoProof;
    let verified = false;
    try {
      proof = proofBytes(request.proof);
      verified = await verify(this.vkey, [inputs.newCommitment, inputs.nullifierHash, inputs.withdrawn,
        inputs.stateRoot, inputs.aspRoot, inputs.context], snarkjsProof(proof));
    } catch (error) {
      this.log('Could not verify spend proof', error);
    }
    if (!verified) {
      this.quotes.delete(quote.quoteId);
      throw new ApiError('invalid_proof', 'Spend proof did not verify');
    }
    let sent: Sent;
    try { sent = await this.send(quote, request); }
    catch (error) {
      if (!(error instanceof NotSent)) throw error;
      // The quote ID is also the tracking ID. Nothing was sent, so a retry of this quote may build again.
      this.submissions.set(quote.quoteId, { status: { id: quote.quoteId, status: 'failed', txHash: '00'.repeat(32), confirmations: 0,
        error: notSentMessage }, nullifier: inputs.nullifierHash, validUntil: quote.validUntil, sent: false, request, txHashes: [] });
      throw new ApiError('internal', notSentMessage);
    }
    const status: SettleStatus = { id: quote.quoteId, status: 'submitted', txHash: sent.txId, confirmations: 0, error: null };
    this.submissions.set(status.id, { status, nullifier: inputs.nullifierHash, validUntil: quote.validUntil, sent: true,
      request, txHashes: [sent.txId] });
    if (sent.status === 'accepted') return { ...status };
    // A lost reply cannot prove rejection. The sequencer keeps the transaction pending, and reconciling decides.
    this.log('Could not determine the settle transaction outcome');
    try {
      if ((await this.nullifiers()).includes(inputs.nullifierHash)) return { ...status };
    } catch (error) {
      this.log('Could not read nullifiers after a settle submission', error);
    }
    throw new ApiError('uncertain', 'Could not determine the settle transaction outcome');
  }
}
