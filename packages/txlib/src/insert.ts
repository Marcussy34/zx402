import { INSERT_BATCH, NETWORKS, R, labelFor, type CardanoProof, type InsertSlot } from '@zx402/crypto';
import { addAssetAmount, assetAmount, isAdaAsset, type AssetClass } from './asset.js';
import { decodeDepositDatum, encodeDepositRedeemer, encodePoolDatum, encodePoolRedeemer, type ConfigDatum } from './codec.js';
import { complete, newTxBuilder, readConfig, type ChainContext, type DepositUtxo, type Payer, type PoolState } from './context.js';
import { utxoToMesh } from './providers/blockfrost.js';
import { timeToSlot, type BuiltTx } from './types.js';

export interface InsertPlan {
  flush: number;
  deposits: DepositUtxo[];
  slots: InsertSlot[];
  credited: { value: bigint; fee: bigint; label: bigint }[];
}

/** Plans a pool asset batch in ledger order, with the queue taking priority over deposits. */
export function planInsert(a: {
  poolId: string; pool: PoolState; config: ConfigDatum; deposits: DepositUtxo[];
  // Defaults to ADA until every caller passes the deployment asset
  asset?: AssetClass;
}): InsertPlan | null {
  if (!/^[0-9a-fA-F]{56}$/.test(a.poolId)) throw new Error('Invalid pool ID');
  const asset = a.asset ?? { policy: '', name: '' };
  const crankFee = isAdaAsset(asset) ? a.config.crankFee : 0n;
  const capacity = Math.min(INSERT_BATCH, 2 ** 32 - a.pool.datum.size);
  const flush = Math.min(capacity, a.pool.datum.queue.length);
  const plan: InsertPlan = { flush, deposits: [], credited: [],
    slots: a.pool.datum.queue.slice(0, flush).map(commitment => ({ kind: 'note', commitment })) };
  const sorted = [...a.deposits].sort((a, b) => {
    const left = a.utxo.ref.txId.toLowerCase();
    const right = b.utxo.ref.txId.toLowerCase();
    return left < right ? -1 : left > right ? 1 : a.utxo.ref.index - b.utxo.ref.index;
  });
  let creditedBalance = a.pool.balance - a.pool.datum.feesAccrued;
  const seen = new Set<string>();
  for (const deposit of sorted) {
    if (plan.slots.length >= capacity || a.config.depositsPaused) break;
    const { utxo, datum } = deposit;
    const ref = `${utxo.ref.txId.toLowerCase()}#${utxo.ref.index}`;
    if (seen.has(ref)) continue;
    seen.add(ref);
    try {
      if (utxo.inlineDatum === null) continue;
      const actual = decodeDepositDatum(utxo.inlineDatum);
      if (actual.precommitment !== datum.precommitment || actual.refund !== datum.refund.toLowerCase()) continue;
      if (datum.precommitment <= 0n || datum.precommitment >= R) continue;
      const gross = assetAmount(utxo.value, asset);
      if (gross < a.config.minDeposit || gross > a.config.maxDeposit) continue;
      const fee = gross * BigInt(a.config.depositFeeBps) / 10_000n;
      const value = gross - fee - crankFee;
      if (value <= 0n || creditedBalance + value > a.config.poolCap) continue;
      if (!/^[0-9a-fA-F]{64}$/.test(utxo.ref.txId)) continue;
      const label = labelFor({ poolId: Buffer.from(a.poolId, 'hex'), txId: Buffer.from(utxo.ref.txId, 'hex'),
        outputIndex: utxo.ref.index, refundKeyHash: Buffer.from(datum.refund, 'hex') });
      if (label === 0n) continue;
      plan.deposits.push(deposit);
      plan.credited.push({ value, fee, label });
      plan.slots.push({ kind: 'deposit', value, label, precommitment: datum.precommitment });
      creditedBalance += value;
    } catch {
      // Malformed deposits must not stop a crank from processing valid entries.
    }
  }
  return plan.slots.length === 0 ? null : plan;
}

export async function buildInsert(ctx: ChainContext, a: {
  payer: Payer; pool: PoolState; plan: InsertPlan; proof: CardanoProof; newRoot: bigint; validForMs?: number;
}): Promise<BuiltTx> {
  const { network, scripts, refScripts, asset } = ctx.deployment;
  // An Insert must not stay valid forever; ten minutes is enough for one to land.
  const validForMs = a.validForMs ?? 600_000;
  if (!Number.isSafeInteger(validForMs) || validForMs <= 0) throw new RangeError('validForMs must be a positive safe integer');
  const config = await readConfig(ctx);
  const builder = await newTxBuilder({ provider: ctx.provider, network });
  const tip = await ctx.provider.getTip();
  // A devnet tip can precede the network origin, where slot numbers stop being meaningful.
  builder.invalidHereafter(timeToSlot(Math.max(tip.time, NETWORKS[network].zeroTime) + validForMs, network));
  const { utxo, datum } = a.pool;
  const { plan } = a;
  // Token deposits pay the crank from their ADA, without reducing token credit.
  const crankFee = isAdaAsset(asset) ? config.datum.crankFee : 0n;
  // Recompute monetary amounts from inputs and current config, not caller-supplied credits.
  const fees = plan.deposits.reduce((sum, d) => sum + assetAmount(d.utxo.value, asset) * BigInt(config.datum.depositFeeBps) / 10_000n, 0n);
  const growth = plan.deposits.reduce((sum, d) => sum + assetAmount(d.utxo.value, asset) - crankFee, 0n);
  // A plan made for another asset would carry slot values the validator cannot derive.
  if (plan.credited.reduce((sum, c) => sum + c.value, 0n) !== growth - fees) throw new Error('Insert plan does not match the pool asset');
  const next = { ...datum, roots: [a.newRoot, ...datum.roots].slice(0, 16),
    size: datum.size + plan.flush + plan.deposits.length, queue: datum.queue.slice(plan.flush), feesAccrued: datum.feesAccrued + fees };
  builder.spendingPlutusScriptV3().txIn(utxo.ref.txId, utxo.ref.index, utxoToMesh(utxo).output.amount, utxo.address, utxo.scriptRef?.size ?? 0)
    .spendingTxInReference(refScripts.pool.txId, refScripts.pool.index, String(scripts.pool.size), scripts.pool.hash)
    .txInInlineDatumPresent().txInRedeemerValue(encodePoolRedeemer({ kind: 'Insert', proof: a.proof, flush: plan.flush }), 'CBOR');
  for (const { utxo } of plan.deposits) {
    builder.spendingPlutusScriptV3().txIn(utxo.ref.txId, utxo.ref.index, utxoToMesh(utxo).output.amount, utxo.address, utxo.scriptRef?.size ?? 0)
      .spendingTxInReference(refScripts.deposit.txId, refScripts.deposit.index, String(scripts.deposit.size), scripts.deposit.hash)
      .txInInlineDatumPresent().txInRedeemerValue(encodeDepositRedeemer('Absorb'), 'CBOR');
  }
  builder.readOnlyTxInReference(config.utxo.ref.txId, config.utxo.ref.index)
    .txOut(utxo.address, utxoToMesh({ ...utxo, value: addAssetAmount(utxo.value, asset, growth) }).output.amount)
    .txOutInlineDatumValue(encodePoolDatum(next), 'CBOR');
  const references = await ctx.provider.getUtxos([refScripts.pool, ...(plan.deposits.length ? [refScripts.deposit] : [])]);
  return complete({ provider: ctx.provider, network }, builder, {
    payer: a.payer, extraUtxos: [utxo, config.utxo, ...plan.deposits.map(d => d.utxo), ...references],
  });
}
