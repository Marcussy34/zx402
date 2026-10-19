import type { ClientCardanoSigner } from '@x402/cardano';
import { addressFromBech32, deriveOneTimeKey, NETWORKS } from '@zx402/crypto';
import { assetUnit, assetWireUnit, buildStealthPayment, enterpriseAddress, isAdaAsset, sellerMinimumLovelace, stealthFee,
  type ChainContext } from '@zx402/txlib';
import type { SettleReceipt } from './sdk.js';

interface Hooks {
  seed: Uint8Array;
  ctx: ChainContext;
  maxPrice?: bigint;
  index(): number;
  advance(): Promise<void>;
  exclusive<T>(operation: () => Promise<T>): Promise<T>;
  settle(a: { payouts: { address: string; amount: bigint }[]; minPayoutLovelace?: bigint }): Promise<SettleReceipt>;
  poll<T>(check: () => Promise<T | undefined>, description: string): Promise<T>;
}

/** Each signer shares the SDK counter and operation queue, so callers cannot reuse a key. */
export function stealthSigner(h: Hooks): ClientCardanoSigner {
  const network = h.ctx.deployment.network;
  const asset = h.ctx.deployment.asset;
  const adaPool = isAdaAsset(asset);
  if (h.maxPrice !== undefined && (typeof h.maxPrice !== 'bigint' || h.maxPrice < 0n)) throw new RangeError('Price limit must be nonnegative in pool asset units');
  return {
    getAddress() {
      const key = deriveOneTimeKey(h.seed, h.index());
      try { return enterpriseAddress(key, network); }
      finally { key.fill(0); }
    },
    buildAndSignPaymentTransaction: input => h.exclusive(async () => {
      if (input.network !== `cardano:${network}`) throw new Error('Payment network does not match the deployment');
      if (input.asset.toLowerCase() !== assetWireUnit(asset)) throw new Error('Payment asset does not match the pool asset');
      if (!/^[1-9][0-9]*$/.test(input.amount)) throw new Error('Payment amount must be a positive integer');
      if (!Number.isSafeInteger(input.maxTimeoutSeconds) || input.maxTimeoutSeconds <= 1) throw new Error('Payment timeout must exceed one second');
      if (input.extra?.assetTransferMethod !== undefined && input.extra.assetTransferMethod !== 'default') throw new Error('Only ordinary address payments are supported');
      addressFromBech32(input.payTo, network);
      const validForSlots = Math.min(240, Math.ceil(input.maxTimeoutSeconds * 1000 / NETWORKS[network].slotLength) - 1);
      const price = BigInt(input.amount);
      if (h.maxPrice !== undefined && price > h.maxPrice) throw new Error('Payment price exceeds the configured limit');
      const context = { provider: h.ctx.provider, network };
      const payment = { payTo: input.payTo, price, ...(adaPool ? {} : { asset }) };
      const fee = await stealthFee(context, payment);
      // Token prices exclude ADA, so the relayer must fund the seller minimum and fee separately.
      const need = adaPool ? 0n : fee + await sellerMinimumLovelace(context, payment);
      const payoutAmount = adaPool ? price + fee : price;
      const index = h.index();
      const key = deriveOneTimeKey(h.seed, index);
      let reserved = false;
      try {
        const address = enterpriseAddress(key, network);
        // Save before funding so a crash or a lost response cannot reuse this address.
        await h.advance();
        reserved = true;
        await h.settle({ payouts: [{ address, amount: payoutAmount }],
          ...(adaPool ? {} : { minPayoutLovelace: need }) });
        // A relayer reset can rebuild the Settle with a new hash. Each one-time address
        // is funded once, so address and value identify the funding output.
        const utxo = await h.poll(async () => (await h.ctx.provider.getUtxosAt(address)).find(u =>
          u.address === address
          && (adaPool ? u.value.lovelace === payoutAmount && Object.keys(u.value.assets).length === 0
            : u.value.lovelace >= need && u.value.assets[assetUnit(asset)] === price && Object.keys(u.value.assets).length === 1)
          && u.inlineDatum === null && u.datumHash === null && u.scriptRef === null),
        `confirmed funding for one-time key index ${index}`);
        const built = await buildStealthPayment(context, { ...payment, oneTimeUtxo: utxo, oneTimeSeed: key, validForSlots });
        await h.ctx.provider.evaluate(built.cbor);
        return { transaction: Buffer.from(built.cbor, 'hex').toString('base64'), nonce: `${utxo.ref.txId}#${utxo.ref.index}` };
      } catch (error) {
        if (!reserved) throw error;
        // Submission may have succeeded even when its response was lost.
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Stealth payment failed for one-time key index ${index}: ${reason}; check for funding and recover funds with that derivation index`, { cause: error });
      } finally { key.fill(0); }
    }),
  };
}
