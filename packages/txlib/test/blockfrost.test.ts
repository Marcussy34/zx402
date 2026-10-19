import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';
import { BlockfrostProvider, type BlockInfo, type UTxO } from '@meshsdk/core';
import {
  blockfrostProvider, providerFromMesh, utxoFromMesh, utxoToMesh, type MeshProviderLike,
} from '../src/providers/blockfrost.js';
import { ScriptFailure, SubmitRejected, type Utxo } from '../src/types.js';

const txId = '11'.repeat(32);
const address = 'addr_test1_fake';
const scriptHash = '8b8c11dcad0af38c40d742ed155b4c938acc5507a0ecbcfcea36496a';
const plain: UTxO = {
  input: { txHash: txId, outputIndex: 2 },
  output: { address, amount: [{ unit: 'lovelace', quantity: '9007199254740993' }] },
};
const plainUtxo: Utxo = {
  ref: { txId, index: 2 }, address,
  value: { lovelace: 9007199254740993n, assets: {} },
  inlineDatum: null, datumHash: null, scriptRef: null,
};
const tokens = [
  { unit: 'ab'.repeat(28) + '01', quantity: '12' },
  { unit: 'cd'.repeat(28) + '02', quantity: '9007199254740995' },
];
const withDatum: UTxO = {
  ...plain, output: { ...plain.output, amount: [...plain.output.amount, ...tokens], plutusData: 'd87980' },
};
const withScript: UTxO = {
  ...plain, output: { ...plain.output, scriptRef: '820343010203', scriptHash },
};
const block: BlockInfo = {
  time: 1720000000, hash: 'aa'.repeat(32), slot: '99999999', epoch: 400, epochSlot: '123',
  slotLeader: 'pool1fake', size: 100, txCount: 1, output: '1000000', fees: '200000',
  previousBlock: 'bb'.repeat(32), nextBlock: '', confirmations: 0, operationalCertificate: '', VRFKey: '',
};
const parameters = {
  min_fee_a: 45, min_fee_b: 155382, price_mem: 0.06, price_step: 0.00008,
  max_tx_size: 16385, max_tx_ex_mem: '17500000', max_tx_ex_steps: '10000000001',
  coins_per_utxo_size: '4311', collateral_percent: 151, max_collateral_inputs: 4,
  cost_models_raw: { PlutusV1: [1, -2], PlutusV2: [3, 0], PlutusV3: [5, 6] },
};
const expectedParameters = {
  minFeeA: 45n, minFeeB: 155382n, priceMem: 0.06, priceStep: 0.00008,
  maxTxSize: 16385, maxTxExMem: 17500000n, maxTxExSteps: 10000000001n,
  coinsPerUtxoByte: 4311n, collateralPercent: 151, maxCollateralInputs: 4,
  refScriptCostPerByte: 15, refScriptTierBytes: 25600, refScriptTierMultiplier: 1.2,
  costModels: parameters.cost_models_raw,
};
const rawOutput = (u: UTxO) => ({
  tx_hash: u.input.txHash, output_index: u.input.outputIndex, address: u.output.address,
  amount: u.output.amount, inline_datum: u.output.plutusData ?? null,
  data_hash: u.output.dataHash ?? null, reference_script_hash: u.output.scriptHash ?? null,
});
const notFound = JSON.stringify({ data: { status_code: 404, message: 'Not found' }, status: 404 });

test('TX-10 provider: missing or malformed raw cost models fail before transaction building', async () => {
  const invalid: unknown[] = [undefined, null, [], 'models'];
  for (const language of ['PlutusV1', 'PlutusV2', 'PlutusV3']) {
    for (const value of [undefined, null, {}, [], [1, '2'], [1.5], [NaN], [Infinity], [Number.MAX_SAFE_INTEGER + 1], Array(1)]) {
      invalid.push({ ...parameters.cost_models_raw, [language]: value });
    }
  }
  for (const cost_models_raw of invalid) {
    const provider = providerFromMesh(fake({ get: async () => ({ ...parameters, cost_models_raw }) }));
    await assert.rejects(provider.getProtocolParameters(), /cost_models_raw.*PlutusV[123]|cost_models_raw.*object/);
  }
});

function fake(overrides: Partial<MeshProviderLike> = {}): MeshProviderLike {
  const unexpected = async (): Promise<never> => { throw new Error('Unexpected Mesh method'); };
  return {
    get: unexpected, fetchUTxOs: unexpected, fetchLatestBlock: unexpected,
    evaluateTx: unexpected, submitTx: unexpected, ...overrides,
  };
}

// A missed fake must fail locally rather than reach an external service.
before(() => {
  mock.method(globalThis, 'fetch', async () => { throw new Error('Network disabled in Blockfrost tests'); });
  for (const method of ['get', 'fetchUTxOs', 'fetchLatestBlock', 'evaluateTx', 'submitTx'] as const) {
    mock.method(BlockfrostProvider.prototype, method, async () => { throw new Error('Missing Mesh fake'); });
  }
});
after(() => mock.restoreAll());

test('TX-09 provider: plain ADA conversion preserves bigint quantities in both directions', () => {
  assert.deepEqual(utxoFromMesh(plain), plainUtxo);
  assert.deepEqual(utxoToMesh(plainUtxo), plain);
});

test('TX-02 provider: two tokens and an inline datum round-trip', () => {
  const expected: Utxo = {
    ...plainUtxo, inlineDatum: 'd87980',
    value: { lovelace: 9007199254740993n, assets: { [tokens[0]!.unit]: 12n, [tokens[1]!.unit]: 9007199254740995n } },
  };
  assert.deepEqual(utxoFromMesh(withDatum), expected);
  assert.deepEqual(utxoToMesh(expected), withDatum);
});

test('TX-05 provider: reference scripts preserve CBOR, hash, and the script payload byte length', () => {
  const expected: Utxo = { ...plainUtxo, scriptRef: { hash: scriptHash, cbor: '820343010203', size: 3 } };
  assert.deepEqual(utxoFromMesh(withScript), expected);
  assert.deepEqual(utxoToMesh(expected), withScript);
  assert.equal(utxoFromMesh({ ...plain, output: { ...plain.output, scriptRef: '820343010203' } }).scriptRef?.hash, scriptHash);
});

test('TX-03 provider: hashed datums round-trip without inventing an inline datum', () => {
  const mesh = { ...plain, output: { ...plain.output, dataHash: 'ef'.repeat(32) } };
  const converted = utxoFromMesh(mesh);
  assert.equal(converted.inlineDatum, null);
  assert.equal(converted.datumHash, 'ef'.repeat(32));
  assert.deepEqual(utxoToMesh(converted), mesh);
});

test('TX-02 provider: address reads paginate and materialize reference scripts', async () => {
  const calls: string[] = [];
  const first = Array.from({ length: 100 }, (_, i) => rawOutput({ ...plain, input: { txHash: txId, outputIndex: i } }));
  const provider = providerFromMesh(fake({
    get: async path => {
      calls.push(path);
      if (path === `addresses/${address}/utxos?count=100&page=1`) return first;
      if (path === `addresses/${address}/utxos?count=100&page=2`) return [rawOutput(withScript)];
      throw new Error('Unexpected path');
    },
    fetchUTxOs: async (hash, index) => {
      assert.deepEqual([hash, index], [txId, 2]);
      return [withScript];
    },
  }));
  const utxos = await provider.getUtxosAt(address);
  assert.equal(utxos.length, 101);
  assert.equal(utxos[99]!.ref.index, 99);
  assert.deepEqual(utxos[100]!.scriptRef, { hash: scriptHash, cbor: '820343010203', size: 3 });
  assert.equal(calls.length, 2);
});

test('REL-05 provider: reference reads omit spent, unknown, and wrong-index outputs', async () => {
  const spent = { ...plain, input: { txHash: txId, outputIndex: 3 } };
  const unknownId = 'ff'.repeat(32);
  const calls: [string, number | undefined][] = [];
  const provider = providerFromMesh(fake({
    fetchUTxOs: async (hash, index) => {
      calls.push([hash, index]);
      if (hash === unknownId) throw notFound;
      return [spent, plain];
    },
    get: async path => {
      assert.equal(path, `addresses/${address}/utxos?count=100&page=1`);
      return [rawOutput(plain)];
    },
  }));
  assert.deepEqual(await provider.getUtxos([
    { txId, index: 3 }, { txId: unknownId, index: 0 }, { txId, index: 8 }, { txId, index: 2 },
  ]), [plainUtxo]);
  assert.deepEqual(calls, [[txId, 3], [unknownId, 0], [txId, 8], [txId, 2]]);
  assert.deepEqual(await provider.getUtxos([]), []);
});

test('REL-01 provider: live protocol values map correctly and absent reference fields use mainnet defaults', async () => {
  const provider = providerFromMesh(fake({ get: async path => {
    assert.equal(path, 'epochs/latest/parameters');
    return parameters;
  } }));
  assert.deepEqual(await provider.getProtocolParameters(), expectedParameters);
});

test('REL-01 provider: live reference fees override defaults, including a zero base price', async () => {
  const provider = providerFromMesh(fake({ get: async () => ({
    ...parameters, min_fee_ref_script_cost_per_byte: 0,
    ref_script_tier_bytes: 12800, ref_script_tier_multiplier: 1.3,
  }) }));
  assert.deepEqual(await provider.getProtocolParameters(), {
    ...expectedParameters, refScriptCostPerByte: 0, refScriptTierBytes: 12800, refScriptTierMultiplier: 1.3,
  });
});

test('REL-01 provider: legacy Blockfrost UTXO size field remains readable', async () => {
  const { coins_per_utxo_size: _omitted, ...legacy } = parameters;
  const provider = providerFromMesh(fake({ get: async () => ({ ...legacy, coins_per_utxo_word: '4312' }) }));
  assert.equal((await provider.getProtocolParameters()).coinsPerUtxoByte, 4312n);
});

test('TX-05 provider: latest block gives its slot, hash, and POSIX milliseconds', async () => {
  const provider = providerFromMesh(fake({ fetchLatestBlock: async () => block }));
  assert.deepEqual(await provider.getTip(), { slot: 99999999, time: 1720000000000, blockHash: 'aa'.repeat(32) });
});

test('REL-06 provider: evaluation passes converted additional UTXOs and returns every redeemer tag', async () => {
  const tags = ['SPEND', 'MINT', 'CERT', 'REWARD', 'VOTE', 'PROPOSE'] as const;
  const calls: unknown[][] = [];
  const provider = providerFromMesh(fake({ evaluateTx: async (...args) => {
    calls.push(args);
    return tags.map((tag, index) => ({ tag, index, budget: { mem: 123, steps: 456 } }));
  } }));
  assert.deepEqual(await provider.evaluate('cafe', [plainUtxo]),
    ['spend', 'mint', 'cert', 'reward', 'vote', 'propose'].map((tag, index) => ({ tag, index, mem: 123n, steps: 456n })));
  await provider.evaluate('beef');
  assert.deepEqual(calls, [['cafe', [plain]], ['beef', []]]);
});

test('REL-02 provider: submission returns the provider transaction ID', async () => {
  const provider = providerFromMesh(fake({ submitTx: async cbor => { assert.equal(cbor, 'cafe'); return txId; } }));
  assert.equal(await provider.submit('cafe'), txId);
});

test('TX-14 a 400 submit answer is SubmitRejected', async () => {
  // Model Mesh's Blockfrost wrapper: parseHttpError stringifies the axios answer.
  const answer = (message: string): string => JSON.stringify({
    data: { status_code: 400, error: 'Bad Request', message }, headers: {}, status: 400,
  });
  const submit = async (failure: unknown) => {
    let calls = 0;
    const provider = providerFromMesh(fake({ submitTx: async () => { calls += 1; throw failure; } }));
    const error = await provider.submit('cafe').then(() => null, (reason: unknown) => reason);
    return { error, calls };
  };
  const badInputs = await submit(answer('Bad Request (400): {"tag":"SubmitTransactionFailure","contents":{"error":"BadInputsUTxO"}}'));
  assert.ok(badInputs.error instanceof SubmitRejected);
  assert.equal(badInputs.error.reason, 'bad_inputs');
  const other = await submit(answer('Bad Request (400): {"tag":"SubmitTransactionFailure","contents":{"error":"ValueNotConservedUTxO"}}'));
  assert.ok(other.error instanceof SubmitRejected);
  assert.equal(other.error.reason, 'other');
  // A lost connection says nothing about whether a node took the transaction.
  const lost = await submit(new Error('socket hang up'));
  assert.ok(lost.error instanceof Error);
  assert.equal(lost.error instanceof SubmitRejected, false);
  assert.equal(lost.calls, 1);
});

test('TX-14 transactionStatus reads the chain, then the mempool', async () => {
  const read = async (found: 'txs' | 'mempool' | null) => {
    const calls: string[] = [];
    const provider = providerFromMesh(fake({ get: async (path: string) => {
      calls.push(path);
      if (found !== null && path.startsWith(`${found}/`)) return { tx_hash: txId };
      throw notFound;
    } }));
    return { status: await provider.transactionStatus(txId), calls };
  };
  assert.deepEqual(await read('txs'), { status: 'confirmed', calls: [`txs/${txId}`] });
  assert.deepEqual(await read('mempool'), { status: 'mempool', calls: [`txs/${txId}`, `mempool/${txId}`] });
  assert.deepEqual(await read(null), { status: 'unknown', calls: [`txs/${txId}`, `mempool/${txId}`] });
  // A 404 is an answer; anything else is a failed read.
  const broken = providerFromMesh(fake({ get: async () => { throw { status: 500, message: 'upstream failed' }; } }));
  await assert.rejects(broken.transactionStatus(txId), /upstream failed/);
});

test('REL-03 provider: nested Mesh script failures become ScriptFailure with traces', async () => {
  const failure = { result: { EvaluationFailure: { ScriptFailures: {
    'spend:0': [{ validatorFailed: { error: 'Validation failed', traces: ['bad datum'] } }],
  } } } };
  const provider = providerFromMesh(fake({ evaluateTx: async () => { throw JSON.stringify(JSON.stringify(failure)); } }));
  await assert.rejects(provider.evaluate('cafe'), error => {
    assert.ok(error instanceof ScriptFailure);
    assert.match(error.message, /Validation failed/);
    assert.deepEqual(error.traces, ['bad datum']);
    return true;
  });
});

test('REL-03 provider: infrastructure and input-resolution failures remain plain errors', async () => {
  for (const failure of [
    new Error('Provider unavailable'),
    JSON.stringify({ data: { message: 'Provider unavailable', status_code: 500 }, status: 500 }),
    { message: 'Provider unavailable' },
    { result: { EvaluationFailure: { UnknownInputs: ['Provider unavailable'] } } },
  ]) {
    const provider = providerFromMesh(fake({ evaluateTx: async () => { throw failure; } }));
    await assert.rejects(provider.evaluate('cafe'), error => {
      assert.ok(error instanceof Error);
      assert.equal(error.constructor, Error);
      assert.match(error.message, /Provider unavailable/);
      return true;
    });
  }
});

test('REL-05 provider: address 404 is empty but server errors remain visible', async () => {
  assert.deepEqual(await providerFromMesh(fake({ get: async () => { throw notFound; } })).getUtxosAt(address), []);
  await assert.rejects(providerFromMesh(fake({ get: async () => { throw { message: 'rate limited', status: 429 }; } })).getUtxosAt(address), /rate limited/);
  await assert.rejects(providerFromMesh(fake({ fetchUTxOs: async () => { throw new Error('reference lookup failed'); } })).getUtxos([plainUtxo.ref]), /reference lookup failed/);
});

test('REL-02 provider: network validation rejects mismatches without exposing the project ID', () => {
  for (const projectId of ['mainnet_marker_secret', 'preview_marker_secret', 'marker_secret', '']) {
    assert.throws(() => blockfrostProvider(projectId, 'preprod'), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /project ID.*preprod/i);
      if (projectId) assert.equal(error.message.includes(projectId), false);
      return true;
    });
  }
  assert.ok(blockfrostProvider('preprod_marker_secret', 'preprod'));
  assert.ok(blockfrostProvider('mainnet_marker_secret', 'mainnet'));
});

test('REL-03 provider: every factory method redacts credentials from errors and script traces', async t => {
  const projectId = 'preprod_marker_secret';
  const leaked = `Provider failed with ${projectId}`;
  t.mock.method(BlockfrostProvider.prototype, 'get', async () => { throw leaked; });
  t.mock.method(BlockfrostProvider.prototype, 'fetchUTxOs', async () => { throw leaked; });
  t.mock.method(BlockfrostProvider.prototype, 'fetchLatestBlock', async () => { throw new Error(leaked); });
  t.mock.method(BlockfrostProvider.prototype, 'submitTx', async () => { throw { message: leaked }; });
  t.mock.method(BlockfrostProvider.prototype, 'evaluateTx', async () => { throw new ScriptFailure(leaked, [leaked]); });
  const provider = blockfrostProvider(projectId, 'preprod');
  const reads = [
    () => provider.getUtxosAt(address), () => provider.getUtxos([plainUtxo.ref]),
    () => provider.getProtocolParameters(), () => provider.getTip(),
    () => provider.evaluate('cafe'), () => provider.submit('cafe'),
    () => provider.getTransactionsAt(address), () => provider.getTransactionCbor(txId),
  ];
  for (const read of reads) await assert.rejects(read(), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Provider failed/);
    assert.equal(String(error.stack).includes(projectId), false);
    assert.equal(JSON.stringify(error).includes(projectId), false);
    return true;
  });
});

test('IDX-01 provider: history follows two pages, keeps block order, and resumes after a transaction ID', async t => {
  const records = Array.from({ length: 102 }, (_, i) => ({ tx_hash: i.toString(16).padStart(64, '0'), block_height: 10 + Math.floor(i / 2), tx_index: i % 2 }));
  const calls: string[] = [];
  t.mock.method(BlockfrostProvider.prototype, 'get', async (path: string) => {
    calls.push(path);
    if (path === `addresses/${address}/transactions?order=asc&count=100&page=1`) return records.slice(0, 100);
    if (path === `addresses/${address}/transactions?order=asc&count=100&page=2`) return records.slice(100);
    throw new Error('Unexpected history path');
  });
  const provider = blockfrostProvider('preprod_marker_secret', 'preprod');
  const expected = records.map(r => ({ txId: r.tx_hash, blockHeight: r.block_height, indexInBlock: r.tx_index }));
  assert.deepEqual(await provider.getTransactionsAt(address), expected);
  assert.equal(calls.length, 2);
  assert.deepEqual(await provider.getTransactionsAt(address, records[99]!.tx_hash), expected.slice(100));
  assert.deepEqual(await provider.getTransactionsAt(address, records[101]!.tx_hash), []);
  await assert.rejects(provider.getTransactionsAt(address, 'unknown'), /cursor|after|transaction.*not found/i);
});

test('IDX-01 provider: unseen address history is empty, while a missing transaction CBOR throws', async t => {
  t.mock.method(BlockfrostProvider.prototype, 'get', async () => { throw notFound; });
  const provider = blockfrostProvider('preprod_marker_secret', 'preprod');
  assert.deepEqual(await provider.getTransactionsAt(address), []);
  await assert.rejects(provider.getTransactionCbor(txId), /Not found/);
});

test('IDX-01 provider: transaction CBOR returns the response hex', async t => {
  t.mock.method(BlockfrostProvider.prototype, 'get', async (path: string) => {
    assert.equal(path, `txs/${txId}/cbor`);
    return { cbor: '84a1000180f5f6' };
  });
  assert.equal(await blockfrostProvider('mainnet_marker_secret', 'mainnet').getTransactionCbor(txId), '84a1000180f5f6');
});

test('TX-05 provider: a request-level failure is retried, and a submit never is', async () => {
  // Mesh's error handler names XMLHttpRequest, which Node lacks, so a lost connection surfaces as that ReferenceError.
  let tips = 0;
  const provider = providerFromMesh(fake({
    fetchLatestBlock: async () => { tips += 1; if (tips === 1) throw new ReferenceError('XMLHttpRequest is not defined'); return block; },
    submitTx: async () => { throw new ReferenceError('XMLHttpRequest is not defined'); },
  }));
  assert.equal((await provider.getTip()).slot, 99999999);
  assert.equal(tips, 2, 'The second attempt must answer');
  await assert.rejects(provider.submit('00'), /XMLHttpRequest/);
});
