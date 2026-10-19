import { NETWORKS, addressToBech32, assertCanonical } from '@zx402/crypto';
import { addAssetAmount, isAdaAsset, meshAsset } from './asset.js';
import { encodeAspDatum, encodeConfigDatum, encodePoolDatum, encodePoolRedeemer, encodeVoid, type ConfigDatum } from './codec.js';
import { complete, newTxBuilder, readAsp, readConfig, readPool, type ChainContext, type Payer } from './context.js';
import { utxoToMesh } from './providers/blockfrost.js';
import { timeToSlot, type BuiltTx } from './types.js';

/** Recreates the ASP state with its existing operators and URI. Operators sign afterwards. */
export async function buildAspUpdate(ctx: ChainContext, a: {
  payer: Payer; root: bigint; signers: string[]; validForMs?: number;
}): Promise<BuiltTx> {
  assertCanonical(a.root, 'ASP root');
  // An ASP update must not stay valid forever; ten minutes is enough for one to land.
  const validForMs = a.validForMs ?? 600_000;
  if (!Number.isSafeInteger(validForMs) || validForMs <= 0) throw new RangeError('validForMs must be a positive safe integer');
  const { network, scripts, refScripts } = ctx.deployment;
  const { utxo, datum } = await readAsp(ctx);
  const builder = await newTxBuilder({ provider: ctx.provider, network });
  const tip = await ctx.provider.getTip();
  // A devnet tip can precede the network origin, where slot numbers stop being meaningful.
  builder.invalidHereafter(timeToSlot(Math.max(tip.time, NETWORKS[network].zeroTime) + validForMs, network));
  builder.spendingPlutusScriptV3().txIn(utxo.ref.txId, utxo.ref.index, utxoToMesh(utxo).output.amount, utxo.address, utxo.scriptRef?.size ?? 0)
    .spendingTxInReference(refScripts.asp.txId, refScripts.asp.index, String(scripts.asp.size), scripts.asp.hash)
    .txInInlineDatumPresent().txInRedeemerValue(encodeVoid(), 'CBOR')
    .txOut(utxo.address, utxoToMesh(utxo).output.amount)
    .txOutInlineDatumValue(encodeAspDatum({ ...datum, root: a.root }), 'CBOR');
  for (const signer of new Set(a.signers)) builder.requiredSignerHash(signer);
  const references = await ctx.provider.getUtxos([refScripts.asp]);
  return complete({ provider: ctx.provider, network }, builder, { payer: a.payer, extraUtxos: [utxo, ...references] });
}

/** Mirror valid_config_datum so out-of-bounds changes fail before provider access. */
function validateConfig(config: ConfigDatum): void {
  const invalid = (field: string): never => { throw new Error(`Invalid config: ${field} is outside the validator bounds`); };
  if (config.admins.length === 0 || config.admins.some(key => !/^[a-fA-F0-9]{56}$/.test(key))
    || new Set(config.admins.map(key => key.toLowerCase())).size !== config.admins.length) invalid('admins');
  if (!Number.isSafeInteger(config.adminThreshold) || config.adminThreshold < 1 || config.adminThreshold > config.admins.length) invalid('adminThreshold');
  if (!Number.isSafeInteger(config.depositFeeBps) || config.depositFeeBps < 0 || config.depositFeeBps > 100) invalid('depositFeeBps');
  if (!Number.isSafeInteger(config.settleFeeBps) || config.settleFeeBps < 0 || config.settleFeeBps > 1000) invalid('settleFeeBps');
  if (typeof config.crankFee !== 'bigint' || config.crankFee < 0n || config.crankFee > 1_000_000n) invalid('crankFee');
  if (typeof config.minDeposit !== 'bigint' || config.minDeposit <= 0n) invalid('minDeposit');
  if (typeof config.maxDeposit !== 'bigint' || config.maxDeposit < config.minDeposit) invalid('maxDeposit');
  if (typeof config.poolCap !== 'bigint' || config.poolCap < 0n) invalid('poolCap');
  if (typeof config.depositsPaused !== 'boolean') invalid('depositsPaused');
}

/** Extra output lovelace comes from the payer when complete balances the transaction. */
function topUpMinimum(builder: Awaited<ReturnType<typeof newTxBuilder>>, index: number): void {
  builder.completeSync();
  const output = builder.meshTxBuilderBody.outputs[index]!;
  const coin = output.amount.find(asset => asset.unit === 'lovelace')!;
  const minimum = builder.calculateMinLovelaceForOutput(output);
  if (BigInt(coin.quantity) < minimum) coin.quantity = String(minimum);
}

/** Replaces the config datum. The validator checks the admin signatures and the bounds. */
export async function buildConfigUpdate(ctx: ChainContext, a: { payer: Payer; config: ConfigDatum; signers: string[] }): Promise<BuiltTx> {
  validateConfig(a.config);
  const encoded = encodeConfigDatum(a.config);
  const { network, scripts, refScripts } = ctx.deployment;
  const { utxo } = await readConfig(ctx);
  const builder = await newTxBuilder({ provider: ctx.provider, network });
  builder.spendingPlutusScriptV3().txIn(utxo.ref.txId, utxo.ref.index, utxoToMesh(utxo).output.amount, utxo.address, utxo.scriptRef?.size ?? 0)
    .spendingTxInReference(refScripts.config.txId, refScripts.config.index, String(scripts.config.size), scripts.config.hash)
    .txInInlineDatumPresent().txInRedeemerValue(encodeVoid(), 'CBOR')
    .txOut(utxo.address, utxoToMesh(utxo).output.amount).txOutInlineDatumValue(encoded, 'CBOR');
  for (const signer of new Set(a.signers.map(key => key.toLowerCase()))) builder.requiredSignerHash(signer);
  topUpMinimum(builder, 0);
  const references = await ctx.provider.getUtxos([refScripts.config]);
  return complete({ provider: ctx.provider, network }, builder, { payer: a.payer, extraUtxos: [utxo, ...references] });
}

/** Moves accrued fees from the pool to the treasury named in the config. Anyone can submit it. */
export async function buildCollectFees(ctx: ChainContext, a: { payer: Payer; amount: bigint }): Promise<BuiltTx> {
  if (typeof a.amount !== 'bigint' || a.amount <= 0n) throw new Error('Fee collection amount must be positive');
  const { network, scripts, refScripts, asset } = ctx.deployment;
  const { utxo, datum } = await readPool(ctx);
  if (a.amount > datum.feesAccrued) throw new Error('Fee collection amount exceeds accrued fees');
  const config = await readConfig(ctx);
  const builder = await newTxBuilder({ provider: ctx.provider, network });
  const amount = [meshAsset(asset, a.amount)];
  // A lovelace entry lets the treasury top-up draw its ADA from the payer.
  if (!isAdaAsset(asset)) amount.unshift({ unit: 'lovelace', quantity: '0' });
  builder.spendingPlutusScriptV3().txIn(utxo.ref.txId, utxo.ref.index, utxoToMesh(utxo).output.amount, utxo.address, utxo.scriptRef?.size ?? 0)
    .spendingTxInReference(refScripts.pool.txId, refScripts.pool.index, String(scripts.pool.size), scripts.pool.hash)
    .txInInlineDatumPresent().txInRedeemerValue(encodePoolRedeemer({ kind: 'CollectFees', amount: a.amount }), 'CBOR')
    .readOnlyTxInReference(config.utxo.ref.txId, config.utxo.ref.index)
    .txOut(utxo.address, utxoToMesh({ ...utxo, value: addAssetAmount(utxo.value, asset, -a.amount) }).output.amount)
    .txOutInlineDatumValue(encodePoolDatum({ ...datum, feesAccrued: datum.feesAccrued - a.amount }), 'CBOR')
    .txOut(addressToBech32(config.datum.treasury, network), amount);
  // Only the treasury receives a top-up: the pool must lose exactly the collected amount.
  topUpMinimum(builder, 1);
  const references = await ctx.provider.getUtxos([refScripts.pool]);
  return complete({ provider: ctx.provider, network }, builder, { payer: a.payer, extraUtxos: [utxo, config.utxo, ...references] });
}
