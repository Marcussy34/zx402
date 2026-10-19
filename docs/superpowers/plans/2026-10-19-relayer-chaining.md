# Relayer Chaining Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One sequencer in the node owns the pool output, so the relayer and the crank can chain several pool transactions per block.

**Architecture:** A `Sequencer` class in `packages/txlib` keeps the list of pending transactions and exposes an overlay context. Builders read UTXOs through that context, so they see pending outputs as if they were confirmed. The relayer, crank and ASP service build inside `sequencer.run`, submit through `sequencer.submit`, and the node calls `sequencer.reconcile` every round.

**Tech Stack:** TypeScript (strict), Node.js `node:test` through `node --import tsx --test`, Mesh 1.9.1 builders, snarkjs proofs, the in-repo FakeChain.

**Spec:** `docs/superpowers/specs/2026-10-19-relayer-chaining-design.md`. Read it before any task. `docs/SPEC.md` 8.2, 8.3, 8.5 and 10.4 are the sections it changes.

## Global Constraints

- No change to any validator, circuit, Aiken file or proving key. Hard rules 10 and 12 in `AGENTS.md`.
- Every chained transaction is evaluated before submit. `complete` in `packages/txlib/src/context.ts` already does it; never bypass it (hard rule 8).
- Never commit secrets, `.env` files or keys (hard rule 9).
- `maxPending` defaults to `1` in code. It counts pending Settles and Inserts together. Allowed range 1 to 8.
- Write the failing test first, watch it fail for the right reason, then write the code (`AGENTS.md`, "How to work").
- Test names start with their ID from `docs/TEST-PLAN.md`. Add every new ID to `docs/TEST-PLAN.md` in the same task.
- Do not refactor code the task does not touch. Match the surrounding style: short comments, terse names.
- No em dash characters anywhere: code, comments, docs, commit messages. No `--` or en dash as a stand-in.
- Commit messages: `area: plain sentence`, as in `git log`. No `Co-Authored-By` line and no tool attribution.
- Run before every commit: the task's own tests, then `npm run typecheck`. Tests that need proving keys must run, not skip: the keys are in `circuits/build/dev`.

## Review Focus

1. Blockfrost answers `unknown` for a transaction that is in a block but not yet indexed. One such read must not reset the chain. Pinned in Task 3 (SEQ-04).
2. A node restart forgets its pending list while its transactions may still land. The first new build then spends a pool output that is already spent in a mempool, and the submit is rejected. The request must wait for the next confirmation and rebuild, not fail. Pinned in Task 4 (REL-05, rewritten).
3. A parent drops close to a child's quote deadline. The child must end `failed` or `uncertain`, never hang. Pinned in Task 4 (REL-07, short-deadline case).
4. A build throws inside `sequencer.run` (for example, the fee wallet runs out of ADA). The pending list must stay exactly as it was. Pinned in Task 3 (SEQ-05).
5. A node round calls `reconcile` while the relayer is inside `run`. The two must never interleave. Pinned in Task 3 (SEQ-06).

---

### Task 1: FakeChain additions

**Files:**
- Modify: `packages/txlib/src/types.ts` (new types at the end of the Provider section)
- Modify: `packages/txlib/src/testing/fake-chain.ts` (`LedgerError`, `mineBlock`, new methods)
- Test: `packages/txlib/test/fake-chain.test.ts`
- Modify: `docs/TEST-PLAN.md` (TX-12, TX-13)

**Interfaces:**
- Produces in `types.ts`:
  - `export type TxStatus = 'mempool' | 'confirmed' | 'unknown';`
  - `export interface TxStatusReader { transactionStatus(txId: string): Promise<TxStatus> }`
  - `export class SubmitRejected extends Error { readonly reason: 'bad_inputs' | 'other'; constructor(message: string, reason: 'bad_inputs' | 'other') }`. Its doc comment says: the node refused the transaction, so it is in no mempool we sent it to. Any other submit error means the outcome is unknown.
- Produces in `fake-chain.ts`:
  - `class LedgerError extends SubmitRejected`. `reason` is `'bad_inputs'` when `rule === 'missing_input'`, else `'other'`. `rule` and the constructor signature stay as they are.
  - `class FakeChain implements Provider, ChainHistory, TxStatusReader`.
  - `mineBlock(slots = 20, options: { limit?: number } = {}): FakeBlock`. It includes only the first `limit` mempool transactions, in submit order. The rest stay in the mempool, then `pruneMempool` runs as today.
  - `dropTransaction(txId: string): string[]`. It removes that transaction and every descendant from the mempool and returns all removed IDs, parent first. It throws if `txId` is not in the mempool.
  - `mempoolTxIds(): string[]`, in submit order.
  - `transactionStatus(txId: string): Promise<TxStatus>`: `'mempool'` if pending, `'confirmed'` if in a block, else `'unknown'`.

- [ ] **Step 1: Write the failing tests** in `packages/txlib/test/fake-chain.test.ts`:
  - `TX-12 mineBlock with a limit keeps the rest in the mempool`: submit a parent and a child that spends the parent's output, `mineBlock(20, { limit: 1 })`. Assert `blocks().at(-1).txIds` equals `[parent]`, `mempoolTxIds()` equals `[child]`, then `mineBlock()` confirms the child.
  - `TX-12 dropTransaction removes descendants`: parent, child and an unrelated transaction. `dropTransaction(parent)` returns `[parent, child]`. `mempoolTxIds()` equals `[unrelated]`.
  - `TX-13 transactionStatus follows a transaction`: `'unknown'` before submit, `'mempool'` after, `'confirmed'` after `mineBlock()`, `'unknown'` after `rollback(1)`.
  - `TX-13 a spent input is a SubmitRejected with reason bad_inputs`: submit a transaction whose input was already spent. Assert the error is `instanceof SubmitRejected`, `instanceof LedgerError`, `rule === 'missing_input'` and `reason === 'bad_inputs'`.
- [ ] **Step 2: Run them and see them fail**
  Run: `cd packages/txlib && node --import tsx --test --test-name-pattern "TX-1[23]" "test/**/*.test.ts"`
  Expected: FAIL, the new methods and types do not exist.
- [ ] **Step 3: Implement** the types and methods listed under Interfaces.
- [ ] **Step 4: Run the whole txlib suite**
  Run: `npm test -w packages/txlib`
  Expected: PASS, including every older FakeChain test.
- [ ] **Step 5: Add TX-12 and TX-13 to `docs/TEST-PLAN.md`, run `npm run typecheck`, commit**
  `git commit -m "txlib: the FakeChain mines part of its mempool, drops a transaction and reports its status"`

---

### Task 2: Provider submit classes, transaction status, and builder deadlines

**Files:**
- Modify: `packages/txlib/src/providers/blockfrost.ts` (`adapt` submit, `blockfrostProvider`)
- Modify: `packages/txlib/src/insert.ts` (`buildInsert`)
- Modify: `packages/txlib/src/admin.ts` (`buildAspUpdate`)
- Test: `packages/txlib/test/blockfrost.test.ts`, `packages/txlib/test/flow.test.ts` or the test file that already covers `buildInsert`, `packages/txlib/test/admin.test.ts`
- Modify: `docs/TEST-PLAN.md` (TX-14, TX-15)

**Interfaces:**
- Consumes: `SubmitRejected`, `TxStatus`, `TxStatusReader` from Task 1.
- Produces:
  - Blockfrost `submit` throws `SubmitRejected` when Blockfrost answers HTTP 400. `reason` is `'bad_inputs'` when the message contains `BadInputsUTxO`, else `'other'`. Every other failure stays a plain `Error`. Submit still never retries.
  - `blockfrostProvider(projectId, network): Provider & ChainHistory & TxStatusReader`. `transactionStatus` reads `txs/{hash}` (found means `'confirmed'`), then `mempool/{hash}` (found means `'mempool'`), and returns `'unknown'` when both answer 404. Other errors throw. Reads retry as today.
  - `buildInsert(ctx, { ...existing, validForMs?: number })` and `buildAspUpdate(ctx, { ...existing, validForMs?: number })`. Default `600_000`. They set `invalidHereafter(timeToSlot(tip.time + validForMs, network))`, where `tip = await ctx.provider.getTip()`. The Insert and ASP validators do not read the validity range, so no script changes.

- [ ] **Step 1: Write the failing tests**
  - `TX-14 a 400 submit answer is SubmitRejected`: with the injected Mesh fake already used in `blockfrost.test.ts`, make `submitTx` reject with a Blockfrost 400 payload whose message contains `BadInputsUTxO`. Assert `instanceof SubmitRejected` and `reason === 'bad_inputs'`. A 400 without that text gives `reason === 'other'`. A `socket hang up` error is a plain `Error`, not `SubmitRejected`, and `submitTx` was called once.
  - `TX-14 transactionStatus reads the chain, then the mempool`: fake `get` answers for `txs/` and `mempool/` give `'confirmed'`, `'mempool'` and `'unknown'` in the three cases.
  - `TX-15 Insert and ASP updates carry a deadline`: build each on the devnet with `validForMs: 120_000`. Assert `decodeTx(tx.cbor).invalidHereafter === timeToSlot(tip.time + 120_000, network)`. Build again without the option and assert the default of 600,000 ms.
- [ ] **Step 2: Run them and see them fail**
  Run: `cd packages/txlib && node --import tsx --test --test-name-pattern "TX-1[45]" "test/**/*.test.ts"`
  Expected: FAIL.
- [ ] **Step 3: Implement** the three changes. In Blockfrost, reuse `errorPayload` and the existing status checks to detect HTTP 400. `transactionStatus` uses `mesh.get` like `getTransactionCbor` does.
- [ ] **Step 4: Run the txlib suite**
  Run: `npm test -w packages/txlib`
  Expected: PASS.
- [ ] **Step 5: Add TX-14 and TX-15 to `docs/TEST-PLAN.md`, run `npm run typecheck`, commit**
  `git commit -m "txlib: submit sorts refusals from unknown outcomes, and Insert and ASP updates carry a deadline"`

---

### Task 3: The sequencer

**Files:**
- Create: `packages/txlib/src/sequencer.ts`
- Modify: `packages/txlib/src/index.ts` (add `export * from './sequencer.js';`)
- Test: `packages/txlib/test/sequencer.test.ts`
- Modify: `docs/TEST-PLAN.md` (new section, SEQ-01 to SEQ-06)

**Interfaces:**
- Consumes: Task 1 and Task 2 types, `decodeTx`, `outputsOf`, `ChainContext`.
- Produces:

```ts
export type PoolTxKind = 'settle' | 'insert' | 'asp';
export interface PendingEntry {
  kind: PoolTxKind; txId: string; nullifier: bigint | null;
  invalidHereafter: number; spent: UtxoRef[]; outputs: Utxo[]; unseen: number;
}
export type SubmitResult =
  | { status: 'accepted' | 'unknown'; txId: string }
  | { status: 'rejected'; txId: string; reason: 'bad_inputs' | 'other'; message: string };
export interface ResetEvent { reason: 'dropped' | 'expired' | 'rejected_child'; dropped: PendingEntry[] }

export class Sequencer {
  constructor(a: {
    ctx: ChainContext; status: TxStatusReader; maxPending?: number;
    childRetryMs?: number; childRetryForMs?: number; unseenLimit?: number;
    log?: (line: string) => void;
  });
  /** Builders read through this context: confirmed UTXOs, minus pending spends, plus pending outputs. */
  readonly ctx: ChainContext;
  readonly maxPending: number;
  run<T>(fn: () => Promise<T>): Promise<T>;
  canSubmit(kind: PoolTxKind): boolean;
  submit(signedCbor: string, meta: { kind: PoolTxKind; nullifier?: bigint }): Promise<SubmitResult>;
  reconcile(): Promise<ResetEvent | null>;
  transactionStatus(txId: string): Promise<TxStatus>;
  pending(): readonly PendingEntry[];
  pendingNullifiers(): bigint[];
  onReset(listener: (event: ResetEvent) => void | Promise<void>): void;
}
```

Rules the code must follow (design sections 5.2 to 5.7):

- Defaults: `maxPending` 1 (range 1 to 8, else `RangeError`), `childRetryMs` 2,000, `childRetryForMs` 20,000, `unseenLimit` 2.
- **Overlay.** `ctx.provider.getUtxosAt(address)` returns confirmed UTXOs at that address, minus refs spent by any pending entry, plus pending outputs at that address. `ctx.provider.getUtxos` passes through unchanged. `complete` relies on it returning confirmed outputs only. Every other provider method passes through.
- **Gates** (`canSubmit`):
  - `'settle'`: fewer than `maxPending` pending Settles and Inserts, and no pending ASP update.
  - `'insert'`: the same count rule, and no pending Insert.
  - `'asp'`: no pending ASP update and no pending Settle.
- **`run`** holds one lock. `reconcile` takes the same lock. A throw inside `fn` leaves the pending list unchanged.
- **`submit`** must be called inside `run`. It submits through the underlying provider and decodes the transaction for `spent` (inputs), `outputs` (`outputsOf`) and `invalidHereafter`. Results:
  - Success: `accepted`, and the entry is added.
  - A plain `Error`: `unknown`, and the entry is added, because it may be in a mempool.
  - `SubmitRejected` with `bad_inputs`, for a transaction that spends an output of a pending entry (a child): retry every `childRetryMs` until `childRetryForMs` has passed. If it still fails, return `rejected` and reset with `rejected_child`.
  - Any other `SubmitRejected`: `rejected`, with no entry and no reset.
- **`reconcile`**, under the lock, walks the pending list oldest first:
  - `transactionStatus` is `'confirmed'`: remove the entry and continue.
  - `'mempool'`: set `unseen` to 0 and stop.
  - `'unknown'`: increase `unseen`. Reset with `dropped` once it reaches `unseenLimit`. Stop either way.
  - After the walk, if any remaining entry has `invalidHereafter` below the tip slot, reset with `expired`.
  - There is no separate check for another party spending the pool first. A node evicts a transaction whose input is gone, so it reads `'unknown'` and resets as `dropped`. A check on spent inputs would misfire while Blockfrost lags behind a new block, and wrongly reset a transaction that already landed.
- **Reset** empties the pending list. It returns the event, and calls the listeners in order **after** the lock is released, so a listener may call `run`.

- [ ] **Step 1: Write the failing tests** in `packages/txlib/test/sequencer.test.ts`. Use the FakeChain with plain ADA transfers between key addresses; no pool scripts are needed.
  - `SEQ-01 the overlay shows pending outputs and hides pending spends`: submit A from address X to Y through the sequencer. `sequencer.ctx.provider.getUtxosAt(Y)` contains A's output. `getUtxosAt(X)` no longer contains A's input. The raw `chain.getUtxosAt(Y)` does not contain it.
  - `SEQ-02 a child chains and both land in one block`: with `maxPending: 2`, build B on A's pending output through `sequencer.ctx`. Both `accepted`. One `mineBlock()` confirms both. `reconcile()` returns `null` and `pending()` is empty.
  - `SEQ-02 gates follow maxPending and kinds`: with `maxPending: 1`, after one `'settle'` entry, `canSubmit('settle')` and `canSubmit('insert')` are false and `canSubmit('asp')` is false. With an `'asp'` entry only, `canSubmit('settle')` is false and `canSubmit('insert')` is true.
  - `SEQ-03 a dropped parent resets the chain`: A and child B pending. `chain.dropTransaction(A)`. The first `reconcile()` returns `null`. The second returns `{ reason: 'dropped' }` with both entries in `dropped`. The listener ran once.
  - `SEQ-03 a foreign spend resets the chain as dropped`: A pending. Drop A, then submit a conflicting transaction C on the raw chain that spends A's input, and mine C. The second `reconcile()` returns `{ reason: 'dropped' }`.
  - `SEQ-03 an expired entry resets the chain`: A with a short `invalidHereafter`. `advanceSlots` past it. `reconcile()` returns `{ reason: 'expired' }`.
  - `SEQ-04 one unknown read does not reset`: wrap `status` so that A reads `'unknown'` once, then `'confirmed'`. Two `reconcile()` calls return `null`, and A is removed as confirmed.
  - `SEQ-04 a child with BadInputsUTxO is retried`: a wrapped provider rejects the child's first two submits with `SubmitRejected('...BadInputsUTxO...', 'bad_inputs')`, then accepts. With `childRetryMs: 1`, `submit` returns `accepted` after 3 calls.
  - `SEQ-05 a throw inside run leaves pending unchanged`: one entry pending. `run(async () => { throw new Error('no fee input') })` rejects, and `pending()` deep-equals the list from before.
  - `SEQ-06 reconcile waits for run`: start `run` with a function that waits on a promise you control. Call `reconcile()`. Assert it has not resolved. Release the promise. Assert the order is run end, then reconcile end.
- [ ] **Step 2: Run them and see them fail**
  Run: `cd packages/txlib && node --import tsx --test --test-name-pattern "SEQ-" "test/**/*.test.ts"`
  Expected: FAIL, `Sequencer` is not exported.
- [ ] **Step 3: Implement** `packages/txlib/src/sequencer.ts` and the export.
- [ ] **Step 4: Run the txlib suite**
  Run: `npm test -w packages/txlib`
  Expected: PASS.
- [ ] **Step 5: Add SEQ-01 to SEQ-06 to `docs/TEST-PLAN.md`, run `npm run typecheck`, commit**
  `git commit -m "txlib: a sequencer tracks pending pool transactions and builds on the newest output"`

---

### Task 4: The relayer builds through the sequencer

Two passes. Pass 1 writes and commits the red tests only. Pass 2 makes them pass.

**Files:**
- Modify: `services/relayer/src/relayer.ts`
- Test: `services/relayer/test/relayer.test.ts`
- Modify: `docs/TEST-PLAN.md` (REL-07 to REL-09)
- Modify: `docs/SPEC.md` 8.2 (the behavior lines 690 to 695)

**Interfaces:**
- Consumes: `Sequencer`, `SubmitResult`, `ResetEvent` from Task 3.
- Produces: `new Relayer({ ...existing, sequencer: Sequencer })`. `sequencer` is required. `retryDelayMs` stays and is now the poll delay while it waits for room or for the next confirmation.

Behavior (design 5.3, 5.7, 5.8):

- Delete `pendingPool`, `availablePool` and the three-read lost-race loop.
- `submit(request)` keeps its checks up to proof verification, outside the lock. Then it makes up to 3 attempts:
  1. Wait for room: loop `await sequencer.reconcile()`. Stop when `sequencer.canSubmit('settle')`. Otherwise `checkExpiry(quote)` and `delay(retryDelayMs)`.
  2. Inside `sequencer.run`, read `pool = await readPool(sequencer.ctx)` and run today's checks against it: `stateRoot`, `aspRoot`, spent nullifier and queue. The spent list is the indexer's list plus `sequencer.pendingNullifiers()`. `nullifierInsertion` uses that combined list. Its `oldRoot` must equal `pool.datum.nullifierRoot`, with today's retry when the indexer is behind. Build with `buildSettle(sequencer.ctx, ...)`, sign, then call `sequencer.submit(signed, { kind: 'settle', nullifier })`.
  3. On `accepted`, record and return `submitted`, as today. On `unknown`, keep today's `uncertain` path. On `rejected`, call `sequencer.reconcile()`, wait `retryDelayMs`, and try again. After 3 attempts, throw `internal`, as today.
- Keep each sent request: `Submission` gains `request: SettleRequest` and `txHashes: string[]`.
- Register `sequencer.onReset`. The listener only enqueues work and never awaits a rebuild, because listeners run while the caller of `run` or `reconcile` waits. For each dropped Settle entry whose submission exists, whose nullifier is not confirmed and whose quote is still valid, queue a rebuild on `this.serial`. The rebuild uses the same attempt path and pushes the new hash to `txHashes`. Otherwise leave the entry for `getSettle`'s expiry rule.
- A rebuild that ends `rejected` or throws leaves the submission as it is. A reset can be wrong while the indexer lags, and the original may have landed. `getSettle` decides the final status from the nullifier and the deadline.
- `getSettle`: keep today's rules. When it reports `confirmed`, `txHash` is the entry of `txHashes` whose `sequencer.transactionStatus` is `'confirmed'`. Fall back to the last one.

- [ ] **Pass 1, Step 1: Write the failing tests**, alongside the existing real-proof story. Build a sequencer on the devnet chain and pass it in. Existing tests get `new Sequencer({ ctx, status: chain })` with the default `maxPending: 1`.
  - `REL-06 two settles chain inside one block window`: `maxPending: 2`. Two valid settle requests for two notes, both resolve `submitted` before any `mineBlock()`. One `mineBlock()` confirms both. `getSettle` reports `confirmed` for both.
  - `REL-07 a dropped parent: both settles are rebuilt and land`: `maxPending: 2`. Two settles pending. `chain.dropTransaction(first)`, then two `reconcile()` calls. Both rebuild. One `mineBlock()` confirms both. Each status's `txHash` differs from its first hash and is `'confirmed'` on the chain.
  - `REL-07 a dropped parent near the deadline ends failed`: the same, with a quote TTL that ends before the rebuild can run. `getSettle` reports `failed` after the tip passes `validUntil`, and no rebuild is submitted.
  - `REL-08 another party spends the pool first`: one settle pending. Submit a competing Settle for another note directly on the raw chain, built from the confirmed pool. Drop ours and mine theirs. After `reconcile()`, ours is rebuilt on the new head and lands on the next `mineBlock()`.
  - `REL-09 a settle never pays twice`: after a reset, put the original transaction back by resubmitting its CBOR on the raw chain, and mine. Exactly one of the two lands. The other is refused or dropped. The payout address holds exactly one payout.
  - `REL-05` (rewrite the three cases at `relayer.test.ts:343-416` and the lost-race tests at `:595-730`): a submit rejected because the pool output is already spent waits for the next confirmation, rebuilds, and returns `submitted` within its deadline. A lost reply is still `uncertain`. Keep each test's ID and its first sentence of intent.
- [ ] **Pass 1, Step 2: Run them and see them fail for the right reason**
  Run: `npm test -w services/relayer`
  Expected: the new and rewritten tests FAIL, because the relayer has no `sequencer` option. Every untouched test still passes.
- [ ] **Pass 1, Step 3: Commit the red tests**
  `git commit -m "test(relayer): chained settles, resets and the no-double-pay rule, failing until the relayer uses the sequencer"`
- [ ] **Pass 2, Step 1: Implement** the behavior above in `relayer.ts`.
- [ ] **Pass 2, Step 2: Run the relayer suite**
  Run: `npm test -w services/relayer`
  Expected: PASS, with no skips for proof tests.
- [ ] **Pass 2, Step 3: Update `docs/SPEC.md` 8.2 and `docs/TEST-PLAN.md`, run `npm run typecheck`, commit**
  - In 8.2, replace the "M0 status: the relayer does not chain" sentence with the sequencer behavior and the `maxPending` setting.
  - `git commit -m "relayer: settles build on the newest pool output and rebuild after a reset"`

---

### Task 5: The crank and the ASP service submit through the sequencer

**Files:**
- Modify: `services/crank/src/crank.ts`
- Modify: `services/asp/src/asp.ts`
- Test: `services/crank/test/crank.test.ts`, `services/asp/test/asp.test.ts`
- Modify: `packages/sdk/test/sdk.test.ts` (its harnesses build a relayer, a crank and an ASP service: give each harness one shared `Sequencer`, as the node will)
- Modify: `docs/TEST-PLAN.md` (CRK-04, REL-10), `docs/SPEC.md` 8.3 and 8.5

**Interfaces:**
- Consumes: `Sequencer` from Task 3.
- Produces:
  - `new Crank({ ...existing, sequencer: Sequencer })`. `retryAfterMs` and the `pending` field go away.
  - `new AspService({ ...existing, sequencer: Sequencer })`. `retryAfterMs` and the `pending` field go away.

Behavior:

- `Crank.tick()` returns `null` when `!sequencer.canSubmit('insert')`. Otherwise it runs today's steps inside `sequencer.run`:
  - It reads the pool, config and deposits through `sequencer.ctx`.
  - It builds with `buildInsert(sequencer.ctx, ...)`.
  - It submits with `sequencer.submit(signed, { kind: 'insert' })`.
  - It returns `null` on `rejected`.
- `AspService.update()` keeps reading `current` from its own confirmed `ctx` for the approval bookkeeping.
  - It returns `{ approved, txId: null }` when `!sequencer.canSubmit('asp')`.
  - It builds with `buildAspUpdate(sequencer.ctx, ...)` inside `sequencer.run`.
  - It submits with `sequencer.submit(signed, { kind: 'asp' })`.

- [ ] **Step 1: Write the failing tests**
  - `CRK-04 an Insert chains on top of a pending Settle`: `maxPending: 2`. One relayer settle pending (Task 4's helpers). `crank.tick()` submits an Insert whose pool input is the Settle's pool output. One `mineBlock()` confirms both. The confirmed pool datum's queue no longer holds the flushed notes.
  - `CRK-01` (rewrite "a dropped insertion retries after the default delay" at `crank.test.ts:171-190`): drop the pending Insert with `chain.dropTransaction`. After two `sequencer.reconcile()` calls, the next `crank.tick()` submits a new Insert.
  - `REL-10 the ASP gate`: with a Settle pending, `asp.tick()` submits nothing. After `mineBlock()` and `reconcile()`, it submits the update. With that update pending, `sequencer.canSubmit('settle')` is false.
  - Update the other existing crank and ASP tests to pass a `Sequencer` with the default `maxPending: 1`. Make no other changes to them.
- [ ] **Step 2: Run them and see them fail**
  Run: `npm test -w services/crank && npm test -w services/asp`
  Expected: the new and rewritten tests FAIL.
- [ ] **Step 3: Implement** the behavior above.
- [ ] **Step 4: Run both suites**
  Run: `npm test -w services/crank && npm test -w services/asp`
  Expected: PASS.
- [ ] **Step 5: Update `docs/SPEC.md` 8.3 and 8.5 and `docs/TEST-PLAN.md`, run `npm run typecheck`, commit**
  - 8.3 gets one line: an Insert can chain on pending Settles, with at most one Insert pending.
  - 8.5 gets the ASP gate.
  - `git commit -m "crank, asp: Inserts and ASP updates go through the sequencer"`

---

### Task 6: The node wires one sequencer

**Files:**
- Modify: `ops/src/node.ts` (`NodeOptions`, `startNode`, the CLI block near line 222)
- Test: `ops/test/rehearsal.test.ts` (only where it constructs the node), and a new case in the same file
- Modify: `docs/RUNBOOK.md`

**Interfaces:**
- Consumes: Tasks 3 to 5.
- Produces:
  - `NodeOptions.history: ChainHistory & TxStatusReader`, and `NodeOptions.maxPending?: number`.
  - `Zx402Node` gains `sequencer: Sequencer`.
  - The CLI reads `ZX402_MAX_PENDING` (an integer from 1 to 8, default 1) and passes it as `maxPending`.

Behavior:

- `startNode` creates one `Sequencer({ ctx: o.ctx, status: o.history, maxPending: o.maxPending ?? 1, log })`. It passes it to the `Relayer`, `Crank` and `AspService`.
- In `tick()`, after the first `sync()`, it runs `await sequencer.reconcile()`, and logs a reset as `sequencer: reset (<reason>, <n> dropped)`.

- [ ] **Step 1: Write the failing test** `E2E-18 the node chains two private payments in one block` in `ops/test/rehearsal.test.ts`. Use `maxPending: 2`, two SDK instances with funded notes, and two `settle` calls started together, with one `mineBlock()` between the submits and the confirmations. Both payments land in the same block height.
- [ ] **Step 2: Run it and see it fail**
  Run: `cd ops && node --import tsx --test --test-name-pattern "E2E-18" "test/**/*.test.ts"`
  Expected: FAIL.
- [ ] **Step 3: Implement** the wiring and the environment variable.
- [ ] **Step 4: Run the ops suite**
  Run: `npm test -w ops`
  Expected: PASS. E2E-01 to E2E-17 are unchanged with the default `maxPending: 1`.
- [ ] **Step 5: Add a runbook note, run `npm run typecheck`, commit**
  - The note goes in `docs/RUNBOOK.md`: `ZX402_MAX_PENDING`, and "CAUTION: run the admin command only when the node has nothing pending, or pending Settles drop and rebuild."
  - Add E2E-18 to `docs/TEST-PLAN.md`.
  - `git commit -m "ops: the node runs one sequencer and reads ZX402_MAX_PENDING"`

---

### Task 7: The SDK finds a rebuilt funding output

**Files:**
- Modify: `packages/sdk/src/x402.ts:56-61`
- Test: `packages/sdk/test/sdk.test.ts`
- Modify: `docs/TEST-PLAN.md` (SDK-09)

**Interfaces:**
- Consumes: nothing new.
- Produces: the stealth signer polls for an output at the one-time address with the expected value, and ignores `receipt.txHash`.

- [ ] **Step 1: Write the failing test** `SDK-09 the stealth signer accepts a funding output with another transaction hash`. Stub the relayer so `settle` returns `txHash` X. Fund the one-time address in a transaction with a different hash. The signer builds leg 2 from that output.
- [ ] **Step 2: Run it and see it fail**
  Run: `cd packages/sdk && node --import tsx --test --test-name-pattern "SDK-09" "test/**/*.test.ts"`
  Expected: FAIL, the poll times out.
- [ ] **Step 3: Implement.** Delete the `u.ref.txId === receipt.txHash &&` condition. Keep every other condition. Add a short comment: a reset can rebuild the Settle with a new hash, and the one-time address is used once.
- [ ] **Step 4: Run the SDK suite**
  Run: `npm test -w packages/sdk`
  Expected: PASS.
- [ ] **Step 5: Add SDK-09 to `docs/TEST-PLAN.md`, run `npm run typecheck`, commit**
  `git commit -m "sdk: the stealth signer finds its funding output by address, so a rebuilt settle still pays"`

---

### Task 8: The rest of the documents

**Files:**
- Modify: `docs/HANDOFF.md`
- Modify: `docs/SPEC.md` 10.4

- [ ] **Step 1: Edit `docs/HANDOFF.md`** "Known limits of M0".
  - Replace the "relayer does not chain" item with two items. First: the node chains up to `ZX402_MAX_PENDING` pool transactions. Second: at most one Insert is pending at a time.
  - Add one more item: the sequencer keeps its pending list in memory, so after a restart the first submit can be refused once, then it rebuilds.
- [ ] **Step 2: Edit SPEC 10.4.** Change "Transaction chaining lets one relayer use several slots in the same block" to say that the node does this through the sequencer, and point to `docs/measurements.md` for the measured runs.
- [ ] **Step 3: Check the writing rules.**
  Run: `grep -n $'\xe2\x80\x94' docs/HANDOFF.md docs/SPEC.md docs/RUNBOOK.md docs/TEST-PLAN.md`
  Expected: no new matches in the lines you changed.
- [ ] **Step 4: Commit**
  `git commit -m "docs: the handoff and the spec describe relayer chaining"`

---

### Task 9: Measure on Preprod, then turn chaining on

The lead runs this task, because it uses the funded Preprod deployment and `.env`.

**Files:**
- Create: `ops/src/burst.ts` and an `npm run burst -w ops` script in `ops/package.json`
- Modify: `docs/measurements.md` (new section "Chaining on Preprod")
- Modify: `ops/src/node.ts` (default of `ZX402_MAX_PENDING` becomes 4) and `docs/RUNBOOK.md`

**Interfaces:**
- `npm run burst -w ops -- --count <n>` uses `<n>` SDK seeds derived from the agent seed with indexes 0 to n-1.
  1. Each seed without a spendable note gets a deposit of the pool minimum from the agent wallet. The command waits until all notes are spendable.
  2. It starts `<n>` private payments at the same moment, each paying 1 tUSDM to the agent wallet.
  3. It prints each Settle hash, its block height, the number of distinct blocks used, and the seconds from start until the last confirmation.

- [ ] **Step 1: Write `burst.ts`** with a local-chain test `OPS-xx burst reports blocks and time` in `ops/test/`, using the next free OPS ID.
- [ ] **Step 2: Run the test and commit**
  Run: `cd ops && node --import tsx --test --test-name-pattern "burst" "test/**/*.test.ts"`
  `git commit -m "ops: a burst command measures how many blocks a set of payments uses"`
- [ ] **Step 3: Run on Preprod with `ZX402_MAX_PENDING=1`, then `=4`,** with `--count 5`. The node and the seller run as in the runbook. Save both terminal logs under `docs/evidence/`.
- [ ] **Step 4: Write the "Chaining on Preprod" section of `docs/measurements.md`.** It holds both runs: blocks used, total seconds, every hash, and any `BadInputsUTxO` retries seen in the node log.
- [ ] **Step 5: If the `=4` run landed in fewer blocks with no failed payment,** set the default to 4 in `ops/src/node.ts` and the runbook. Run `npm test -w ops`, then commit.
  `git commit -m "ops: the node chains up to four pool transactions by default"`
  If it did not, keep the default at 1 and record why in the measurements section.
