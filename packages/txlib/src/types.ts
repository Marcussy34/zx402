import { NETWORKS, type Network } from '@zx402/crypto';
import { PV11_COST_MODELS, type CostModels } from './cost-models.js';
export type { Network } from '@zx402/crypto';
export type { CostModels } from './cost-models.js';

/** Transaction ID as 64 lowercase hex characters, and an output index. */
export interface UtxoRef { txId: string; index: number }
/** Native tokens keyed by policy ID hex followed by asset name hex. Lovelace is separate. */
export interface Value { lovelace: bigint; assets: Record<string, bigint> }
/** Script hash hex, language-tagged ledger script CBOR hex, and script byte length for fees. */
export interface ScriptRef { hash: string; cbor: string; size: number }
export interface Utxo {
  ref: UtxoRef;
  address: string; // Bech32.
  value: Value;
  inlineDatum: string | null; // CBOR hex.
  datumHash: string | null; // Hex, when the output carries only a hash.
  scriptRef: ScriptRef | null;
}
export type RedeemerTag = 'spend' | 'mint' | 'cert' | 'reward' | 'vote' | 'propose';
export interface RedeemerUnits { tag: RedeemerTag; index: number; mem: bigint; steps: bigint }
export interface ProtocolParameters {
  costModels: CostModels;
  minFeeA: bigint; minFeeB: bigint;
  priceMem: number; priceStep: number;
  maxTxSize: number; maxTxExMem: bigint; maxTxExSteps: bigint;
  coinsPerUtxoByte: bigint;
  refScriptCostPerByte: number; refScriptTierBytes: number; refScriptTierMultiplier: number;
  collateralPercent: number; maxCollateralInputs: number;
}

/** SPEC 10.1 mainnet values at epoch 659. Real providers fetch live values. */
export const MAINNET_PARAMETERS: ProtocolParameters = {
  costModels: PV11_COST_MODELS,
  minFeeA: 44n, minFeeB: 155381n,
  priceMem: 0.0577, priceStep: 0.0000721,
  maxTxSize: 16384, maxTxExMem: 16500000n, maxTxExSteps: 10000000000n,
  coinsPerUtxoByte: 4310n,
  refScriptCostPerByte: 15, refScriptTierBytes: 25600, refScriptTierMultiplier: 1.2,
  collateralPercent: 150, maxCollateralInputs: 3,
};

/** Preprod matches mainnet except for its transaction memory limit. */
export const PREPROD_PARAMETERS: ProtocolParameters = {
  ...MAINNET_PARAMETERS, maxTxExMem: 17500000n,
};

export const PARAMETERS: Readonly<Record<Network, ProtocolParameters>> = {
  mainnet: MAINNET_PARAMETERS,
  preprod: PREPROD_PARAMETERS,
};

/** Converts slots on the selected network to POSIX milliseconds. */
export function slotToTime(slot: number, network: Network = 'mainnet'): number {
  const { zeroTime, zeroSlot, slotLength } = NETWORKS[network];
  return zeroTime + (slot - zeroSlot) * slotLength;
}

/** Floors POSIX milliseconds to the containing slot on the selected network. */
export function timeToSlot(timeMs: number, network: Network = 'mainnet'): number {
  const { zeroTime, zeroSlot, slotLength } = NETWORKS[network];
  return zeroSlot + Math.floor((timeMs - zeroTime) / slotLength);
}

export interface ChainTip { slot: number; time: number; blockHash: string }

/** A script failed during evaluation. Infrastructure failures use plain Error. */
export class ScriptFailure extends Error {
  readonly traces: string[];

  constructor(message: string, traces: string[] = []) {
    super(message);
    this.name = 'ScriptFailure';
    this.traces = [...traces];
  }
}

export interface Provider {
  getUtxosAt(address: string): Promise<Utxo[]>;
  /** Spent or unknown references are left out. */
  getUtxos(refs: UtxoRef[]): Promise<Utxo[]>;
  getProtocolParameters(): Promise<ProtocolParameters>;
  getTip(): Promise<ChainTip>;
  /**
   * Returns units per redeemer and throws ScriptFailure for script failures.
   * additionalUtxos contains unconfirmed outputs for chaining.
   * Adapters that cannot honor additionalUtxos must throw, never ignore them.
   */
  evaluate(txCbor: string, additionalUtxos?: Utxo[]): Promise<RedeemerUnits[]>;
  /** Returns the transaction ID. */
  submit(txCbor: string): Promise<string>;
}

/** Pending in a mempool, in a block, or not found. */
export type TxStatus = 'mempool' | 'confirmed' | 'unknown';

/** Reads the node's view of one transaction. */
export interface TxStatusReader { transactionStatus(txId: string): Promise<TxStatus> }

/**
 * The node refused the transaction, so it is in no mempool we sent it to.
 * Any other submit error means the outcome is unknown.
 */
export class SubmitRejected extends Error {
  readonly reason: 'bad_inputs' | 'other';

  constructor(message: string, reason: 'bad_inputs' | 'other') {
    super(message);
    this.name = 'SubmitRejected';
    this.reason = reason;
  }
}

/** Builders return unsigned transactions unless they explicitly say otherwise. */
export interface BuiltTx { cbor: string; txId: string; fee: bigint; size: number; exUnits: RedeemerUnits[] }

type Fraction = { numerator: bigint; denominator: bigint };

// Convert decimal prices before multiplying. Execution counts must never become floats.
function fraction(value: number): Fraction {
  if (!Number.isFinite(value) || value < 0) throw new RangeError('Fee prices must be finite and nonnegative');
  const [coefficient, exponent = '0'] = value.toString().split('e');
  const [whole, decimals = ''] = coefficient!.split('.');
  const scale = decimals.length - Number(exponent);
  const numerator = BigInt(whole! + decimals);
  return scale < 0
    ? { numerator: numerator * 10n ** BigInt(-scale), denominator: 1n }
    : { numerator, denominator: 10n ** BigInt(scale) };
}

const ceil = (numerator: bigint, denominator: bigint): bigint => (numerator + denominator - 1n) / denominator;

/** SPEC 10.1 size fee, rounded execution fee, and rounded tiered reference fee. */
export function minFee(p: ProtocolParameters, a: { size: number; exUnits: RedeemerUnits[]; refScriptBytes: number }): bigint {
  if (!Number.isSafeInteger(a.size) || a.size < 0 || !Number.isSafeInteger(a.refScriptBytes) || a.refScriptBytes < 0) {
    throw new RangeError('Transaction and reference sizes must be nonnegative safe integers');
  }
  if (!Number.isSafeInteger(p.refScriptTierBytes) || p.refScriptTierBytes <= 0) {
    throw new RangeError('Reference script tier size must be a positive safe integer');
  }
  let mem = 0n;
  let steps = 0n;
  for (const units of a.exUnits) {
    if (units.mem < 0n || units.steps < 0n) throw new RangeError('Execution units must be nonnegative');
    mem += units.mem;
    steps += units.steps;
  }
  const memoryPrice = fraction(p.priceMem);
  const stepPrice = fraction(p.priceStep);
  const execution = ceil(
    mem * memoryPrice.numerator * stepPrice.denominator + steps * stepPrice.numerator * memoryPrice.denominator,
    memoryPrice.denominator * stepPrice.denominator,
  );
  let remaining = BigInt(a.refScriptBytes);
  const tier = BigInt(p.refScriptTierBytes);
  const price = fraction(p.refScriptCostPerByte);
  const multiplier = fraction(p.refScriptTierMultiplier);
  let referenceNumerator = 0n;
  // Keep the running sum on the current tier's denominator to avoid float rounding.
  while (remaining > 0n) {
    const bytes = remaining < tier ? remaining : tier;
    referenceNumerator += bytes * price.numerator;
    remaining -= bytes;
    if (remaining > 0n) {
      referenceNumerator *= multiplier.denominator;
      price.numerator *= multiplier.numerator;
      price.denominator *= multiplier.denominator;
    }
  }
  return p.minFeeB + p.minFeeA * BigInt(a.size) + execution + ceil(referenceNumerator, price.denominator);
}
