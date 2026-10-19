# zx402: Runbook

| Field | Value |
|---|---|
| Status | v1.1, 2026-10-07. M0 tUSDM settings |
| Goal | Run the whole product on Preprod, then prove every flow on mainnet with capped team funds |
| Companions | [SPEC.md](./SPEC.md), [CEREMONY.md](./CEREMONY.md), [TEST-PLAN.md](./TEST-PLAN.md), [measurements.md](./measurements.md), [SETUP.md](./SETUP.md) |

The ADA flow ran on Preprod on 2026-10-06 with the code of this repository.
The transaction hashes of that run are in [measurements.md](./measurements.md), section 3.
M0 now uses tUSDM. The deploy command, SDK signer, demo and seller support the pool's asset.
The [mainnet canary](#11-mainnet-canary) uses the same commands with `NETWORK=mainnet`.

## 1. What you need

- Node.js 22 or newer.
- A Blockfrost project for Preprod. The free plan is enough. Section 8 explains the quota.
- A new 32-byte key for the operator. `openssl rand -hex 32` makes one.
- About 300 test ADA from the Preprod faucet for that key. Step 3 of section 3 shows its address.
- At least 10 tUSDM for the `user` role in the token demo. Section 3 identifies the exact asset.

CAUTION: use a new key. Never put the key of a real wallet into this project.

## 2. Build once

1. Install the tools: `npm ci`
2. Compile the circuits: `npm run build:circuits`
3. Make the development keys: `npm run setup:dev`

Step 3 takes about 30 minutes the first time. It also makes the phase 1 file that the network key setup reuses.

## 3. Deploy a pool

The token deployment setting is `POOL_ASSET=<unit>` in `.env`. For the tUSDM pool, use:

```text
POOL_ASSET=16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde.0014df10745553444d
```

This is the Masumi test USDM, with 6 decimals. An unset `POOL_ASSET` selects ADA.
The limits stay at 5,000,000, 50,000,000 and 500,000,000 base units: 5, 50 and 500 tUSDM.

1. Copy `.env.example` to `.env`.
2. Set `NETWORK=preprod`, `BLOCKFROST_PROJECT_ID`, and `OPERATOR_SEED_HEX` in `.env`.
3. Print the addresses and the cost: `npm run ops:deploy -- --dry-run`
4. Send test ADA from the faucet to the `operator` address that step 3 printed.
5. Make the proving keys for this network: `npm run ops:setup`
6. Deploy: `npm run ops:deploy`

CAUTION: `.env` holds a signing key. Git ignores the file. Never commit it and never paste it anywhere.

CAUTION: step 5 is a key setup by one party. Whoever runs it could forge proofs by keeping its randomness. That is acceptable on a test network, and on mainnet only for capped funds of the team itself.

Step 5 takes about 4 minutes. It writes the proving keys to `circuits/build/keys-preprod/` and the verification keys to `deployments/preprod/keys/`.

CAUTION: back up the folder with the proving keys before step 6. Git ignores it, and no setup run can make the same keys again.
Without the proving keys of a pool, nobody can insert, pay or exit, and the notes in that pool stay locked.
A deposit that is not inserted yet can still be refunded, because a refund needs no proof.

Step 5 never replaces a complete set of keys. If the folder already holds the three key files, the command keeps them and says so.
Changing only the pool asset keeps those proving keys valid, because the circuits do not depend on the asset.
The validators stay unchanged, but a new asset parameter gives the token pool a new pool ID.
To make keys for another pool, move the folder away first. Keep it for as long as the old pool holds funds.
Step 6 submits four transactions and takes about 3.5 minutes. It writes the record `deployments/preprod.json`.
A deployment costs about 245 test ADA. Of that, 160 goes to the role keys of the crank, the relayer, the association service and the test user, and 73.6 stays in the four reference script outputs.

For the token demo, send at least 10 tUSDM to the `user` address printed in step 3. Deployment funds role keys with ADA only.
Keep ADA in that wallet too. A token deposit needs about 1.4 ADA for its output plus the network fee.
The crank keeps the attached ADA and takes no crank fee in tokens. An exit also needs the wallet to supply its output's minimum ADA.

If `deployments/preprod.json` already exists, step 6 stops.
This repository holds the record of the tUSDM pool from 2026-10-07, pool ID `60279ebfb8db22bbe0cb2a1b7a61702ab36ade074a3866ac836df3ed`. To use that pool you need its proving keys, which are not in the repository. To deploy your own pool, move the record away first.
The ADA pool of 2026-10-06 and the first tUSDM pool of 2026-10-07, both deployed before the protocol strings took the name zx402, are retired; their records are in `deployments/retired/`.
Archive a retired pool's record before deploying its replacement. Section 10 explains how the record selects the reference outputs for a sweep.

## 4. Run the node

1. Start the node: `npm run node -w ops`

The node runs the indexer, the crank, the association service and the relayer in one process.
It serves the indexer on `http://127.0.0.1:4010` and the relayer on `http://127.0.0.1:4011`.
It logs one line for each round that did something, for example an Insert or an association update.
A line such as `indexer: Chain tip changed during sync` is normal. The next round succeeds.
Stop the node with Ctrl+C.

The node reads five optional settings from the environment:

- `ZX402_INTERVAL_MS` is the pause between two rounds in milliseconds. The default is 10000.
- `ZX402_IDLE_RETRY_MS` is the time before the crank or the association service repeats a step that submitted nothing, while its input data is unchanged. The default is 20000.
- `ZX402_INDEXER_PORT` is the port of the indexer. The default is 4010.
- `ZX402_RELAYER_PORT` is the port of the relayer. The default is 4011.
- `ZX402_MAX_PENDING` is how many pool transactions the node may chain, from 1 to 8. The default is 1.

A value above 1 lets a new pool transaction build on one that is still pending, so several payments can land in one block.
CAUTION: run the admin command only when the node has nothing pending. Otherwise pending Settles drop, and the node rebuilds them.

In a token pool the relayer's change also holds its fee tokens, so it is never ADA-only. Keep one ADA-only output of at least 5 ADA in the relayer wallet for collateral, apart from the ADA it spends. Without it every Settle fails with `Payer needs an ADA-only collateral UTXO with at least 5 ADA`. The burst command adds this output when it is missing.

## 5. Run a seller

The token seller settings are:

```text
SELLER_PRICE_ASSET=16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde.0014df10745553444d
SELLER_PRICE_AMOUNT=2000000
```

Set these in the seller's environment for a price of 2 tUSDM.
The x402 package's default Preprod USDM policy starts with `e675b46e`; it is not this asset.
The seller must price in the pool's exact unit, and the buyer must list that unit in `allowedAssets`.

1. Start the example seller in a second terminal: `SELLER_ADDRESS=<address> npm run seller -w examples/x402-seller`

Use the `seller` address that step 3 of section 3 printed, or any Preprod address you own.
The seller is the stock x402 server with its stock facilitator. It knows nothing about the pool.
It sells `GET /weather` on `http://127.0.0.1:4021`.

## 6. Play the story

1. Run the demo in a third terminal: `npm run demo -w ops`

The demo does this, and prints each transaction:

1. It deposits 10 tUSDM from the `user` role key, with minimum ADA from that wallet.
2. It waits until the crank inserted the deposit and the association service approved it.
3. It asks the seller for the weather, gets HTTP 402, and pays through the stock x402 client with the SDK's stealth signer. The pool pays a new one-time address, and that address pays the seller.
4. It prints the weather.
5. It exits the rest of the note in public, back to the `user` key.

The retired ADA demo took 3.5 minutes on Preprod. Slow blocks can double that.
The user pays 2 tUSDM for the weather and a 1 tUSDM relayer fee.
The relayer funds each payout with 2 ADA by default. Leg 2 sends the seller the tokens and all that ADA minus its fee.
The relayer spends about 0.70 ADA on its network fee, in addition to the payout ADA. `docs/measurements.md` holds the live tUSDM runs.
Before proving, the SDK rejects a quote below the seller output's minimum ADA plus the leg 2 fee, about 1.4 ADA.

The token demo keeps its notes in `deployments/<network>/demo-store-<first 8 hex of the pool ID>.json`.
Keep that file and back it up. Without it the demo still works, because the SDK finds its old deposits on chain and takes new secrets. But a change note that was still in the pool is then out of reach.
If you changed a port, set `INDEXER_URL`, `RELAYER_URL` or `SELLER_URL` for the demo.

Two flags stage a short demo: `npm run demo -w ops -- --no-exit` leaves the change note in the pool, and `npm run demo -w ops -- --reuse` pays from the largest spendable note without a deposit.

To pay a Masumi agent from the pool, run your own Masumi payment service node, then `MASUMI_API_KEY=<admin key> MASUMI_PURCHASE_WALLET=<purchasing wallet address> npm run masumi -w ops -- --agent <registry asset> --input '<json>'`. The pool pays the purchasing wallet in private, and the Masumi node locks the escrow for the job. Add `--deposit` for a fresh 10 tUSDM deposit first; the command prints the explorer links at the end.

## 7. Admin actions

- Pool status and every role address with its balance: `npm run admin -w ops -- status`
- Pause deposits: `npm run admin -w ops -- pause`
- Allow deposits again: `npm run admin -w ops -- unpause`
- Collect accrued fees for the treasury: `npm run admin -w ops -- collect-fees`
- Wind a pool down: `npm run admin -w ops -- sweep-references --yes`

CAUTION: `sweep-references` spends the reference script outputs of the pool back to the operator. After it, nobody can use the pool. Pause deposits and exit every note first.

Exits cannot be paused. A paused pool still serves private payments and Ragequit.
In a token pool, fee collection sends tokens to the treasury. The submitter supplies the treasury output's minimum ADA.

## 8. Provider quota

Every read of the chain is a request to Blockfrost. The free plan allows 50,000 requests a day.

These numbers were measured on the Preprod pool of this repository, which had about 20 transactions.

- A round of the node that finds no new block makes 1 request.
- A round after a new block makes 8 requests.
- For two minutes after a change, the node reads each new block a second time. That adds 7 requests per block.
- A node that submits nothing uses about 1,100 to 1,600 requests an hour.
- A start of the node replays the pool history once. That took 33 requests for 17 pool transactions.
- One demo run adds about 150 to 200 requests in the node.

So an idle node needs about 27,000 to 39,000 requests a day. That fits the free plan and leaves room for some dozens of demo runs.
No run of a whole day has confirmed this yet.
The demo and the seller's facilitator use the same Blockfrost project and make their own requests. These numbers do not include them.
A read of the history costs one more request for every 100 transactions at the pool address and at the deposit address.
To spend fewer requests, set a longer round with `ZX402_INTERVAL_MS`. Payments then take longer.
For a busy pool, use a paid plan or your own chain backend.

## 9. If something goes wrong

- **The deploy stops midway:** nothing is lost. The role keys and the reference script outputs belong to keys derived from your operator seed. Fix the cause, then run step 6 of section 3 again with `-- --force`.
- **The demo stops after the pool paid the one-time address:** the error names the index of the one-time key. The funds sit at that key's address until you move them. The SDK method `recoverOneTimeFunds({ index, payTo })` sends them to an address of your choice.
- **The node logs `Pool history has not reached the current pool UTXO`:** the provider's history is a moment behind its UTXO view. The next round succeeds.
- **A payment waits for minutes:** Preprod sometimes makes no block for a minute or more. The services wait for confirmed data before each step.
- **A step fails its check:** stop. Do not continue with later steps. Write down the transaction hash and the evaluation error.
- **You suspect a bug that puts funds at risk:** pause deposits, then exit every note with settle or ragequit. Exits cannot be paused.
- **A fix is needed in a circuit or a validator:** it means a new ceremony, new script hashes, and a new pool. The old pool stays usable for exits.

## 10. Retiring a pool

The ADA pool of 2026-10-06 and the first tUSDM pool of 2026-10-07 are retired; their records are in `deployments/retired/`.
Keep a retired pool's record, proving keys and note stores. The record identifies its reference script outputs.
Moving a record does not move funds or change a pool on chain.

For both Preprod and mainnet, retire a pool in this order:

1. Pause deposits.
2. Refund pending deposits.
3. Exit every note with settle or ragequit.
4. Collect accrued fees, if any.
5. Move its record from `deployments/<network>.json` to a distinct file under `deployments/retired/`.
6. Sweep the reference script outputs back to the operator wallet, as described below.

CAUTION: a reference script sweep disables the pool's normal transaction path. Complete every refund, exit and fee collection before sweeping.

The admin CLI reads only `deployments/<network>.json`; it has no option to select a retired record.
To sweep that pool, call `sweepReferences` from `ops/src/admin.ts` with the retired record as `ctx.deployment` and its original operator seed.
Use a provider for the record's network. The function selects only the reference outputs named in that record and returns their ADA to the operator.
Do not run the active pool's `sweep-references` command to retire an older pool.

The 6 ADA pool reserve and the minimum ADA in the config and ASP UTXOs stay locked for good. That is the cost of one deployment.

## 11. Mainnet canary

Each step has a test ID from the test plan (`E2E-01` to `E2E-17`) and a pass check.

Sections 1 to 7 hold the exact commands. They are the same on mainnet with `NETWORK=mainnet`.
The checks below use an ADA pool. Leave `POOL_ASSET` unset for this canary.
Canary steps 4 to 10 and step 13 ran on Preprod on 2026-10-06. [measurements.md](./measurements.md) lists the transactions.
A Ragequit (step 12) and a pause with its unpause (step 14) also confirmed there. Their pass checks, an unapproved label and an Insert during a pause, ran only on the local test chain.
Not run on a live network yet: a second payment from a change note (step 11), the negative suite (step 15) and the 7 day canary (step 17). The local test chain covers steps 11 and 15 with the real validators.
Do the steps in order. Stop at the first step that fails its check.

CAUTION: mainnet funds are real, and deployed scripts cannot be changed. Keep the M0 caps: 50 ADA per deposit and 500 ADA in the pool.

CAUTION: evaluate every transaction through the provider before you submit it. A failing script transaction that reaches a block costs the collateral.

CAUTION: never put a seed phrase, a signing key, or a proving key in this repo.

### 11.1. Before you start

Every test in [TEST-PLAN.md](./TEST-PLAN.md) sections 3 to 11 passes in CI.

Wallets and keys:

| Name | Purpose | Funds |
|---|---|---|
| Operator wallet | Publishes reference scripts and runs Init | 300 ADA |
| Relayer wallet | Pays fee inputs and holds one collateral UTXO | 20 ADA, with one UTXO of exactly 5 ADA |
| Admin keys | Sign config updates | Three keys, threshold two |
| ASP keys | Sign ASP root updates | Two keys, threshold one for M0 |
| Test wallets A, B, C | Make test deposits | 15 ADA each |
| Test seller wallet | Receives the x402 payment | Any |

Services running: indexer, crank, relayer, ASP tool, solvency monitor.
A test seller runs the stock `@x402/cardano` server with its TypeScript facilitator.

### 11.2. Phase A: prepare

1. **E2E-01. Freeze the circuits.** Tag the commit. Pass check: a clean rebuild gives the same `r1cs` hashes twice.
2. **E2E-02. Run the ceremony.** Follow [CEREMONY.md](./CEREMONY.md) for all three circuits. Pass check: `snarkjs zkey verify` reports OK for each key, and the manifest is committed.
   CAUTION: back up the proving keys before you deploy, in at least two places. A setup cannot be repeated with the same result.
   Without the proving keys of a pool, nobody can insert, pay or exit, and the notes in that pool stay locked.
3. **E2E-03. Build the validators.** Apply the three verification keys as parameters. Pass check: the script hashes are in the manifest, and `aiken check` passes against the ceremony keys.

### 11.3. Phase B: deploy

4. **E2E-04. Fund the operator wallet.** Pass check: the wallet holds at least 300 ADA.
5. **E2E-05. Publish the reference scripts.** Pass check: each reference UTXO exists, and its script hash equals the manifest.
   About 50 to 80 ADA stays in these UTXOs until the operator spends them. That number is an estimate.
6. **E2E-06. Submit Init.** Pass check: the pool, config, and ASP UTXOs exist with the genesis datums. The pool holds 6 ADA and the pool NFT.
   CAUTION: Init spends the seed UTXO once. A wrong datum here means a new deployment and new script hashes.

### 11.4. Phase C: functional run

7. **E2E-07. Deposit 10 ADA from wallet A.** Use the SDK. Pass check: a UTXO sits at the deposit address with the inline `DepositDatum`.
8. **E2E-08. Run Insert.** Pass check: the pool size is 1, and the root changed. The credited value is 9.7 ADA. The on-chain label equals the label the SDK computed.
9. **E2E-09. Approve the label.** Run the ASP update. Pass check: the SDK shows the note as `spendable`.
10. **E2E-10. Pay the test seller 3 ADA in stealth mode.** Pass check: the seller returns HTTP 200 and a transaction hash. On-chain, the pool paid a one-time key, and that key paid the seller. Wallet A appears in neither transaction.
    Repeat this step against the Cardano Foundation Java facilitator if one is available. Record the result as item 8 of SPEC section 17.
11. **E2E-11. Pay again from the change note.** Wait for the Insert that adds the change note. Pass check: the second payment confirms, and the SDK balance equals 9.7 ADA minus both withdrawn amounts.
12. **E2E-12. Ragequit.** Deposit 10 ADA from wallet B and run Insert. Do not approve the label. Run ragequit. Pass check: a private settle is refused, the ragequit confirms, and wallet B receives the credited value minus network fees.
13. **E2E-13. Refund.** Deposit 5 ADA from wallet C. Refund it before Insert. Pass check: wallet C gets the deposit back, and the crank ignores it.
14. **E2E-14. Pause deposits.** The admins set `deposits_paused`. Pass check: an Insert that absorbs a deposit fails in evaluation, and a settle still confirms. Then unpause.

### 11.5. Phase D: negative suite

15. **E2E-15. Run the negative suite in evaluation only.** Build each transaction below and evaluate it. Pass check: every one fails evaluation. Never submit them.

| Case | Expected failing rule |
|---|---|
| A settle with one byte of the proof changed | S7 |
| A settle that reuses a spent nullifier hash | S8 |
| A settle whose payout address differs from the intent | S10 |
| A settle that removes more than `withdrawn` from the pool | S12 |
| A settle against a root older than the history | S2 |
| A settle with `nullifier_hash + r` as input | S4 |
| A settle that also spends a deposit UTXO | S1 |
| An Insert with a wrong new root | I9 |
| A ragequit without the refund key signature | R3 |

### 11.6. Phase E: record and watch

16. **E2E-16. Record the measurements.** Fill [measurements.md](./measurements.md) for every transaction type. Update the estimates in SPEC section 10 where they differ by more than 20%.
17. **E2E-17. Run the canary for 7 days.** Make one deposit and one stealth payment each day. Pass check: the solvency monitor reports no gap for 7 days.

Use [section 9](#9-if-something-goes-wrong) for failures and [section 10](#10-retiring-a-pool) to wind down the canary.
The reserve and minimum ADA described there stay locked on mainnet too.
