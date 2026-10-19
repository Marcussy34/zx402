# zx402: Test Plan

| Field | Value |
|---|---|
| Status | v1.0, 2026-10-06 |
| Covers | Release M0 (mainnet canary) and the public frontend |
| Companions | [SPEC.md](./SPEC.md), [TEST-VECTORS.md](./TEST-VECTORS.md), [PLAN-M0.md](./PLAN-M0.md), [RUNBOOK.md](./RUNBOOK.md) |

Every rule in the Spec has at least one test that passes when the rule holds and one that fails when it is broken.
Test IDs are stable. Use them in test names, commit messages, and reviews.

## 1. Rules for writing these tests

- Write the failing test first. Watch it fail. Then write the code.
- A negative test must fail for the stated reason. Check the reason, not only the failure.
- Validator tests use real proofs as fixtures. A mocked verifier hides real bugs.
- Each negative validator test changes one thing from a passing transaction.
- Never weaken a test to make it pass. Fix the code or fix the Spec.

## 2. Layers

| Layer | Tool | Runs where | Network |
|---|---|---|---|
| Public frontend | Vitest, React Testing Library, browser checks | `apps/web` | None |
| Crypto library | Node test runner | `packages/crypto` | None |
| Circuits | circom, snarkjs, Node test runner | `circuits` | None |
| Validators | `aiken check` | `contracts` | None |
| Transaction builders | Node test runner, local script evaluation with the pinned Aiken | `packages/txlib` | None, with a fake chain |
| Services and SDK | Node test runner | `services/*`, `packages/sdk` | None, with a fake chain |
| Rehearsal | Node test runner, real HTTP, the stock x402 seller | `ops` | None, with a fake chain |
| End to end | The runbook | Preprod first, then mainnet | Preprod, then mainnet with capped funds |

No pool UTXO exists on mainnet before deployment, so the transaction builder tests cannot evaluate against mainnet state.
They run against an in-memory chain and evaluate scripts locally. Evaluation through a mainnet provider is part of the runbook.

## 3. Crypto library (`CRY`)

| ID | Test | Source of truth |
|---|---|---|
| CRY-01 | `h1`, `h2`, `h3` match the known answers | TEST-VECTORS section 2 |
| CRY-02 | `ZERO_HASHES[0..32]` match, and `ZERO_HASHES[32]` is the empty root | TEST-VECTORS section 3 |
| CRY-03 | The note example gives the listed precommitment, commitment, and nullifier hash | TEST-VECTORS section 4 |
| CRY-04 | Tree roots and paths match for the one-leaf and two-leaf examples | TEST-VECTORS section 5 |
| CRY-05 | `labelFor` matches both label vectors | TEST-VECTORS section 6 |
| CRY-06 | `intentBytes` and `contextFor` match both context vectors | TEST-VECTORS section 7 |
| CRY-07 | `nullifierKey` gives 32 big-endian bytes for both vectors | TEST-VECTORS section 8 |
| CRY-08 | `proofToCardano` and `vkToCardano` give the listed compressed bytes | TEST-VECTORS section 9 |
| CRY-09 | Key derivation matches the known answers, is deterministic, and different indexes give different secrets | SPEC 4.7, TEST-VECTORS section 10 |
| CRY-10 | Every encoder rejects out-of-range input: amount of 2^64, index of 2^32, wrong hash length, pointer address | SPEC 4.8 |

## 4. Circuits (`CIR`)

One positive test per circuit, then one negative test per constraint. Numbers follow SPEC section 5.

| ID | Circuit | Test |
|---|---|---|
| CIR-P01 | all | Poseidon255 in circom equals the TypeScript library on the shared vectors |
| CIR-O01 | all | The generated public signal order file matches SPEC 5.1, 5.2, 5.3 |
| CIR-S00 | spend | A valid partial spend and a valid full spend both prove and verify |
| CIR-S01 | spend | A wrong `existingValue`, `label`, or secret breaks the commitment and fails |
| CIR-S02 | spend | A wrong state path or a wrong `stateRoot` fails |
| CIR-S03 | spend | A label that is not in the ASP tree fails |
| CIR-S04 | spend | `label = 0` fails, even with a path to an empty ASP leaf |
| CIR-S05 | spend | A `nullifierHash` that does not match the nullifier fails |
| CIR-S06 | spend | `withdrawnValue` above `existingValue` fails |
| CIR-S07 | spend | A value of 2^64 or more fails the range check |
| CIR-S08 | spend | A `newCommitment` with a wrong remaining value or label fails |
| CIR-S09 | spend | `newNullifier` equal to `existingNullifier` fails |
| CIR-S10 | spend | The same witness with a different `context` gives a proof that fails under the first context |
| CIR-I00 | insert | Valid batches prove: 1 note, 4 notes, 1 deposit, 4 deposits, 2 notes then 2 deposits |
| CIR-I01 | insert | A gap in the used slots fails. An empty slot 0 fails |
| CIR-I02 | insert | An empty slot with a non-zero `v` or `l` fails |
| CIR-I03 | insert | A note slot with a non-zero `v` fails |
| CIR-I04 | insert | A deposit `v` of 2^64 or more fails |
| CIR-I05 | insert | A deposit leaf that is not `H3(v, l, x)` gives a different root, so the claimed `newRoot` fails |
| CIR-I06 | insert | A path whose slot is not empty under the running root fails |
| CIR-I07 | insert | A wrong `startIndex` fails |
| CIR-I08 | insert | A wrong `newRoot` fails |
| CIR-R00 | ragequit | A valid proof verifies |
| CIR-R01 | ragequit | A wrong `value` or `label` fails |
| CIR-R02 | ragequit | A wrong path or root fails |
| CIR-R03 | ragequit | A wrong `nullifierHash` fails |

## 5. Verifier module (`VER`)

| ID | Rule | Test |
|---|---|---|
| VER-00 | V4 | Both proofs from TEST-VECTORS section 9 verify |
| VER-01 | V1 | A public input of `x + r` is rejected. A negative input is rejected |
| VER-02 | V2 | A point of the wrong length and the point at infinity are each rejected. Bytes that are not a valid point fail the script |
| VER-03 | V3 | One input too few and one input too many are each rejected |
| VER-04 | V4 | A tampered proof and a wrong public input are each rejected |
| VER-05 | V5 | A proof with a zero public input verifies, and the zero input costs no scalar multiplication |
| VER-06 | V6 | Verifying the 2-input vector costs at most 2.2B CPU. This fails when a curve point passes through an `Option` or a list |

## 6. On-chain encodings (`ENC`)

| ID | Test |
|---|---|
| ENC-01 | `label` in Aiken matches both label vectors |
| ENC-02 | `context` in Aiken matches both context vectors |
| ENC-03 | `nullifier_key` in Aiken matches both vectors |
| ENC-04 | `context` fails on a payout address with a pointer stake credential |
| ENC-05 | `context` fails on an amount of 2^64 or more and on a datum hash that is not 32 bytes |

## 7. Pool validator (`POOL`)

Each ID is `POOL-` plus the rule number from SPEC 6.5. Each row is one negative test unless marked.

| ID | Test |
|---|---|
| POOL-I0 | Positive: Insert of notes, of deposits, and of a mix all pass |
| POOL-S0 | Positive: a partial settle, a full settle, and a settle with four payouts all pass |
| POOL-R0 | Positive: a ragequit of a deposit note and of a change note both pass |
| POOL-C0 | Positive: CollectFees of part and of all accrued fees pass |
| POOL-P1 | The validator's own input lacks the pool NFT |
| POOL-P2 | Output 0 has another address, or lacks the NFT |
| POOL-P3 | The continuing output carries a foreign token |
| POOL-P4 | The continuing datum differs in any one field |
| POOL-P5 | The config reference input is missing, or carries a fake NFT |
| POOL-I1 | Zero slots, five slots, or `flush` above the queue length |
| POOL-I2 | A deposit is absorbed while deposits are paused |
| POOL-I3 | A deposit has a bad datum, a precommitment of 0, or a precommitment of `r` |
| POOL-I4 | A deposit is below the minimum or above the maximum |
| POOL-I5 | The credited value is wrong by 1 lovelace |
| POOL-I6 | A label is computed from a wrong reference, refund key, or pool ID |
| POOL-I7 | Slots are in the wrong order, or a note sits after a deposit |
| POOL-I8 | The old root or the size passed to the proof is wrong |
| POOL-I9 | The proof is invalid |
| POOL-I10 | The new datum drops a wrong number of queue entries, or the root history exceeds 16 |
| POOL-I11 | The pool balance grows by more or less than the credited sum |
| POOL-I12 | The pool cap is exceeded |
| POOL-S1 | A deposit input is present |
| POOL-S2 | The state root is not in the history |
| POOL-S3 | The ASP reference input is missing, fake, or holds another root |
| POOL-S4 | `withdrawn` is 0 or 2^64, or `new_commitment` is 0, or an input is `x + r` |
| POOL-S5 | The pool ID in the intent is wrong, or the payout list is empty or has five entries |
| POOL-S6 | The context is computed from a different intent |
| POOL-S7 | The proof is invalid |
| POOL-S8 | The nullifier hash is already in the set, or the nullifier proof is wrong |
| POOL-S9 | The queue is full, or the new commitment is not appended |
| POOL-S10 | A payout goes to another address, pays 1 lovelace less or more, has a wrong datum, or carries a reference script |
| POOL-S11 | Payouts plus the protocol fee exceed `withdrawn` |
| POOL-S12 | The pool balance falls by a wrong amount, or `fees_accrued` is wrong |
| POOL-S13 | The validity bound is missing or later than `valid_until` |
| POOL-S14 | A relayer is named but did not sign |
| POOL-S15 | `roots` or `size` changes |
| POOL-R1 | A deposit input is present |
| POOL-R2 | The state root is not in the history |
| POOL-R3 | The refund key did not sign, or the label comes from another reference |
| POOL-R4 | `value` is 0 or 2^64 |
| POOL-R5 | The proof is invalid |
| POOL-R6 | The nullifier hash is already in the set |
| POOL-R7 | The pool balance falls by more than `value` |
| POOL-R8 | Any other datum field changes |
| POOL-C1 | A deposit input is present |
| POOL-C2 | `amount` is 0 or above `fees_accrued` |
| POOL-C3 | The treasury output is missing or too small |
| POOL-C4 | The pool balance or `fees_accrued` falls by a wrong amount |

## 8. Other validators

| ID | Test |
|---|---|
| DEP-01 | Absorb fails when no input holds the pool NFT |
| DEP-02 | Refund fails without the refund key signature, and passes with it |
| DEP-03 | A deposit cannot be spent in a transaction that runs Settle, Ragequit, or CollectFees |
| CFG-01 | A config update fails below the admin threshold |
| CFG-02 | A config update fails when a fee or the crank fee exceeds its hard cap |
| CFG-03 | A config update fails when the NFT leaves the config address |
| ASP-01 | An ASP update fails below the operator threshold |
| ASP-02 | An ASP update fails with a root of `r` or more |
| ASP-03 | An ASP update fails when the NFT leaves the ASP address |
| NFT-01 | Minting fails when the seed UTXO is not spent |
| NFT-02 | Minting fails unless exactly the three NFTs are minted, one of each |

## 9. Budgets (`BUD`)

Each test asserts an upper bound on CPU and memory for a realistic worst case.

| ID | Transaction | CPU bound | Memory bound |
|---|---|---|---|
| BUD-01 | Settle with 4 payouts, queue at 7, trie proof for one million entries | 3.5B | 2.5M |
| BUD-02 | Insert with 4 deposits | 4.5B | 2.5M |
| BUD-03 | Insert with 4 notes | 3.3B | 1.5M |
| BUD-04 | Ragequit | 3.2B | 2.5M |

If a bound cannot be met, change the Spec estimate first, then the bound.

## 10. Transaction builders (`TX`)

| ID | Test |
|---|---|
| TX-01 | Init builds, balances, and creates the three UTXOs with the genesis datums |
| TX-02 | Deposit builds a plain payment with the inline `DepositDatum` |
| TX-03 | Refund builds and needs only the refund key |
| TX-04 | Insert builds for notes, for deposits, and for a mix, and evaluates within budget |
| TX-05 | Settle builds with 1 and 4 payouts, sets the validity bound, and evaluates within budget |
| TX-06 | Ragequit builds and requires the refund key signature |
| TX-07 | CollectFees, config update, and ASP update build and evaluate |
| TX-08 | No pool transaction contains a mint, a withdrawal, or a certificate |
| TX-09 | The stealth leg-2 payment has one input, one output, and a fee equal to input minus price |
| TX-12 | The FakeChain mines part of its mempool and drops a transaction with its descendants |
| TX-13 | The FakeChain reports a transaction as in the mempool, confirmed, or unknown, and a spent input is a `SubmitRejected` with reason `bad_inputs` |

## 11. Services and SDK

| ID | Test |
|---|---|
| IDX-01 | The indexer rebuilds leaves, labels, nullifiers, and pool state from recorded chain data |
| IDX-02 | Leaf order equals insertion order, and the rebuilt root equals the on-chain root |
| IDX-03 | A rollback removes the rolled-back entries and restores the previous state |
| CRK-01 | The crank triggers on the conditions in SPEC 8.3 |
| CRK-02 | The crank builds a correct batch of queued notes, then deposits |
| CRK-03 | The crank skips deposits that Insert would reject |
| REL-01 | A quote covers payouts, the protocol fee, and the relayer fee |
| REL-02 | A settle with a valid proof is built and submitted |
| REL-03 | A settle with an invalid proof or a mismatched intent is refused before building |
| REL-04 | A stale state root or ASP root returns the matching error code |
| REL-05 | When another party spends the pool UTXO first, the relayer rebuilds and submits again |
| REL-06 | Two settles chain inside one block window |
| SDK-01 | All notes are recovered from the seed plus indexer data |
| SDK-02 | Sync downloads leaves in pages and never sends a commitment to the server |
| SDK-03 | `settlePrivately` proves locally and never sends a secret |
| SDK-04 | The stealth signer returns a valid x402 payload whose nonce is the one-time UTXO |
| SDK-05 | The SDK refuses to prove when the approved set is under the threshold |
| SDK-06 | The SDK proves again after `stale_root` or `stale_asp_root` |
| SDK-07 | The SDK rejects a payout below the minimum ADA and a pointer address before proving |
| SDK-08 | The SDK spends the larger note when two notes share a nullifier |
| MON-01 | The solvency monitor raises an alert when a fake discrepancy is injected |

## 12. End to end on mainnet (`E2E`)

`E2E-01` to `E2E-17` are the [mainnet canary steps](./RUNBOOK.md#11-mainnet-canary), in order. Each step lists its pass check there.
The same runbook gives the exact commands for the Preprod test network.

### Rehearsal on the local chain

`ops/test/rehearsal.test.ts` plays runbook steps 4 to 13 on the local chain: deploy, the node, the stock x402 seller, and the demo, through real HTTP.
Its cases reuse four IDs for what they check:

| ID in the rehearsal | What it checks |
|---|---|
| E2E-01 | The seller answers HTTP 200 and holds exactly its price. No transaction that pays the seller touches the wallet. The HTTP traffic of the node holds no note secret. |
| E2E-02 | The exit returns the rest. The pool ends with its reserve plus fees. |
| E2E-03 | A second run on the same chain and store works. |
| E2E-04 | The node keeps running when one round fails. |

### Admin actions (`ADM`)

| ID | Test | Where |
|---|---|---|
| ADM-01 | Pause and unpause through a config update. A missing admin signature fails. A value outside the bounds is refused. | `packages/txlib/test/admin.test.ts` |
| ADM-02 | Fee collection pays the treasury and lowers the pool by exactly the amount. More than the accrued fees is refused. | same file |
| ADM-03 | During a pause an Insert of a deposit fails, and a Settle still confirms. | same file |
| OPS-ADM-01 to 03 | The admin command: pause twice, no fees to collect, and a sweep that takes only this pool's reference outputs. | `ops/test/admin.test.ts` |

## 13. Invariant coverage

| Invariant | Tests |
|---|---|
| INV-1 Solvency | POOL-I11, POOL-S12, POOL-R7, POOL-C4, MON-01 |
| INV-2 No double spend | POOL-S8, POOL-R6, VER-01, ENC-03 |
| INV-3 Tree integrity | POOL-I8, POOL-I9, POOL-S15, CIR-I06, CIR-I07, CIR-I08 |
| INV-4 Value binding | POOL-I5, CIR-I05 |
| INV-5 Spend validity | CIR-S01 to CIR-S09, POOL-S7 |
| INV-6 Intent binding | POOL-S6, POOL-S10, CIR-S10, ENC-02 |
| INV-7 Exit liveness | POOL-R0, E2E-12, CRK-01 |
| INV-8 Isolation | DEP-01, DEP-03, POOL-P3 |
| INV-9 Immutability | Review of deployed script hashes against the manifest |
| INV-10 Bounded admin | CFG-01, CFG-02, CFG-03, POOL-I2 |

## 14. Public frontend (`FE`)

These checks cover SPEC 8.10. Run automated checks with `npm test` from the repo root.

| ID | Test |
|---|---|
| FE-01 | The landing page renders its sections, `In development` status, ADA-first scope, and the default privacy facts: note secrets stay on the agent's machine; the relayer gets a proof and an intent |
| FE-02 | Every `Read docs` link opens the documentation site at `https://docs.zx402.org/`, and a visit to `/docs` on the landing redirects there without rendering the page |
| FE-03 | Mobile navigation opens and closes with accessible controls; Escape closes it and returns focus to the trigger; selecting an anchor closes it |
| FE-04 | The How it works overview presents one connected diagram on first render with one shared pool, the full funding path, a local proof authorization branch, and no step-selection interaction |
| FE-05 | FAQ items disclose and hide their answers with keyboard controls |
| FE-06 | Retired. The documentation reader was replaced by the documentation site at `https://docs.zx402.org/` |
| FE-07 | Manual browser check: scrolling forward and back moves the character scene, intro word contrast, and illustrations; headings and cards reveal in a stagger; desktop and mobile layouts have no horizontal overflow or characters obscuring content; native scroll and anchor links work; navigation, payment orbit, FAQ, and docs work with a keyboard; focus reveals its content; reduced motion disables decorative animation |
| FE-08 | Scroll updates decorative transforms and intro word contrast; `Pause motion` freezes those transforms and reveals all content; resuming applies the current scroll position |
| FE-09 | Reduced motion shows a static, readable layout and disables JavaScript scroll animation listeners; changing the preference while the page is open updates the behavior; missing motion APIs or observers leave content visible |
| FE-10 | Unmounting cleans up motion listeners, observers, and pending animation frames; remounting starts one working set without duplicate updates |
| FE-11 | The hero exposes the unchanged readable headline to assistive technology. Pointer entry never replaces the word. Smoke layers are decorative. Manual browser checks cover flat readable type and visibly rolling smoke wisps that cross the word in independently phased automatic loops with gentle opacity changes. The smoke disperses on hover and returns on exit. Touch screens keep automatic motion without requiring hover. Pause freezes the wisps; reduced motion keeps clear, still lettering. No mode causes layout shift or overflow |
| FE-12 | The payment path starts with a dotted ring, reveals six nodes in order, dims prior nodes, and moves the detail card beside the active node. A shared later scroll interval flips the center portrait into the `Zx402Mark` and all six nodes into portrait variants at once. The outer ring and nodes turn together while portraits stay upright. The sequence reverses with scroll and stays pinned through completion. Keyboard focus and selection reveal the matching explanation and hold until another scroll stage. Pause, reduced motion, missing APIs, and scenes too large to pin keep all six manual controls and readable content. Unmounting removes listeners, observers, and frame callbacks. Manual browser checks verify moving cards stay clear of the centered ring, dimmed nodes remain opaque over the dotted line, the flip sequence, and mobile layout without overflow |
| FE-13 | The footer groups working Explore and Resources links, retains the development status, and sends Read docs to the documentation site |
| FE-14 | The payment overview shows one connected diagram immediately, with one shared pool and no numbered cards, marked live on Preprod. Its on-chain lines connect wallet and shared pool in both directions (deposit and withdraw), relayer to pool (submits the proof), pool to one-time key (pays out, unlinkable), and one-time key to x402 seller (pays the seller). Its web request lines connect agent and seller (price quote and delivery) and agent and relayer (fee quote and proof). The private note and proof generation stay with the agent, and only the proof reaches the relayer. On-chain and web lines use distinct line treatments, the unlinkable lines a distinct color, and the legend names all three. Each node carries a caption. The whole diagram remains complete with reduced motion and missing motion APIs, installs no scroll animation listeners, and has no pinned scene or progressive content. Observer checks verify diagram activation, offscreen pausing, and cleanup. Manual checks verify the softly feathered mint Soffit background, clear flat glyphs and agent portrait, one coordinated decorative packet loop in flow order, shared pause control, and readable desktop and phone reflow without horizontal overflow |
| FE-15 | The privacy boundary distinguishes local note secrets from the proof and intent sent to the relayer. Public amounts, recipients, and timing remain explicit. The privacy model link has a working destination. The visual fits desktop and mobile without hiding its explanation |
| FE-16 | Manual visual asset check: every portrait use draws from one nine-cell atlas of calm, stealthy companions. Rounded shapes stay approachable, with charcoal and slate clothing, restrained lavender and sage accents, hoods, scarves, or visors, concealed lower faces, and small subtle eyes. Variants remain recognizable at desktop and phone sizes. Artwork has no photorealistic humans, menacing black voids, skulls, or weapons. The scenic footer uses a matching discreet companion and rounded landscape in muted lavender and slate tones with a warm twilight glow. Existing desktop and phone crops keep portraits and the footer companion visible and the invitation readable. Character motion, footer parallax, pause, and reduced motion behavior remain intact, and artwork does not obscure text |
| FE-17 | The Soffit renderer uses the approved muted mint palette with no bright corner glow and the supplied motion parameters. It draws one triangle with DPR capped at 1, pauses offscreen, in hidden tabs, and under the shared pause or reduced motion setting. No-WebGL and lost-context cases preserve a static backdrop and readable content. Resize and unmount release listeners, observers, frames, and GPU resources. Browser checks verify the actual shader, pointer response, soft edge fade, and desktop and phone legibility |
| FE-18 | Manual visual icon check: every landing section uses the refined custom geometric SVG family. Diagram pictograms have distinct crisp silhouettes, clear negative space, and flat muted lavender, sage, and charcoal fills. Icons have no gradients, highlights, drop shadows, faces, or toy-like details. The `Your agent` node in the connected How it works diagram is the exception: it uses an existing companion portrait with a clean crop and readable label. Other icons retain the flat geometric style, including the single shared pool mark. Small custom rounded controls remain clear at their displayed size. The zx402 and Cardano marks remain recognizable. Desktop and phone layouts keep icons and the agent portrait legible on dark and mint backgrounds without clipping or overflow. The payment orbit, connected funding and proof branches, and privacy boundary retain their meaning. Decorative icons stay hidden from assistive technology, and navigation, FAQ, links, and motion controls retain their accessible names and keyboard behavior. Existing animation and pause behavior remain intact, with no new icon motion |
| FE-19 | The developer entry card includes an existing stealth companion portrait, the title `Build with zx402.`, the copy `Give your coding agent the setup guide.`, and the status `Preprod developer preview`. It displays the exact selectable command `curl -fsSL https://raw.githubusercontent.com/Marcussy34/zx402/main/setup.md`, which reads documentation without executing or installing it. `Copy command` writes that exact command to the clipboard, announces success in a live region, and clears the notice. Missing clipboard access and rejected clipboard writes each leave the command visible and selectable and announce a fallback. `View setup guide` opens the repository root setup.md. There is no long setup prompt or disclosure. The menu anchor still works. Manual desktop and phone checks verify the portrait, concise copy, command, controls, and keyboard focus remain readable without clipping or horizontal overflow |
