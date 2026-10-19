# Rules for coding agents and contributors

These rules apply to every person and every AI agent that changes this repo.
Read [docs/HANDOFF.md](docs/HANDOFF.md) first.

## Source of truth

- [docs/SPEC.md](docs/SPEC.md) is the design. Code must match it.
- If the Spec is wrong or unclear, change the Spec first, in the same pull request as the code.
- [docs/TEST-PLAN.md](docs/TEST-PLAN.md) names every test. Use its IDs in test names.
- [docs/TEST-VECTORS.md](docs/TEST-VECTORS.md) holds known answers. Never edit a vector to make a test pass.

## Hard rules

1. **Range-check every public input on-chain.** Each must satisfy `0 <= x < r`. Without this a note can be spent twice.
2. **The validator never computes Poseidon.** Tree updates are proven by the `insert` circuit.
3. **Use Poseidon255 from `poseidon-bls12381-circom` and `poseidon-bls12381` only.** Never use `circomlibjs`. It hashes over another field.
4. **No pool transaction mints, withdraws rewards, or carries a certificate.** Stock x402 facilitators reject those.
5. **Never trust a root from an operator.** A root changes only through Insert with a valid proof.
6. **Funds stay in the pool UTXO.** Never design a flow that spends a per-deposit UTXO at payment time.
7. **Note secrets never leave the agent's machine in default mode.** The relayer gets a proof and an intent, nothing else.
8. **Evaluate every transaction before you submit it on mainnet.** Never submit a transaction that fails evaluation.
9. **Never commit secrets.** No seed phrases, signing keys, `.env` files, proving keys, or powers of tau files.
10. **Scripts are immutable.** A change to a circuit or a validator after deploy means a new ceremony and a new pool.
11. **Keep curve points out of data structures in Aiken.** No `Option`, list, tuple, or record of points. Each wrap adds a hidden compress and uncompress.
12. **Never delete or remake `circuits/build/keys-<network>`.** It holds the proving keys of a deployed pool, and no setup can make them again. Without them the notes in that pool stay locked.

## How to work

- Write the failing test first. Watch it fail for the right reason. Then write the code.
- One negative test changes one thing from a passing case.
- Use real proofs as fixtures in validator tests. Do not mock the verifier.
- Keep changes small. Do not refactor code that your task does not touch.
- Record measured costs in [docs/measurements.md](docs/measurements.md).
- Before you say a task is done, run its tests and paste the result.

## Commands

| Task | Command | Where |
|---|---|---|
| Install every tool | `npm ci` | repo root |
| All JavaScript tests | `npm test` | repo root |
| Type check | `npm run typecheck` | repo root |
| Validator tests | `npm run check:contracts` | repo root |
| Validator tests and cost bounds | `npm run check:budgets` | repo root |
| Toolchain smoke test | `npm run test:smoke` | repo root |
| Compile circuits | `npm run build:circuits` | repo root |
| Development keys, about 30 minutes the first time | `npm run setup:dev` | repo root |
| Rebuild proof fixtures | `npm run fixtures` | repo root |
| Check that proof fixtures are current | `npm run check:fixtures` | repo root |
| Tests of one workspace | `npm test -w packages/txlib` | repo root |
| The whole product on the local chain | `npm test -w ops` | repo root |
| Network keys, about 4 minutes | `npm run ops:setup` | repo root |
| Deploy cost and role addresses, nothing is sent | `npm run ops:deploy -- --dry-run` | repo root |
| Deploy a pool | `npm run ops:deploy` | repo root |
| Run the node | `npm run node -w ops` | repo root |
| Play the user story against a running node and seller | `npm run demo -w ops` | repo root |
| Pool status, pause, fee collection, wind-down | `npm run admin -w ops -- status` | repo root |

The last six commands use a real network and read `.env`. [docs/RUNBOOK.md](docs/RUNBOOK.md) explains them.

New proofs need the development proving keys. The check needs none, because it reuses the cached proofs.

## Writing rules

- Short sentences. Plain words. Active voice.
- No em dashes in docs, comments, or commit messages.
- Give each thing one name. Use the names in the PRD glossary.
- Write `CAUTION:` before any step that cannot be undone or that risks funds.

## Cardano knowledge

Cardano tooling changes fast. Do not answer from memory.
Use the Cardano Dev Skills plugin described in [docs/SETUP.md](docs/SETUP.md), or read the official docs.

Four lessons from the live runs. The local test chain in `packages/txlib/src/testing/` enforces the first three, and the Blockfrost adapter tests (TX-16) enforce the fourth:

- Mesh 1.9.1 hashes script data with old built-in cost models. Always build through `newTxBuilder` in `packages/txlib/src/context.ts`, which sets the live cost models.
- The live evaluator refuses a confirmed output that is sent as an extra input. `complete` sends only outputs that are not on chain yet.
- Reads return confirmed data only. After a submit, wait for the confirmation before you build on its outputs, or build through the sequencer (`packages/txlib/src/sequencer.ts`), which tracks pending outputs.
- Mesh 1.9.1 `evaluateTx` drops the datum of every additional UTXO and nests its tokens in the wrong shape. Evaluation with additional UTXOs goes through `ogmiosAdditionalUtxo` in `packages/txlib/src/providers/blockfrost.ts`, which posts the Ogmios v5 body itself. The FakeChain cannot catch this, because it evaluates full UTXOs.

Never call Mesh `applyParamsToScript`. Mesh 1.9.1 cuts every byte string over 64 bytes down to 64 bytes and reports no error.
That corrupts the 96-byte points of a verification key. Use `buildScripts` in `packages/txlib/src/scripts.ts`, which matches `aiken blueprint apply` byte for byte.
