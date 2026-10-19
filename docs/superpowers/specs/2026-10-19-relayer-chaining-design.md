# Relayer chaining: design

| Field | Value |
|---|---|
| Date | 2026-10-19 |
| Status | Draft, waiting for the owner's approval |
| Spec sections | 8.2 Relayer, 8.3 Crank, 8.5 ASP service, 10.4 Throughput |
| Test IDs | REL-06 (exists, no relayer test yet), new REL-07 to REL-10, CRK-04, TX-xx, SDK-xx. Rewritten REL-05 and CRK-01 |
| Needs a new pool | No. No validator or circuit changes |

## 1. Why

All funds sit in one pool UTXO. Today each service waits for its own pool transaction to confirm before it builds the next one.
So the whole pool serves about one action per block, for every user together.
With ten agents paying at once, the last one waits about ten blocks, which is several minutes.

SPEC 8.2 already says what we want: "The relayer keeps a local copy of the pool state and chains transactions. One relayer can advance the pool several times per block."
SPEC 8.2 also records the M0 cut: "the relayer does not chain."
SPEC 10.4 puts the ceiling at about 5 private payments per block, counting each payment's share of an Insert.
This design closes the gap between M0 and SPEC 8.2.

A cardano-node accepts a transaction that spends an output of a transaction still in its mempool, so parent and child can land in the same block.
Sources: developers.cardano.org, "Transaction chaining", and the Cardano blueprint, mempool section.

## 2. The change in one paragraph

One new component in the node, the **sequencer**, owns the pool UTXO.
It knows the **head**: the newest pool output, confirmed or still pending.
The relayer and the crank no longer read the confirmed pool UTXO to build on.
They ask the sequencer for the head, build on it, and hand the signed transaction back to the sequencer to submit.
The sequencer keeps the list of pending pool transactions, checks each round which of them confirmed, and recovers when one is dropped or another party spends the pool first.
A setting, `maxPending`, caps how many pool transactions may be pending at once. `maxPending: 1` is today's behavior.

## 3. Goals, non-goals, anti-goals

### Goals

- **G1.** Several pool transactions per block from one node. Five settle requests that arrive together land in one or two blocks, not five.
- **G2.** No new trust and no new loss path. The validators and circuits do not change. Every safety rule in AGENTS.md still holds.
- **G3.** A request never gets stuck. A dropped parent leads to a rebuild or a clear failure before the quote's `validUntil`.
- **G4.** Measured proof. The same code runs with `maxPending: 1` and with chaining on Preprod, and both results go into `docs/measurements.md`.

### Non-goals

- More than one relayer, more than one pool, or nullifier sharding (SPEC 10.4 and the M3 release).
- Two Inserts pending at once. At most one Insert is pending in this version.
- Our own Cardano node or Ogmios. That is a separate work item. This design runs on Blockfrost.
- Faster proving or faster proof verification.
- SDK changes beyond one: the stealth signer finds its funding output by address instead of by hash (section 5.10).
- Keeping the old code paths next to the new ones. `maxPending: 1` turns chaining off, but it runs through the sequencer too.

### Anti-goals

The work fails, even if it runs, if any of these happen:

- A payment is made twice, or a note is lost.
- The relayer reports `confirmed` for a transaction that is not in a block.
- An agent's request hangs past its quote deadline without a final status.
- Any change needs a new pool or a new key setup.

## 4. How it works today

| Fact | Where |
|---|---|
| The relayer, crank and ASP service run in one process and share the indexer | `ops/src/node.ts:61-66` |
| The relayer processes one settle at a time, through a promise chain | `services/relayer/src/relayer.ts:159-161` |
| `availablePool` waits in 20 s steps while the confirmed pool ref equals the ref it last spent | `relayer.ts:215-226` |
| `pendingPool` stores only the spent input ref, not the new output | `relayer.ts:299` |
| The crank has its own separate pending guard and a 180 s resubmit guard | `services/crank/src/crank.ts:16, 26, 33-35` |
| The ASP service spends only the ASP UTXO. Every Settle uses the ASP and config UTXOs as reference inputs | `services/asp/src/asp.ts:142-147`, `packages/txlib/src/settle.ts:41-42` |
| The nullifier trie is rebuilt from the confirmed spent list for every Settle | `packages/txlib/src/nullifiers.ts:13-22` |
| `complete` already passes unconfirmed outputs to the evaluator as additional UTxOs | `packages/txlib/src/context.ts:103-112` |
| Blockfrost submit has no retry and no error classes. Every submit error is a plain `Error` | `packages/txlib/src/providers/blockfrost.ts:220` |
| The FakeChain has a mempool, accepts children of pending outputs, mines the whole mempool in one block, and drops children whose input vanished | `packages/txlib/src/testing/fake-chain.ts:101, 140-144, 266-288` |

### What a chained Settle must recompute

The user's proof fixes `nullifierHash`, `newCommitment`, `withdrawn`, `stateRoot`, `aspRoot` and the intent.
The validator accepts `stateRoot` if it is any of the 16 roots in the datum's history (`contracts/lib/zx402/pool/settle.ak:27`).
So the user's proof stays valid when other pool transactions land first.

The relayer derives these from the exact parent output, so it recomputes them on the head:

- the pool input (the head's ref) and the pool value;
- the output datum: `queue ++ [newCommitment]`, the new nullifier root, and `feesAccrued + fee`;
- the nullifier insertion proof, against the head's nullifier root. The trie must hold the pending nullifiers too.

### What a chained Insert must recompute

The insert proof's public inputs are the old root, the new root, the size and the slots (`contracts/lib/zx402/pool/insert.ak:76`).
A Settle changes none of these. It only appends to the tail of the queue.
So an Insert can chain on top of pending Settles. `buildInsert` recomputes the rest of the queue, `feesAccrued` and the value from the head.
An Insert on top of a pending Insert would need a local copy of the tree. That is out of scope.

### Why a rebuilt Settle cannot pay twice

The Settle validator inserts the nullifier into the nullifier trie with an insertion proof (`contracts/lib/zx402/pool/common.ak:132-140`).
That insertion fails if the nullifier is already present.
So if the relayer builds a second transaction for the same request, at most one of the two can ever land.
This is what makes resubmission after a reset safe (section 5.7).

## 5. Design

### 5.1 The sequencer

- It lives in `services/` as its own small module, or inside the relayer package. The builder chooses.
- The node creates one sequencer and gives it to the relayer and the crank.
- Every pool transaction goes through it. No other code reads the confirmed pool UTXO in order to build on it.
- It runs one build at a time, under a lock. Proof verification, quoting and other slow checks run outside the lock.

### 5.2 What the sequencer tracks

- **The confirmed head.** The pool UTXO the provider reports, with its datum and value.
- **The pending list.** One entry per pool transaction it submitted and has not seen confirmed. Each entry holds the kind (Settle or Insert), the transaction hash, the new pool output (ref, datum, value), the role's change output, the nullifier for a Settle, and the transaction's upper validity bound.
- **The pending ASP update**, if any. At most one. The ASP service submits through the sequencer, so the sequencer can apply the gate in section 5.6.
- **The head.** The pool output of the last pending entry, or the confirmed head when nothing is pending.
- **The pending nullifiers**, in order. The nullifier trie for the next Settle is the confirmed spent list plus these.

### 5.3 Building on the head

Before it builds a Settle on the head, the sequencer checks:

1. The pending list is shorter than `maxPending`.
2. The user's `stateRoot` is in the head's 16 roots. If not, it refuses with `stale_root`, and the SDK proves again.
3. The user's `aspRoot` equals the confirmed ASP root, and no ASP update is pending (section 5.6).
4. The head's queue has room (fewer than 8 entries). If not, it refuses with `queue_full`, as today (REL-04 is unchanged).

Before it builds an Insert on the head, it checks that no Insert is pending.

If check 1 fails because the chain is full, the request waits for the next confirmation, as it does today. It never waits past its quote's `validUntil`.

Every chained transaction is evaluated before it is submitted, with the pending outputs passed as additional UTxOs (AGENTS.md rule 8).

### 5.4 Fee wallets and collateral

- The relayer and the crank have separate fee wallets (`ops/src/node.ts:217`). Each role chains on its own change.
- A role's next transaction pays its fee from the change output of its last pending transaction, passed in through `payer.utxos`. It never reuses a confirmed fee UTXO that a pending transaction already spent.
- Collateral comes from the same view of the wallet, so it can be a pending change output. That is safe: if the parent drops, the child drops with it. Collateral is only taken if a script fails, which evaluation prevents.

### 5.5 Limits

| Limit | Value | Source |
|---|---|---|
| `maxPending` | Setting. Default `1` until the Preprod measurement, then `4` | This design |
| Queue length | Fewer than 8 entries before an Insert | `settle.ak:34`, SPEC 6.2 |
| Root history | 16 roots | SPEC 6.2 |
| Block budget | About 5 Settles per block on mainnet | SPEC 10.4 |

`maxPending` bounds the damage when a parent drops, because every child drops with it.
Transactions that do not fit in one block simply land in the next one.

### 5.6 The ASP and config outputs

A Settle uses the ASP output as a reference input.
If an ASP update reaches a block producer before a pending Settle, that Settle fails.
Two independent transactions can reach a remote node in either order, so the sequencer does not rely on order:

- The ASP service does not submit an ASP update while a pending Settle references the current ASP output.
- The sequencer does not submit a Settle while an ASP update is pending.

The cost is at most one block of waiting around each ASP update.

Under steady traffic a Settle may always be pending, so the ASP update could wait forever and new deposits would never be approved. So when the ASP service has an update waiting, it asks the sequencer to hold: the sequencer admits no new Settle until the update is submitted, for at most 2 minutes. The pending Settles land, the update goes out, and Settles resume.
An ASP update also changes the ASP root, so proofs made against the old root become stale. The SDK already retries on `stale_asp_root` (`packages/sdk/src/sdk.ts:376`).

The admin command updates the config output. CAUTION: running it while Settles are pending drops them. The runbook must say to run it only when the sequencer has nothing pending. If it happens anyway, section 5.7 recovers.

### 5.7 Submitting, and recovering from failure

**Submit results.** The Blockfrost provider learns three classes of submit result:

| Class | Meaning | Example |
|---|---|---|
| `accepted` | The node took the transaction | HTTP 200 with a hash |
| `rejected` | The node refused it. It is not in any mempool we sent it to | HTTP 400 with a ledger error |
| `unknown` | We cannot tell | Timeout, network error, HTTP 5xx |

**Child sent before its parent arrived.** Blockfrost does not document whether every submit reaches the same backend node.
A child that reaches a node before its parent gets `BadInputsUTxO`.
So a `rejected` child with `BadInputsUTxO` is retried a few times, a few seconds apart, within about 20 seconds.
After that it counts as rejected.

**Every pool transaction and every ASP update gets an upper validity bound.** Settles already take it from the quote. The Insert and ASP update builders (`packages/txlib/src/insert.ts`, `packages/txlib/src/admin.ts`) gain one, about 10 minutes ahead. So nothing can stay pending forever.

**Finding a dropped transaction.** The provider gains one read: whether a transaction is still in the mempool.
Blockfrost answers it with `GET /mempool/{hash}`, which lists the transactions submitted through Blockfrost (blockfrost/openapi on GitHub). The FakeChain answers it from its own mempool.

**Each round, the sequencer reconciles** the pending list, oldest entry first, using the provider's transaction status:

1. `confirmed`: the entry leaves the list, and the walk goes on to the next one.
2. `mempool`: the entry is still waiting. The walk stops.
3. `unknown` on two reads in a row: the entry was dropped. The sequencer **resets**.

Another party spending the pool first needs no separate check. A node evicts a transaction whose input is gone, so it reads `unknown` and leads to a reset. A check on spent inputs would misfire while Blockfrost lags behind a new block, and reset a transaction that already landed.

The sequencer also resets when:

- an entry's upper validity bound has passed and the entry has not confirmed;
- a child stays `rejected` with `BadInputsUTxO` after its retries, because its parent is gone.

A transaction missing from Blockfrost's mempool might still land through another node. That is safe: the reset rebuilds on the new head, and the nullifier rule in section 4 lets only one version land. The next reconcile sees which one did.

**On a reset**, the sequencer empties the pending list and takes the new confirmed head. Then, for each Settle that was in the list:

- If its nullifier is now confirmed, it landed. Its status becomes `confirmed`, with the hash of the transaction that actually landed.
- If its quote is still valid, the sequencer builds it again on the new head and submits it. The status keeps the newest hash. Section 4 shows why this cannot pay twice.
- Otherwise its status becomes `failed`, and the SDK releases the note as it does today after a deadline.

A pending Insert or ASP update is simply dropped on a reset. The crank or the ASP service builds a new one in its next round.

**A rejected Settle waits for the rebuild.** If a Settle's submit ends `rejected`, for example because another party spent the pool first, the `settle()` call does not fail at once. It waits for the reset and the rebuild, within its quote deadline, as REL-05 expects today.

**`uncertain` keeps its meaning.** A submit with an `unknown` result still makes the request `uncertain`, as today. The sequencer keeps the entry as pending, so reconciling settles it either way.

### 5.8 The relayer request path

- `availablePool` and `pendingPool` go away. The relayer asks the sequencer for the head instead.
- The relayer's status answers do not change: `submitted`, `confirmed`, `failed`, `uncertain`.
- The relayer's own three-attempt loop for a lost race is replaced by the sequencer's reset, which covers the same case (REL-05).

### 5.9 The crank

- The crank builds on the head through the sequencer, so an Insert can chain on top of pending Settles.
- It keeps its rule that only one Insert is pending at a time.
- Its 180-second resubmit guard is replaced by the sequencer's reconcile and reset. The ASP service's 180-second guard goes the same way.

### 5.10 The SDK

One change. After a reset, a rebuilt Settle has a new transaction hash.
The stealth signer waits for its funding output by the first hash (`packages/sdk/src/x402.ts:57`, `u.ref.txId === receipt.txHash`), so it would never find a rebuilt one.
The signer drops the hash check and matches the output by the one-time address and the expected value only. Each one-time address is fresh and used once, so the match stays exact.

Nothing else changes.
The SDK proves against confirmed indexer data, and a proof stays valid across chained pool transactions (section 4).
It already retries on `stale_root`, `stale_asp_root` and `internal`.

### 5.11 The indexer

No change. It stays confirmed only.
The sequencer reads confirmed state from it and from the provider, and adds its own pending entries on top.

## 6. Tests

Write each test first and watch it fail. Use the test IDs below in the test names, and add the new IDs to `docs/TEST-PLAN.md`.

### FakeChain additions (`packages/txlib/src/testing/fake-chain.ts`)

- Mine only the first k transactions of the mempool, to model a full block.
- Drop one pending transaction on purpose, so its children drop too.
- Let a test see the mempool.

### Tests

| ID | Test |
|---|---|
| REL-06 | Two settles chain inside one block window. Both land in one `mineBlock()`. Existing ID, first relayer test |
| REL-07 | A dropped parent: the child drops too, the sequencer resets, and both settles are rebuilt and land before their deadlines |
| REL-08 | Another party spends the pool first: the sequencer resets, and the still-valid settles land on the new head |
| REL-09 | A settle never pays twice: after a reset, the rebuilt and the original transaction cannot both land |
| REL-10 | The ASP gate: no ASP update while a Settle references the ASP output, and no Settle while an ASP update is pending |
| CRK-04 | An Insert chains on top of pending Settles and lands in the same block |
| TX-xx | The Blockfrost provider sorts submit results into `accepted`, `rejected` and `unknown`, and retries a child that gets `BadInputsUTxO` |
| TX-xx | The provider reports whether a transaction is in the mempool, on Blockfrost and on the FakeChain |
| TX-xx | The Insert and ASP update builders set an upper validity bound |
| SDK-xx | The stealth signer finds a funding output whose Settle was rebuilt with a new hash |

### Existing tests

The requirements stay. The mechanisms change. So:

- Tests of a requirement keep their ID and their meaning.
- A test that checks a removed mechanism is rewritten to check the new one, under the same ID. AGENTS.md says the Spec changes first, in the same pull request.
- The known cases:
  - CRK-01, "a dropped insertion retries after the default delay" (`services/crank/test/crank.test.ts:171-190`): now the sequencer's reset recovers it.
  - REL-05, the three pool reads before `uncertain` (`services/relayer/test/relayer.test.ts:595-662`): now the reset and rebuild, inside the same `settle()` call.
- REL-04's immediate `queue_full` does not change.
- New tests set `maxPending` above 1. Everything else runs with `maxPending: 1`.

## 7. Measurement on Preprod

1. Fund the pool with at least 5 notes that can be spent.
2. Send 5 settle requests at the same time, first with `maxPending: 1`, then with `maxPending: 4`.
3. For each run, record the number of blocks used, the time until all 5 settles are confirmed, and every transaction hash.
4. Add both runs to `docs/measurements.md`.

If chaining through Blockfrost proves unreliable, record that too. It decides whether we need our own node before mainnet.

## 8. Documents to update

- `docs/SPEC.md` 8.2: replace the "M0 status: the relayer does not chain" line with the sequencer behavior. Add the ASP gate to 8.5.
- `docs/HANDOFF.md`: remove the "relayer does not chain" known limit, and add the new one: at most one Insert pending.
- `docs/TEST-PLAN.md`: the new IDs.
- `docs/RUNBOOK.md`: run the admin command only when nothing is pending.
- `docs/measurements.md`: the Preprod runs.

## 9. Build order

Each step is one small commit with its tests:

1. This design.
2. FakeChain additions, with their own tests.
3. The provider: submit result classes, the retry for `BadInputsUTxO`, and the mempool read. Upper validity bounds on the Insert and ASP update builders.
4. The sequencer: head, pending list, reconcile and reset. Unit tests on the FakeChain.
5. The relayer builds through the sequencer. REL-06 to REL-09, and the rewritten REL-05.
6. The crank builds through the sequencer. CRK-04, and the rewritten CRK-01.
7. The ASP service submits through the sequencer, with the gate. REL-10.
8. The SDK signer matches by address.
9. The Spec, handoff, test plan and runbook updates.
10. The Preprod measurement, then the default of `maxPending` changes to 4.

## 10. Left to the builder

- The sequencer's module location, types and function names.
- How the nullifier trie is cached, as long as it includes the pending nullifiers.
- Exact retry delays, within the bounds in section 5.7.
- How the node passes `maxPending` in (environment variable or option).
- How a confirmed status finds the hash of the transaction that landed (indexer or chain read).

## 11. Calls the lead made

A reviewer read this design as a builder. These answers came from the lead, not the owner, so the owner can check them:

1. The SDK changes in one place: the stealth signer matches by address and value, not by hash (section 5.10).
2. A dropped transaction is found through Blockfrost's mempool read, and every pool transaction and ASP update gets an upper validity bound (section 5.7).
3. No second code path for the old behavior. Tests of removed mechanisms are rewritten under the same IDs (section 6).
4. `queue_full` stays an immediate refusal, as today (section 5.3).
5. A rejected Settle waits inside `settle()` for the rebuild, as REL-05 expects today (section 5.7).
