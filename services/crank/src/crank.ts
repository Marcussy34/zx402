import type { IndexerApi } from '@zx402/api';
import { MerkleTree, insertWitness } from '@zx402/crypto';
import { prove, type CircuitArtifacts } from '@zx402/prover';
import {
  buildInsert, enterpriseAddress, planInsert, readConfig, readDeposits, readPool, signTx,
  type ChainContext, type Sequencer,
} from '@zx402/txlib';

export class Crank {
  private readonly indexer: IndexerApi;
  private readonly seed: Uint8Array;
  private readonly artifacts: CircuitArtifacts;
  private readonly sequencer: Sequencer;

  constructor(a: {
    // ctx stays for callers. Every read goes through the sequencer overlay.
    ctx: ChainContext; indexer: IndexerApi; seed: Uint8Array; artifacts: CircuitArtifacts;
    sequencer: Sequencer;
  }) {
    this.indexer = a.indexer;
    this.seed = a.seed.slice();
    this.artifacts = a.artifacts;
    this.sequencer = a.sequencer;
  }

  /** One round. Builds on the sequencer head, so an Insert can follow a pending Settle. */
  async tick(): Promise<{ txId: string; notes: number; deposits: number } | null> {
    // One Insert at a time. A pending Settle does not block an Insert.
    if (!this.sequencer.canSubmit('insert')) return null;
    return this.sequencer.run(async () => {
      // A run queued ahead of this one may have submitted an Insert.
      if (!this.sequencer.canSubmit('insert')) return null;
      // The overlay shows pending outputs and hides pending spends.
      const ctx = this.sequencer.ctx;
      const pool = await readPool(ctx);
      const [config, deposits] = await Promise.all([readConfig(ctx), readDeposits(ctx)]);
      const leaves: bigint[] = [];
      do {
        const page = await this.indexer.getLeaves(leaves.length, 1000);
        if (page.from !== leaves.length || page.size !== pool.datum.size || page.root !== pool.datum.roots[0]
          || page.leaves.length > page.size - leaves.length) return null;
        if (page.leaves.length === 0 && leaves.length < page.size) return null;
        leaves.push(...page.leaves);
      } while (leaves.length < pool.datum.size);
      const tree = MerkleTree.fromLeaves(leaves);
      if (tree.size !== pool.datum.size || tree.root !== pool.datum.roots[0]) return null;
      // The plan must count the same asset as the pool, or the proof's slot values never match the chain.
      const plan = planInsert({ poolId: ctx.deployment.poolId, pool, config: config.datum, deposits, asset: ctx.deployment.asset });
      if (plan === null) return null;
      const witness = insertWitness({ tree, slots: plan.slots });
      const proof = await prove(this.artifacts, witness.input);
      const tx = await buildInsert(ctx, {
        payer: { address: enterpriseAddress(this.seed, ctx.deployment.network) },
        pool, plan, proof: proof.cardano, newRoot: witness.newRoot,
      });
      const result = await this.sequencer.submit(signTx(tx.cbor, [this.seed]), { kind: 'insert' });
      if (result.status === 'rejected') return null;
      return { txId: result.txId, notes: plan.flush, deposits: plan.deposits.length };
    });
  }
}
