import { createHash } from 'node:crypto';
import { Address, Costmdls, CredentialType, HexBlob, PlutusLanguageVersion, Script, Transaction, TxCBOR } from '@meshsdk/core-cst';
import { blake2b } from '@noble/hashes/blake2.js';
import type { ChainHistory, TxRecord } from '../history.js';
import { verifyWitnesses } from '../keys.js';
import { decodeTx, outputsOf, type TxView } from '../txview.js';
import {
  PARAMETERS, ScriptFailure, SubmitRejected, minFee, slotToTime, type ChainTip, type Network,
  type ProtocolParameters, type Provider, type RedeemerUnits, type TxStatus, type TxStatusReader,
  type Utxo, type UtxoRef, type Value,
} from '../types.js';
import { simulate } from './simulate.js';

export type LedgerRule =
  | 'missing_input' | 'duplicate_input' | 'outside_validity_interval' | 'value_not_conserved'
  | 'fee_too_small' | 'tx_too_large' | 'ex_units_exceeded' | 'min_utxo' | 'bad_signature'
  | 'missing_signature' | 'missing_script' | 'missing_datum' | 'missing_redeemer'
  | 'script_integrity' | 'script_failure' | 'insufficient_collateral' | 'unsupported';

/** A transaction broke one of the fake chain's supported ledger rules. */
export class LedgerError extends SubmitRejected {
  readonly rule: LedgerRule;

  constructor(rule: LedgerRule, message: string = rule) {
    super(message, rule === 'missing_input' ? 'bad_inputs' : 'other');
    this.name = 'LedgerError';
    this.rule = rule;
  }
}

export interface FakeBlock { height: number; slot: number; hash: string; txIds: string[] }

type PendingTx = { cbor: string; view: TxView; addresses: Set<string> };
type BlockState = { block: FakeBlock; transactions: PendingTx[]; before: Map<string, Utxo>; previousSlot: number };
const refKey = (ref: UtxoRef): string => `${ref.txId}#${ref.index}`;
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const genesisHash = '00'.repeat(32);

function check(condition: boolean, rule: LedgerRule, detail?: string): asserts condition {
  if (!condition) throw new LedgerError(rule, detail === undefined ? rule : `${rule}: ${detail}`);
}

function paymentCredential(address: string) {
  const credential = Address.fromBech32(address).getProps().paymentPart;
  check(credential !== undefined, 'unsupported', 'Only Shelley payment addresses are supported');
  return credential;
}

function addValue(balance: Map<string, bigint>, value: Value, direction: bigint): void {
  for (const [unit, quantity] of [['lovelace', value.lovelace], ...Object.entries(value.assets)] as const) {
    balance.set(unit, (balance.get(unit) ?? 0n) + direction * quantity);
  }
}

function apply(utxos: Map<string, Utxo>, view: TxView): void {
  for (const ref of view.inputs) utxos.delete(refKey(ref));
  for (const output of outputsOf(view)) utxos.set(refKey(output.ref), output);
}

function nonnegativeInteger(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Expected a nonnegative safe integer');
}

function checkScriptIntegrity(tx: Transaction, resolved: Utxo[], usedHashes: string[], parameters: ProtocolParameters): void {
  const witnesses = tx.witnessSet();
  const languages = new Map<string, PlutusLanguageVersion>();
  for (const script of witnesses.plutusV1Scripts()?.values() ?? []) languages.set(script.hash(), PlutusLanguageVersion.V1);
  for (const script of witnesses.plutusV2Scripts()?.values() ?? []) languages.set(script.hash(), PlutusLanguageVersion.V2);
  for (const script of witnesses.plutusV3Scripts()?.values() ?? []) languages.set(script.hash(), PlutusLanguageVersion.V3);
  for (const utxo of resolved) {
    if (!utxo.scriptRef) continue;
    const script = Script.fromCbor(HexBlob(utxo.scriptRef.cbor));
    if (script.asPlutusV1()) languages.set(script.hash(), PlutusLanguageVersion.V1);
    if (script.asPlutusV2()) languages.set(script.hash(), PlutusLanguageVersion.V2);
    if (script.asPlutusV3()) languages.set(script.hash(), PlutusLanguageVersion.V3);
  }
  const costs = [parameters.costModels.PlutusV1, parameters.costModels.PlutusV2, parameters.costModels.PlutusV3];
  // Unused witness and reference scripts must not add language views.
  const used = new Set(usedHashes.flatMap(hash => languages.has(hash) ? [languages.get(hash)!] : []));
  const models = Costmdls.fromCore(new Map([...used].map(language => [language, costs[language]!])));
  const redeemers = witnesses.redeemers();
  const datums = witnesses.plutusData();
  let payload: string | undefined;
  // Parsed SDK objects retain their original CBOR, including noncanonical encodings.
  if (redeemers && redeemers.size() > 0) {
    payload = redeemers.toCbor() + (datums && datums.size() > 0 ? datums.toCbor() : '') + models.languageViewsEncoding();
  } else if (datums && datums.size() > 0) {
    // The ledger uses empty maps on both sides for datum-only transactions.
    payload = 'a0' + datums.toCbor() + 'a0';
  }
  const expected = payload === undefined ? undefined : Buffer.from(blake2b(Buffer.from(payload, 'hex'), { dkLen: 32 })).toString('hex');
  check(tx.body().scriptDataHash() === expected, 'script_integrity', 'Script data hash does not match the chain cost models and witnesses');
}

/** A deterministic test chain for the transaction rules used by M0, not a complete Cardano ledger. */
export class FakeChain implements Provider, ChainHistory, TxStatusReader {
  private readonly network: Network;
  private readonly parameters: ProtocolParameters;
  private slot: number;
  private sequence = 0;
  private confirmed = new Map<string, Utxo>();
  private mempool: PendingTx[] = [];
  private history: BlockState[] = [];
  private submission: Promise<unknown> = Promise.resolve();

  constructor(options: { network?: Network; parameters?: ProtocolParameters; startSlot?: number } = {}) {
    this.network = options.network ?? 'mainnet';
    this.parameters = structuredClone(options.parameters ?? PARAMETERS[this.network]);
    this.slot = options.startSlot ?? 0;
    nonnegativeInteger(this.slot);
  }

  /** Setup only. Synthetic refs are deterministic and never overwrite existing UTXOs. */
  addUtxo(utxo: Omit<Utxo, 'ref'> & { ref?: UtxoRef }): UtxoRef {
    const ref = structuredClone(utxo.ref ?? { txId: hash(`fake-utxo:${this.sequence++}`), index: 0 });
    if (this.confirmed.has(refKey(ref))
      || this.mempool.some(tx => tx.view.txId === ref.txId && ref.index >= 0 && ref.index < tx.view.outputs.length)) {
      throw new Error(`UTXO already exists: ${refKey(ref)}`);
    }
    this.confirmed.set(refKey(ref), structuredClone({ ...utxo, ref }));
    return structuredClone(ref);
  }

  async getUtxosAt(address: string): Promise<Utxo[]> {
    return this.allUtxos().filter(utxo => utxo.address === address);
  }

  async getUtxos(refs: UtxoRef[]): Promise<Utxo[]> {
    return refs.flatMap(ref => {
      const utxo = this.confirmed.get(refKey(ref));
      return utxo ? [structuredClone(utxo)] : [];
    });
  }

  async getProtocolParameters(): Promise<ProtocolParameters> { return structuredClone(this.parameters); }

  async getTip(): Promise<ChainTip> {
    return { slot: this.slot, time: slotToTime(this.slot, this.network), blockHash: this.history.at(-1)?.block.hash ?? genesisHash };
  }

  private available(): Map<string, Utxo> {
    const available = new Map(this.confirmed);
    for (const tx of this.mempool) apply(available, tx.view);
    return available;
  }

  private resolve(view: TxView, additional: Utxo[] = []): Utxo[] {
    const available = this.available();
    for (const utxo of additional) available.set(refKey(utxo.ref), structuredClone(utxo));
    const refs = [...view.inputs, ...view.referenceInputs, ...view.collateral];
    for (const ref of refs) check(available.has(refKey(ref)), 'missing_input', refKey(ref));
    // Duplicates within each role are invalid. Collateral may also be a regular input.
    for (const group of [view.inputs, view.referenceInputs, view.collateral]) {
      check(new Set(group.map(refKey)).size === group.length, 'duplicate_input');
    }
    const spending = new Set(view.inputs.map(refKey));
    check(!view.referenceInputs.some(ref => spending.has(refKey(ref))), 'duplicate_input', 'Spent and reference inputs overlap');
    return [...new Set(refs.map(refKey))].map(key => available.get(key)!);
  }

  async evaluate(txCbor: string, additionalUtxos: Utxo[] = []): Promise<RedeemerUnits[]> {
    // A live evaluator knows every confirmed output and refuses one that is sent again
    // (Ogmios answers AdditionalUtxoOverlap). Extra inputs are for outputs that are not on chain yet.
    const overlap = additionalUtxos.filter(utxo => this.confirmed.has(refKey(utxo.ref))).map(utxo => refKey(utxo.ref));
    if (overlap.length > 0) throw new Error(`AdditionalUtxoOverlap: ${overlap.join(', ')}`);
    const view = decodeTx(txCbor);
    return simulate(txCbor, this.resolve(view, additionalUtxos), this.network);
  }

  /** Serialize submissions because script evaluation yields while input reservations are still pending. */
  submit(txCbor: string): Promise<string> {
    const pending = this.submission.then(() => this.accept(txCbor));
    this.submission = pending.catch(() => undefined);
    return pending;
  }

  private insideInterval(view: TxView): boolean {
    return (view.validFrom === null || this.slot >= view.validFrom)
      && (view.invalidHereafter === null || this.slot < view.invalidHereafter);
  }

  private async accept(cbor: string): Promise<string> {
    const view = decodeTx(cbor);
    const tx = Transaction.fromCbor(TxCBOR(cbor));
    const body = tx.body();
    const witnesses = tx.witnessSet();
    check(!view.hasWithdrawals && !view.hasCertificates, 'unsupported');
    const resolved = this.resolve(view);
    const byRef = new Map(resolved.map(utxo => [refKey(utxo.ref), utxo]));
    const inputs = view.inputs.map(ref => byRef.get(refKey(ref))!);
    const references = view.referenceInputs.map(ref => byRef.get(refKey(ref))!);
    const collateral = view.collateral.map(ref => byRef.get(refKey(ref))!);
    check(this.insideInterval(view), 'outside_validity_interval');
    check(view.size <= this.parameters.maxTxSize, 'tx_too_large');
    check(view.redeemers.every(r => r.mem >= 0n && r.steps >= 0n)
      && view.redeemers.reduce((sum, r) => sum + r.mem, 0n) <= this.parameters.maxTxExMem
      && view.redeemers.reduce((sum, r) => sum + r.steps, 0n) <= this.parameters.maxTxExSteps, 'ex_units_exceeded');

    const balance = new Map<string, bigint>();
    inputs.forEach(input => addValue(balance, input.value, 1n));
    addValue(balance, { lovelace: 0n, assets: view.mint }, 1n);
    view.outputs.forEach(output => addValue(balance, output.value, -1n));
    balance.set('lovelace', (balance.get('lovelace') ?? 0n) - view.fee);
    check([...balance.values()].every(quantity => quantity === 0n), 'value_not_conserved');
    for (const output of body.outputs()) {
      const minimum = this.parameters.coinsPerUtxoByte * BigInt(160 + output.toCbor().length / 2);
      check(output.amount().coin() >= minimum, 'min_utxo');
    }
    check(view.fee >= minFee(this.parameters, {
      size: view.size, exUnits: view.redeemers,
      refScriptBytes: [...inputs, ...references].reduce((sum, input) => sum + (input.scriptRef?.size ?? 0), 0),
    }), 'fee_too_small');

    let validSignatures = false;
    try { validSignatures = verifyWitnesses(cbor); } catch { /* Malformed key witnesses also fail verification. */ }
    check(validSignatures, 'bad_signature');
    const signers = new Set(view.witnessKeyHashes);
    for (const input of inputs) {
      const credential = paymentCredential(input.address);
      if (credential.type === CredentialType.KeyHash) check(signers.has(credential.hash), 'missing_signature');
    }
    for (const input of collateral) {
      const credential = paymentCredential(input.address);
      check(credential.type === CredentialType.KeyHash && signers.has(credential.hash), 'missing_signature');
    }
    check(view.requiredSigners.every(signer => signers.has(signer)), 'missing_signature');

    const scripts = new Set(view.witnessScriptHashes);
    for (const input of [...inputs, ...references]) if (input.scriptRef) scripts.add(input.scriptRef.hash);
    const datumHashes = new Set((witnesses.plutusData()?.values() ?? []).map(datum => datum.hash().toString()));
    const scriptInputs = inputs.flatMap((input, index) => {
      const credential = paymentCredential(input.address);
      return credential.type === CredentialType.ScriptHash ? [{ input, index, hash: credential.hash }] : [];
    });
    const policies = [...new Set(Object.keys(view.mint).map(unit => unit.slice(0, 56)))].sort();
    check([...scriptInputs.map(input => input.hash), ...policies].every(hash => scripts.has(hash)), 'missing_script');
    check(scriptInputs.every(({ input }) => input.inlineDatum !== null
      || (input.datumHash !== null && datumHashes.has(input.datumHash))), 'missing_datum');
    const hasRedeemer = (tag: 'spend' | 'mint', index: number) => view.redeemers.some(r => r.tag === tag && r.index === index);
    check(scriptInputs.every(({ index }) => hasRedeemer('spend', index))
      && policies.every((_, index) => hasRedeemer('mint', index)), 'missing_redeemer');
    if (scriptInputs.length > 0 || policies.length > 0 || view.redeemers.length > 0) {
      const collateralValue = collateral.reduce((sum, input) => sum + input.value.lovelace, 0n);
      check(collateral.length > 0 && collateralValue * 100n >= view.fee * BigInt(this.parameters.collateralPercent), 'insufficient_collateral');
    }

    checkScriptIntegrity(tx, [...inputs, ...references], [...scriptInputs.map(input => input.hash), ...policies], this.parameters);

    try {
      const actual = await simulate(cbor, resolved, this.network);
      for (const units of actual) {
        const declared = view.redeemers.find(r => r.tag === units.tag && r.index === units.index);
        check(declared !== undefined && units.mem <= declared.mem && units.steps <= declared.steps, 'ex_units_exceeded');
      }
    } catch (error) {
      if (error instanceof ScriptFailure) throw new LedgerError('script_failure', error.message);
      throw error;
    }
    // Time or blocks can move during the simulator process. Recheck before reserving inputs.
    this.resolve(view);
    check(this.insideInterval(view), 'outside_validity_interval');
    this.mempool.push({ cbor, view, addresses: new Set([...inputs, ...view.outputs].map(output => output.address)) });
    return view.txId;
  }

  /** Drop expired transactions and descendants whose spent, reference, or collateral input vanished. */
  private pruneMempool(): void {
    const available = new Map(this.confirmed);
    this.mempool = this.mempool.filter(tx => {
      const keep = this.insideInterval(tx.view)
        && [...tx.view.inputs, ...tx.view.referenceInputs, ...tx.view.collateral].every(ref => available.has(refKey(ref)));
      if (keep) apply(available, tx.view);
      return keep;
    });
  }

  /** Mine up to `limit` mempool transactions in submit order. The rest stay pending. */
  mineBlock(slots = 20, options: { limit?: number } = {}): FakeBlock {
    // Check the limit before advanceSlots so a bad value leaves the chain untouched.
    if (options.limit !== undefined) nonnegativeInteger(options.limit);
    const previousSlot = this.slot;
    this.advanceSlots(slots);
    const count = options.limit ?? this.mempool.length;
    const transactions = this.mempool.slice(0, count);
    const height = this.history.length + 1;
    const txIds = transactions.map(tx => tx.view.txId);
    const previousHash = this.history.at(-1)?.block.hash ?? genesisHash;
    const block = { height, slot: this.slot, hash: hash(JSON.stringify([previousHash, height, this.slot, txIds])), txIds };
    this.history.push({ block, transactions, before: new Map(this.confirmed), previousSlot });
    for (const tx of transactions) apply(this.confirmed, tx.view);
    this.mempool = this.mempool.slice(count);
    return structuredClone(block);
  }

  /** Pending transaction IDs, in submit order. */
  mempoolTxIds(): string[] { return this.mempool.map(tx => tx.view.txId); }

  /**
   * Remove a pending transaction and its descendants, and return their IDs, parent first.
   * A descendant spends, references, or uses as collateral an output of a removed transaction.
   */
  dropTransaction(txId: string): string[] {
    if (!this.mempool.some(tx => tx.view.txId === txId)) throw new Error(`Unknown mempool transaction: ${txId}`);
    const removed = new Set<string>();
    const dropped: string[] = [];
    // Mempool order is submit order, so a parent is always seen before its children.
    this.mempool = this.mempool.filter(tx => {
      const refs = [...tx.view.inputs, ...tx.view.referenceInputs, ...tx.view.collateral];
      if (tx.view.txId !== txId && !refs.some(ref => removed.has(refKey(ref)))) return true;
      dropped.push(tx.view.txId);
      for (const output of outputsOf(tx.view)) removed.add(refKey(output.ref));
      return false;
    });
    return dropped;
  }

  advanceSlots(slots: number): void {
    nonnegativeInteger(slots);
    nonnegativeInteger(this.slot + slots);
    this.slot += slots;
    this.pruneMempool();
  }

  rollback(blocks: number): void {
    nonnegativeInteger(blocks);
    if (blocks > this.history.length) throw new RangeError('Cannot roll back more blocks than exist');
    if (blocks > 0) {
      const firstRemoved = this.history[this.history.length - blocks]!;
      this.confirmed = new Map(firstRemoved.before);
      this.slot = firstRemoved.previousSlot;
      this.history.splice(this.history.length - blocks, blocks);
    }
    this.mempool = [];
  }

  blocks(): FakeBlock[] { return this.history.map(state => structuredClone(state.block)); }

  /** Pending in the mempool, confirmed in a block, or unknown after a rollback. */
  async transactionStatus(txId: string): Promise<TxStatus> {
    if (this.mempool.some(tx => tx.view.txId === txId)) return 'mempool';
    // Read the stored transactions directly. blocks() and transaction() clone.
    return this.history.some(({ transactions }) => transactions.some(tx => tx.view.txId === txId))
      ? 'confirmed' : 'unknown';
  }

  transaction(txId: string): { cbor: string; block: FakeBlock | null } | undefined {
    const pending = this.mempool.find(tx => tx.view.txId === txId);
    if (pending) return { cbor: pending.cbor, block: null };
    for (const { block, transactions } of this.history) {
      const tx = transactions.find(tx => tx.view.txId === txId);
      if (tx) return { cbor: tx.cbor, block: structuredClone(block) };
    }
    return undefined;
  }

  allUtxos(): Utxo[] { return structuredClone([...this.confirmed.values()]); }

  async getTransactionsAt(address: string, after?: string): Promise<TxRecord[]> {
    const records = this.history.flatMap(({ block, transactions }) => transactions.map((tx, indexInBlock) => ({
      tx, record: { txId: tx.view.txId, blockHeight: block.height, indexInBlock },
    })));
    const cursor = after === undefined ? -1 : records.findIndex(({ tx }) => tx.view.txId === after);
    if (after !== undefined && cursor === -1) throw new Error(`Unknown confirmed transaction: ${after}`);
    return records.slice(cursor + 1).filter(({ tx }) => tx.addresses.has(address)).map(({ record }) => record);
  }

  async getTransactionCbor(txId: string): Promise<string> {
    const transaction = this.transaction(txId);
    if (!transaction?.block) throw new Error(`Unknown confirmed transaction: ${txId}`);
    return transaction.cbor;
  }
}
