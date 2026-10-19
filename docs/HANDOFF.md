# Handoff: start here

| Field | Value |
|---|---|
| For | The engineer who builds zx402 |
| From | Marcus |
| Date | 2026-10-07 |
| State of the repo | M0 uses the tUSDM pool on Preprod. The ADA pool of 2026-10-06 and the first tUSDM pool of 2026-10-07 are retired; their records are in `deployments/retired/`. The public landing page links to docs.zx402.org. The documentation reader is retired. Mainnet is not deployed yet |

## 1. What you are building

zx402 lets an AI agent pay on Cardano mainnet without showing which wallet paid.
The agent deposits into a shared pool, then pays from the pool with a zero-knowledge proof.
The first release is a capped pool for team funds, called M0. It uses tUSDM on Preprod; the same validators support ADA pools.
It adapts the Privacy Pools rail that runs on Base today to Cardano's limits.

The transaction builders and quote field support token payouts.
The SDK signer, deploy command, demo and seller support the pool's asset. SPEC 8.2, 9.2 and 16 describe the token rules.
The ADA pool of 2026-10-06 and the first tUSDM pool of 2026-10-07 are retired; their records are in `deployments/retired/`. The runbook explains how each record selects its reference outputs for a sweep.

## 2. Read in this order

| # | Document | Time | Why |
|---|---|---|---|
| 1 | [PRD.md](./PRD.md) | 15 min | What we build, for whom, and what is out of scope |
| 2 | [SPEC.md](./SPEC.md) | 60 min | The design. Sections 4 to 7 are the rules you implement |
| 3 | [TEST-VECTORS.md](./TEST-VECTORS.md) | 10 min | Known answers your code must reproduce |
| 4 | [TEST-PLAN.md](./TEST-PLAN.md) | 15 min | Every test, with a stable ID |
| 5 | [PLAN-M0.md](./PLAN-M0.md) | 20 min | Work packages, interfaces, and done criteria |
| 6 | [SETUP.md](./SETUP.md) | 10 min | Tools, versions, and known pitfalls |
| 7 | [RUNBOOK.md](./RUNBOOK.md) and [CEREMONY.md](./CEREMONY.md) | 15 min | How M0 goes to mainnet |
| 8 | [research/](./research/) | as needed | The evidence behind each number |

[AGENTS.md](../AGENTS.md) holds the hard rules. Read it before you write code.

## 3. What is decided

The owner approved the design on 2026-10-06. SPEC section 2 lists each decision with its reason. The main ones:

- Groth16 over BLS12-381, with circom and snarkjs.
- The Privacy Pools note model, the same as the Base implementation.
- The validator never computes Poseidon. A second proof covers each tree update.
- Deposits are ordinary payments. Anyone can insert them with a proof.
- Spent notes are tracked in one Merkle Patricia Forestry root.
- Stealth mode is the default x402 path: the pool pays a one-time key, and that key pays the seller.
- The agent proves on its own machine.
- Scripts are immutable. The admin can only pause deposits and tune bounded values.

## 4. What is verified and what is assumed

| Claim | Status | Where |
|---|---|---|
| A Groth16 check fits a transaction (about a quarter of the CPU limit) | Measured | [measurements.md](./measurements.md#before-the-build-the-first-measurements) |
| On-chain Poseidon does not fit (1.27B CPU per hash) | Measured | Same file |
| Live mainnet limits and prices | Read from the chain on 2026-10-06 | research/data/koios-mainnet-epoch-params.json |
| A snarkjs proof on `bls12-381` verifies in Aiken after conversion | Verified in an Aiken test | research/spikes/groth16-pipeline |
| Poseidon255 in circom equals the TypeScript library | Verified, 26 of 26 checks | research/spikes/poseidon-vectors |
| The trie library compiles with Aiken 1.1.24 | Verified | Same pipeline spike |
| An input of `x + r` verifies when the range check is missing | Verified by a control test | Same pipeline spike |
| Label and context encodings | Defined, with vectors from a reference script | TEST-VECTORS sections 6 and 7 |
| The stock TypeScript x402 facilitator accepts the stealth payment | Verified on Preprod, four runs through the stock seller | measurements.md, section 3 |
| Fees of about 1.0 to 1.2 ADA per private payment | Measured on Preprod: 0.85 ADA for the two legs, plus a share of one Insert | measurements.md, sections 3 and 5 |
| Circuit sizes | Measured: spend 16,828, insert 62,950 and ragequit 8,423 constraints | measurements.md, section 1 |
| Mesh can build the Settle transaction | Verified on Preprod. Two defects of Mesh 1.9.1 are worked around in `packages/txlib` | AGENTS.md, Cardano knowledge |
| The port keeps the safety rules of the Base implementation | Checked on 2026-10-07 by the lead and by two independent reviewers, rule by rule against the Base contracts. They found no way to move value without a valid proof. They found weaknesses outside the validators. Five were fixed, and section 5 lists the others | [COMPARISON-WITH-BASE.md](./COMPARISON-WITH-BASE.md) |
| The community powers of tau file is usable | Not verified | CEREMONY section 2 |

The three circuits, the validators, the services and the SDK are written and run on Preprod.
Nobody outside this project has reviewed the design or the code.

The public frontend is in `apps/web`. It explains the design, distinguishes Preprod from mainnet, and marks the project as `In development`.
Its main action, `Read docs`, opens `https://docs.zx402.org/`. Paths starting with `/docs` redirect there without rendering the landing page.
It uses one nine-cell atlas of stylized anonymous companions across the landing page. Rounded shapes stay approachable, while charcoal and slate clothing, restrained lavender and sage accents, hoods, scarves, visors, concealed lower faces, and subtle eyes give the characters a calm, stealthy appearance. The artwork avoids photorealistic humans and menacing black voids. Existing portrait crops and motion remain. It has scroll-driven character motion, one connected payment overview with animated packets, a visual privacy boundary, a six-node payment path, flat headline lettering with visibly rolling smoke wisps that clear on hover, and a scenic footer. The smoke moves automatically in independently phased loops with gentle opacity changes. It keeps the word readable and respects touch, pause, and reduced motion settings. The footer carries the same discreet companion style into a rounded landscape, with muted lavender and slate tones, a warm twilight glow, subtle parallax, and room for the `Move freely.` invitation.
The landing page uses a refined custom geometric SVG icon family. Diagram pictograms use flat muted lavender, sage, and charcoal fills, crisp silhouettes, and clear negative space. Icons have no gradients, highlights, drop shadows, faces, or toy-like details. Small controls use clear rounded marks. The zx402 and Cardano identities remain recognizable. Decorative icons remain hidden from assistive technology, and controls keep their labels and keyboard behavior.
Single-agent sections use different atlas portraits: the beanie and sage scarf in How it works, the lavender visor in the payment path, and the sage bucket hat in the developer entry card. Their crops and labels stay readable, and the other icons keep the flat geometric style.
The landing page uses short copy, a compact release-status row, three collapsed FAQ answers, and two footer link groups. Detailed explanations stay in the docs.
A developer entry section before the FAQ uses one subdued charcoal and lavender card with a stealth companion portrait. It says `Build with zx402.` and `Give your coding agent the setup guide.`, with a `Preprod developer preview` status. One selectable command, `curl -fsSL https://raw.githubusercontent.com/Marcussy34/zx402/main/setup.md`, reads the root setup guide without installing or executing anything. `Copy command` copies it and announces the result. If copying fails or clipboard access is missing, the visible command remains selectable with a fallback notice. `View setup guide` opens the repository file. There is no long prompt or disclosure. The setup and SDK guides explain the unpublished workspace packages, required pool access and matching proving files, and local seed and note-store handling.
The borderless How it works section uses the Soffit gradient in muted mint with soft edges and no bright corner flare. One large connected diagram shows funds moving from the wallet to one shared pool, then through a one-time key to the x402 seller. A separate authorization branch shows the agent keeping its private note and generating a proof locally, sending only proof and intent to the relayer, and the relayer submitting the proof to the pool. Short labels and different line treatments distinguish funds from proof. The whole diagram is visible immediately, with no numbered cards, loading sequence, or scroll interaction. One coordinated decorative packet loop pauses offscreen and follows shared pause and reduced motion settings. The diagram reflows on phones without horizontal overflow. Only the payment orbit stays pinned through its sequence when it fits the viewport. Compact screens retain readable manual orbit controls.
The centered payment orbit starts as a dotted ring. Scroll reveals each step and moves its detail card, then flips the center into the `Zx402Mark` and all outer nodes into portraits at the same time while the outer ring turns. The full sequence reverses on upward scroll. Dimmed node faces stay opaque over the dotted ring.
The pause control and reduced motion setting keep every section readable.
It has no wallet connection or transaction functions. See SPEC 8.10 and tests FE-01 to FE-19.

To work on the frontend, run these commands from the repo root:

```sh
npm ci
npm run dev
npm test -w apps/web
npm run build
```

`npm test -w apps/web` runs the frontend checks. `npm test` runs all workspace tests.

## 5. Where the build stands

M0 is built. On 2026-10-06 the whole product ran on the Preprod test network.

What works, with tests and a live run:

- The three circuits, with a key setup for development and one per network.
- The pool validator with all four actions, and the deposit, config, association set and token validators. 354 Aiken checks.
- The transaction builders, a Blockfrost provider, and a local test chain that runs the real validators and the ledger rules that bit us on the live network.
- The indexer, the crank, the association set provider service and the relayer, as one node.
- The agent SDK with the stealth x402 signer.
- Deploy, the demo and the admin command. [RUNBOOK.md](./RUNBOOK.md) has the commands.
- More than 980 JavaScript tests. The test in `ops/test/rehearsal.test.ts` plays the whole story through real HTTP.

What is left before the mainnet canary:

1. A mainnet Blockfrost project and a funded operator key. Then the commands of the runbook with `NETWORK=mainnet`.
2. A key setup with several parties, before anyone outside the team deposits. [CEREMONY.md](./CEREMONY.md) describes it. The setup command in this repository has one party.
3. The proving keys of a pool are not in the repository. Publish them, for example as release files, so that other people can use the pool.
4. The solvency monitor of the runbook is not built.
5. The start state of the pool is not enforced on chain. Bind it before anyone outside the team deposits. One way is token names that carry the script hashes, with a minting policy that checks the first datums. That means a new pool.

Known limits of M0, each a deliberate cut:

- The builders preserve 6 ADA in the token pool UTXO, but the validators do not pin that amount. The relayer or crank could lower it to the ledger minimum, about 5.2 ADA. They cannot bypass the token balance rules.
- The node chains up to `ZX402_MAX_PENDING` pool transactions (default 1). At most one Insert is pending at a time.
- The sequencer keeps its pending list in memory. After a restart the first submit can be refused once, then the relayer rebuilds on the next head.
- The sequencer remembers the last 64 confirmed Settle nullifiers to cover indexer lag. An indexer more than 64 Settles behind makes a new Settle fail with `internal` after three attempts. The SDK then retries with a new quote.
- A request queued behind other relayer work can answer `quote_expired` somewhat after its deadline. It never sends a transaction after that deadline.
- In a token pool the relayer's change holds its fee tokens, so it is never ADA-only. The relayer needs a separate ADA-only output of at least 5 ADA for collateral, and an ADA-only float of about 4 ADA per pending Settle. If the float runs low, the coin selection spends the collateral output and every Settle fails until the operator refills it (seen on Preprod, 2026-10-19). The deploy command funds the relayer with one output. Two later fixes: keep the chosen collateral out of the fee inputs in `complete`, or pay the relayer fee tokens into their own output so the change stays ADA-only. The solvency monitor (item 4 above) should watch both.
- The sequencer keeps its last 16 confirmed transactions in its view while the provider still lists an input they spent. If a rollback drops one of them for good, the view can show its outputs until 16 newer transactions replace it. Builds on them are refused and retried; no funds are at risk.
- A payout with a datum hash is refused by the Settle builder.
- A change note cannot be recovered from the seed alone. The SDK needs its store file. After a lost store the SDK goes on safely with new secrets, but the unspent change notes of the old store stay out of reach, and the one-time addresses start again at the first one, which links those payments on chain.
- The pool does not refuse a repeated precommitment on chain, as the Base implementation does. The SDK prevents it. A wallet without the SDK must do the same.
- The association service approves every absorbed deposit at once, unless a deny function refuses it. No screening data source is connected.
- The indexer treats confirmed data as final. It does not wait for a number of blocks.
- A deploy that stops midway has no resume command. Section 9 of the runbook says what to do.
- `npm audit` reports findings in packages that the Cardano libraries pull in. None was reviewed.
- The deployer writes the first pool datum, the first config and the first association datum. The token policy checks only the seed and the three names. The indexer checks the tree, the queue and the nullifier root of the first pool datum. It does not check the rest of the root history, the fee counter, or the bounds of the first config. A dishonest deployer could plant a second root, a fee balance or a negative fee rate, and take deposits later.
- The agent's chain provider sees the deposit wallet, every one-time address and every seller payment of that agent. The demo shares one provider project with the node. An agent that wants privacy from its provider needs its own node.
- A public exit of a change note reveals the payments of its deposit. The deposit minus the exit is the sum of the withdrawn amounts, and those are public.
- The privacy defaults of SPEC 13.2 are not built. There is no warning on matching amounts, no waiting rule, and no lower limit on the approved set.
- A stock x402 client that repeats a request after an unclear answer pays again. The SDK keeps no record of a payment per request.
- Funds that stay at a one-time address after a failed second leg are not tracked. `recoverOneTimeFunds` moves them, and it pays any address the caller names.
- The SDK keeps its notes in memory unless the caller passes a file store. A restart without a file store forgets unspent change notes.
- Ragequit needs the config output as a reference input, and the root history holds 16 roots. An admin who updates the config in every block, or a flood of Inserts, can delay an exit or a payment. Neither can take funds.

Your first day:

1. Do [SETUP.md](./SETUP.md) and confirm every version check.
2. Run `npm ci`, `npm run build:circuits`, `npm run setup:dev` and `npm test`.
3. Read `ops/test/rehearsal.test.ts`. It shows every part working together.
4. Follow [RUNBOOK.md](./RUNBOOK.md) once with your own pool.

### Decisions made during the build

The build made these choices where the plan was silent or wrong. Each one can be changed, at the cost given.

| Decision | Why | Cost of changing it |
|---|---|---|
| Aiken and circom come from npm packages, not from global installs | One `npm ci` gives every tool at a pinned version | Small changes to the scripts |
| Tests run on a local chain that evaluates the real validators with the pinned Aiken | No pool exists on a network before deploy, and CI must not need one | None. The provider adapter has its own tests |
| The local chain learns every ledger rule that failed on a live network | A local chain that skips a rule hides exactly the bugs that rule exists for | None |
| Script parameters are applied with the Evolution SDK, not with Mesh | Mesh 1.9.1 cuts byte strings over 64 bytes | None. A test compares all five scripts with the Aiken CLI |
| The circuits use their own small gadgets, never circomlib | circomlib gadgets assume another field | About 40 lines of circom to audit |
| The insert circuit takes its slots as one public array | Three arrays would give another order of public signals | A new key setup |
| The prover is its own package | The crank proves, the relayer verifies, and the fixtures prove too | None |
| The continuing pool output must carry no reference script (rule P3) | Otherwise anyone could park a large script on the pool output and raise the fee of the next spend | One equality check in the validator |
| The token names are fixed (`pool`, `config`, `asp`), so the genesis is checked off chain | The Spec says so. M0 uses the team's own funds | For M1, bind the names to the seed output. That means a new pool |
| The development verification keys are in git under `artifacts/dev` | The pool script takes the keys as parameters, and CI has no proving keys | None. A live pool never uses them |
| Each network gets its own key setup, with keys outside the development folder | A test key must never be mistaken for a live key | None |
| Tests that need a proving key skip without one | CI has no proving keys | A proving regression can reach main if nobody runs the tests locally |
| The SDK limits the total relayer fee to 2,000,000 pool asset base units by default, equal to 2 tUSDM or 2 ADA | The validator fixes only the protocol fee, and the proof fixes the withdrawn amount | A relayer that needs more is refused until the caller raises the limit |
| The SDK settles its own tentative marks by deadline | A deadline needs no extra chain reads and cannot give a false answer when the indexer lags | A dropped transaction is noticed up to 12 minutes late |
| The indexer reads a new block a second time only for two minutes after a change | A provider can serve old data right after a block, and a second read of every block would nearly double the requests of an idle node | Outside those two minutes, only the next block corrects a stale read |
| The SDK, not the chain, makes sure that no note secret is used twice | A rule on chain needs a second set in the pool datum, more script budget, and a new pool | A wallet that skips the SDK can lock its own deposit |
| The SDK reads the fee rate and the chain tip from its own provider before it proves | The indexer and the relayer belong to an operator, who gains from a higher fee or a longer deadline | Two provider calls more for each payment |
| Only a known refusal of the relayer releases a note, and the relayer answers `uncertain` once it has sent a transaction | A lost reply says nothing about the transaction, and a dropped record loses a change note | After an unclear answer the note stays reserved until the deadline of the quote plus two minutes |
| A deposit made through the SDK is followed by its exact output | Its precommitment and refund key are public, so a copy could take its place | None. A deposit that another wallet builds keeps the older rule |
| The network key setup never replaces a complete set of proving keys | The key script makes new keys when Node.js, circom, snarkjs or a circuit changes, and a deployed pool cannot work with other keys | To make new keys, someone must move the key folder away by hand |
| The first live run was on Preprod | The owner asked for it. All off-chain code takes a network setting | None. Mainnet uses the same code |

## 6. Hard rules

See [AGENTS.md](../AGENTS.md) for the full list of hard rules.

## 7. Decisions that need the owner

None blocks M0. PRD section 14 lists each question, its default, and when it must be decided.
The first ones to come due are the compliance data source and the operating entity. Both are needed before M1.

Ask the owner before you change any of these:

- A rule in SPEC sections 4 to 6.
- A cap, a fee bound, or an admin power.
- The x402 mode order.
- Anything that adds an operator who must be trusted.

## 8. Where things come from

| Thing | Location |
|---|---|
| the Base implementation, the source architecture | the Privacy Pools rail on Base, vendored 0xbow contracts |
| Privacy Pools reference contracts and circuits | `github.com/0xbow-io/privacy-pools-core` |
| The Poseidon255 circuits | `github.com/jmagan/poseidon-bls12381-circom` |
| The x402 scheme for Cardano | `github.com/x402-foundation/x402`, `specs/schemes/exact/scheme_exact_cardano.md` |
| A defensive Aiken Groth16 verifier to learn from | `github.com/ODATANO/DAYZERO` |
| A project that proves a Merkle append in-circuit on preprod | `github.com/TrustLevel/ZK-Defi-Protocol` |

## 9. Limits of this handoff

- The plan is a work breakdown. It fixes interfaces and tests, not line-by-line code.
- Estimates are marked as estimates. M0 replaces them with measurements.
- The design is new. An external audit is required before the caps are lifted.
- This repo uses the MIT license. the Base implementation uses Apache-2.0.
