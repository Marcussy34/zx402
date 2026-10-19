import { BlockfrostProvider, type UTxO } from '@meshsdk/core';
import { deserializeScriptRef } from '@meshsdk/core-cst';
import type { CostModels } from '../cost-models.js';
import type { ChainHistory, TxRecord } from '../history.js';
import {
  MAINNET_PARAMETERS, ScriptFailure, SubmitRejected, type Network, type Provider,
  type RedeemerTag, type TxStatus, type TxStatusReader, type Utxo,
} from '../types.js';

/** The Mesh methods used by this adapter. Tests supply the same interface. */
export interface MeshProviderLike {
  get: BlockfrostProvider['get'];
  post: BlockfrostProvider['post'];
  fetchUTxOs: BlockfrostProvider['fetchUTxOs'];
  fetchLatestBlock: BlockfrostProvider['fetchLatestBlock'];
  evaluateTx: BlockfrostProvider['evaluateTx'];
  submitTx: BlockfrostProvider['submitTx'];
}

function readCostModels(raw: unknown): CostModels {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('Invalid cost_models_raw: expected an object with PlutusV1, PlutusV2, and PlutusV3 lists');
  }
  const read = (language: keyof CostModels): number[] => {
    const costs = (raw as Record<string, unknown>)[language];
    // Copy before validation so a sparse array cannot skip missing entries.
    if (!Array.isArray(costs) || costs.length === 0 || ![...costs].every(Number.isSafeInteger)) {
      throw new Error(`Invalid cost_models_raw.${language}: expected a nonempty list of safe integers`);
    }
    return [...costs];
  };
  return { PlutusV1: read('PlutusV1'), PlutusV2: read('PlutusV2'), PlutusV3: read('PlutusV3') };
}

/** Converts Mesh's decimal quantities without passing through JavaScript numbers. */
export function utxoFromMesh(u: UTxO): Utxo {
  const { output } = u;
  let scriptRef: Utxo['scriptRef'] = null;
  if (output.scriptRef) {
    const script = deserializeScriptRef(output.scriptRef);
    const plutus = script.asPlutusV1() ?? script.asPlutusV2() ?? script.asPlutusV3();
    const bytes = plutus?.rawBytes() ?? script.asNative()?.toCbor();
    if (!bytes) throw new Error('Unsupported reference script');
    // Plutus fees count payload bytes, excluding the CBOR byte-string wrapper.
    scriptRef = { hash: script.hash(), cbor: output.scriptRef, size: bytes.length / 2 };
  }
  return {
    ref: { txId: u.input.txHash, index: u.input.outputIndex }, address: output.address,
    value: {
      lovelace: BigInt(output.amount.find(a => a.unit === 'lovelace')?.quantity ?? '0'),
      assets: Object.fromEntries(output.amount.filter(a => a.unit !== 'lovelace').map(a => [a.unit, BigInt(a.quantity)])),
    },
    inlineDatum: output.plutusData ?? null, datumHash: output.dataHash ?? null, scriptRef,
  };
}

/** Converts the neutral UTXO into the format accepted by Mesh builders and evaluators. */
export function utxoToMesh(u: Utxo): UTxO {
  return {
    input: { txHash: u.ref.txId, outputIndex: u.ref.index },
    output: {
      address: u.address,
      amount: [
        { unit: 'lovelace', quantity: u.value.lovelace.toString() },
        ...Object.entries(u.value.assets).map(([unit, quantity]) => ({ unit, quantity: quantity.toString() })),
      ],
      ...(u.inlineDatum === null ? {} : { plutusData: u.inlineDatum }),
      ...(u.datumHash === null ? {} : { dataHash: u.datumHash }),
      ...(u.scriptRef === null ? {} : { scriptRef: u.scriptRef.cbor, scriptHash: u.scriptRef.hash }),
    },
  };
}

/** One additional UTXO as the input and output pair in Ogmios v5 JSON. */
export type OgmiosAdditionalUtxo = [
  { txId: string; index: number },
  {
    address: string;
    value: { coins: number; assets?: Record<string, number> };
    datumHash?: string;
    datum?: string;
  },
];

// The evaluate endpoint takes JSON numbers, so a quantity must fit a safe integer.
function ogmiosQuantity(quantity: bigint, unit: string): number {
  if (quantity < 0n || quantity > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Quantity of ${unit} does not fit a safe integer`);
  }
  return Number(quantity);
}

/**
 * Converts a UTXO to the Ogmios v5 shape Blockfrost evaluates.
 * Mesh 1.9.1 drops datums and nests assets by policy, so adapters send this body themselves.
 */
export function ogmiosAdditionalUtxo(u: Utxo): OgmiosAdditionalUtxo {
  // A dropped reference script would change the evaluation result, so refuse it loudly.
  if (u.scriptRef !== null) throw new Error('A reference script in an additional UTXO cannot be evaluated');
  const assets: Record<string, number> = {};
  for (const [unit, quantity] of Object.entries(u.value.assets)) {
    // A unit is the 56-character policy ID followed by the asset name, which may be empty.
    const policy = unit.slice(0, 56), name = unit.slice(56);
    assets[name ? `${policy}.${name}` : policy] = ogmiosQuantity(quantity, unit);
  }
  return [
    { txId: u.ref.txId, index: u.ref.index },
    {
      address: u.address,
      value: {
        coins: ogmiosQuantity(u.value.lovelace, 'lovelace'),
        ...(Object.keys(assets).length === 0 ? {} : { assets }),
      },
      ...(u.inlineDatum === null ? {} : { datum: u.inlineDatum }),
      ...(u.datumHash === null ? {} : { datumHash: u.datumHash }),
    },
  ];
}

// Mesh can stringify a provider error twice before throwing it.
function errorPayload(error: unknown): unknown {
  let payload = error instanceof Error ? error.message : error;
  while (typeof payload === 'string') {
    try {
      const parsed: unknown = JSON.parse(payload);
      if (parsed === payload) break;
      payload = parsed;
    } catch { break; }
  }
  return payload;
}

/** True when Blockfrost answered with this HTTP status, at any nesting level Mesh adds. */
function isStatus(error: unknown, status: number): boolean {
  const payload = errorPayload(error);
  if (!payload || typeof payload !== 'object') return false;
  const record = payload as Record<string, unknown>;
  return record.status === status || record.status_code === status || isStatus(record.data, status) || isStatus(record.response, status);
}

function isNotFound(error: unknown): boolean {
  return isStatus(error, 404);
}

function providerError(error: unknown, projectId: string): Error {
  const redact = (text: string) => projectId ? text.split(projectId).join('[redacted]') : text;
  const payload = errorPayload(error);
  let scriptFailed = error instanceof ScriptFailure;
  const traces = error instanceof ScriptFailure ? [...error.traces] : [];
  function inspect(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'ScriptFailures' || key === 'scriptFailures' || key === 'validatorFailed') scriptFailed = true;
      if (key === 'traces' && Array.isArray(child)) traces.push(...child.filter((trace): trace is string => typeof trace === 'string'));
      else inspect(child);
    }
  }
  inspect(payload);
  const message = redact(typeof payload === 'string' ? payload : JSON.stringify(payload) ?? 'Blockfrost request failed');
  // Rebuild errors so neither their stack nor a nested cause carries credentials.
  return scriptFailed ? new ScriptFailure(message, traces.map(redact)) : new Error(message);
}

/** Blockfrost answers 400 when the node refuses the transaction. Every other failure is an unknown outcome. */
function submitRejected(error: unknown, projectId: string): SubmitRejected | null {
  if (!isStatus(error, 400)) return null;
  const message = providerError(error, projectId).message;
  return new SubmitRejected(message, message.includes('BadInputsUTxO') ? 'bad_inputs' : 'other');
}

/** A request-level failure, before any answer from Blockfrost: a lost connection, a timeout, an overloaded gateway. */
function transient(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  // Mesh's error handler references XMLHttpRequest, which Node lacks, so every request-level error reads as that.
  return /XMLHttpRequest is not defined|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|network error|timeout of \d+ms|status code 5\d\d|status code 429/i.test(message);
}

/** Reads retry a transient failure a few times; a submit never does, so one transaction is never sent twice. */
async function request<T>(action: () => Promise<T>, projectId: string, retries = 3): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await action(); }
    catch (error) {
      // A refused submit is a known outcome. Keep its class and its already-redacted message.
      if (error instanceof SubmitRejected) throw error;
      if (attempt >= retries || !transient(error)) throw providerError(error, projectId);
      await new Promise(resolve => setTimeout(resolve, 1_500 * (attempt + 1)));
    }
  }
}

interface AddressOutput {
  tx_hash: string; output_index: number; address: string; amount: UTxO['output']['amount'];
  data_hash: string | null; inline_datum: string | null; reference_script_hash: string | null;
}

/** A short page ends the scan. Only address lookups treat 404 as an empty page. */
async function addressPages<T>(mesh: MeshProviderLike, path: string): Promise<T[]> {
  const records: T[] = [];
  const separator = path.includes('?') ? '&' : '?';
  for (let page = 1; ; page++) {
    let entries: T[];
    try { entries = await mesh.get(`${path}${separator}count=100&page=${page}`) as T[]; }
    catch (error) {
      if (isNotFound(error)) return records;
      throw error;
    }
    records.push(...entries);
    if (entries.length < 100) return records;
  }
}

function adapt(mesh: MeshProviderLike, projectId: string): Provider & TxStatusReader {
  const outputsAt = (address: string) => addressPages<AddressOutput>(mesh, `addresses/${encodeURIComponent(address)}/utxos`);
  return {
    getUtxosAt: address => request(async () => {
      // Mesh 1.9.1 fetchAddressUTxOs swallows every error, including authorization failures.
      const outputs = await outputsAt(address);
      const utxos: Utxo[] = [];
      for (const output of outputs) {
        if (output.reference_script_hash) {
          const candidates = await mesh.fetchUTxOs(output.tx_hash, output.output_index);
          const candidate = candidates.find(u => u.input.txHash === output.tx_hash && u.input.outputIndex === output.output_index);
          if (!candidate?.output.scriptRef) throw new Error('Reference script was not returned by Blockfrost');
          utxos.push(utxoFromMesh(candidate));
        } else {
          utxos.push(utxoFromMesh({
            input: { txHash: output.tx_hash, outputIndex: output.output_index },
            output: {
              address: output.address, amount: output.amount,
              dataHash: output.data_hash ?? undefined, plutusData: output.inline_datum ?? undefined,
            },
          }));
        }
      }
      return utxos;
    }, projectId),
    getUtxos: refs => request(async () => {
      const utxos: Utxo[] = [];
      for (const ref of refs) {
        let candidates: UTxO[];
        try { candidates = await mesh.fetchUTxOs(ref.txId, ref.index); }
        catch (error) {
          if (isNotFound(error)) continue;
          throw error;
        }
        const candidate = candidates.find(u => u.input.txHash === ref.txId && u.input.outputIndex === ref.index);
        if (!candidate) continue;
        // Transaction outputs remain queryable after spending. Confirm their unspent status.
        const unspent = await outputsAt(candidate.output.address);
        if (unspent.some(u => u.tx_hash === ref.txId && u.output_index === ref.index)) utxos.push(utxoFromMesh(candidate));
      }
      return utxos;
    }, projectId),
    getProtocolParameters: () => request(async () => {
      // Mesh's typed parameter method drops the live reference-script price.
      const p = await mesh.get('epochs/latest/parameters');
      return {
        costModels: readCostModels(p.cost_models_raw),
        minFeeA: BigInt(p.min_fee_a), minFeeB: BigInt(p.min_fee_b),
        priceMem: Number(p.price_mem), priceStep: Number(p.price_step),
        maxTxSize: Number(p.max_tx_size), maxTxExMem: BigInt(p.max_tx_ex_mem), maxTxExSteps: BigInt(p.max_tx_ex_steps),
        coinsPerUtxoByte: BigInt(p.coins_per_utxo_size ?? p.coins_per_utxo_word),
        collateralPercent: Number(p.collateral_percent), maxCollateralInputs: Number(p.max_collateral_inputs),
        refScriptCostPerByte: Number(p.min_fee_ref_script_cost_per_byte ?? MAINNET_PARAMETERS.refScriptCostPerByte),
        refScriptTierBytes: Number(p.ref_script_tier_bytes ?? MAINNET_PARAMETERS.refScriptTierBytes),
        refScriptTierMultiplier: Number(p.ref_script_tier_multiplier ?? MAINNET_PARAMETERS.refScriptTierMultiplier),
      };
    }, projectId),
    getTip: () => request(async () => {
      const block = await mesh.fetchLatestBlock();
      return { slot: Number(block.slot), blockHash: block.hash, time: block.time * 1000 };
    }, projectId),
    evaluate: (txCbor, additionalUtxos = []) => request(async () => {
      if (additionalUtxos.length === 0) {
        const actions = await mesh.evaluateTx(txCbor, []);
        const tags: Record<(typeof actions)[number]['tag'], RedeemerTag> = {
          SPEND: 'spend', MINT: 'mint', CERT: 'cert', REWARD: 'reward', VOTE: 'vote', PROPOSE: 'propose',
        };
        return actions.map(action => {
          const tag = tags[action.tag];
          if (!tag) throw new Error('Unsupported evaluation redeemer tag');
          return { tag, index: action.index, mem: BigInt(action.budget.mem), steps: BigInt(action.budget.steps) };
        });
      }
      // Mesh 1.9.1 sends an incomplete additional UTXO set, so post the Ogmios v5 body directly.
      const body = await mesh.post('utils/txs/evaluate/utxos', {
        cbor: txCbor, additionalUtxoSet: additionalUtxos.map(ogmiosAdditionalUtxo),
      });
      const rated = body?.result?.EvaluationResult as Record<string, { memory: number; steps: number }> | undefined;
      // Let providerError inspect the body so an EvaluationFailure becomes a ScriptFailure.
      if (!rated) throw new Error(JSON.stringify(body));
      const tags: Record<string, RedeemerTag> = {
        spend: 'spend', mint: 'mint', certificate: 'cert', withdrawal: 'reward',
      };
      return Object.entries(rated).map(([key, budget]) => {
        const [purpose, index] = key.split(':');
        const tag = tags[purpose!];
        if (!tag) throw new Error('Unsupported evaluation redeemer tag');
        return { tag, index: Number(index), mem: BigInt(budget.memory), steps: BigInt(budget.steps) };
      });
    }, projectId),
    transactionStatus: (txId): Promise<TxStatus> => request(async () => {
      const hash = encodeURIComponent(txId);
      // A confirmed transaction is indexed before it leaves the mempool view.
      try { await mesh.get(`txs/${hash}`); return 'confirmed'; }
      catch (error) { if (!isNotFound(error)) throw error; }
      try { await mesh.get(`mempool/${hash}`); return 'mempool'; }
      catch (error) { if (!isNotFound(error)) throw error; }
      return 'unknown';
    }, projectId),
    submit: txCbor => request(async () => {
      try { return await mesh.submitTx(txCbor); }
      catch (error) { throw submitRejected(error, projectId) ?? error; }
    }, projectId, 0),
  };
}

/** The same adapter over an injected Mesh implementation, without credentials. */
export function providerFromMesh(mesh: MeshProviderLike): Provider & TxStatusReader {
  return adapt(mesh, '');
}

/** Creates an uncached provider for the network encoded in the project ID. */
export function blockfrostProvider(projectId: string, network: Network): Provider & ChainHistory & TxStatusReader {
  if (!projectId.startsWith(network) || projectId.length <= network.length) {
    throw new Error(`Blockfrost project ID must belong to ${network}`);
  }
  let mesh: BlockfrostProvider;
  try { mesh = new BlockfrostProvider(projectId, 0, { enableCaching: false }); }
  catch (error) { throw providerError(error, projectId); }
  return {
    ...adapt(mesh, projectId),
    getTransactionsAt: (address: string, after?: string) => request(async () => {
      const records = await addressPages<{ tx_hash: string; block_height: number; tx_index: number }>(
        mesh, `addresses/${encodeURIComponent(address)}/transactions?order=asc`,
      );
      const transactions: TxRecord[] = records.map(record => ({
        txId: record.tx_hash, blockHeight: record.block_height, indexInBlock: record.tx_index,
      }));
      if (after === undefined) return transactions;
      const cursor = transactions.findIndex(record => record.txId === after);
      // A vanished cursor can indicate rollback. Do not silently skip or replay history.
      if (cursor < 0) throw new Error('History cursor transaction was not found at the address');
      return transactions.slice(cursor + 1);
    }, projectId),
    getTransactionCbor: (txId: string) => request(async () => {
      const result = await mesh.get(`txs/${encodeURIComponent(txId)}/cbor`);
      if (typeof result?.cbor !== 'string') throw new Error('Blockfrost did not return transaction CBOR');
      return result.cbor;
    }, projectId),
  };
}
