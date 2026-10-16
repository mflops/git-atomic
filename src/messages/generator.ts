import type { CommitCluster, CommitMessage } from '../model/types.js';
import { generateMessage } from './generate.js';

/**
 * Pluggable commit-message source.
 *
 * The default is fully deterministic and offline. An LLM-backed implementation
 * can be dropped in later (it may be async) without changing the pipeline;
 * it only ever *names* clusters, never changes what is committed.
 */
export interface MessageGenerator {
  readonly name: string;
  generate(cluster: CommitCluster): CommitMessage | Promise<CommitMessage>;
}

export class DeterministicMessageGenerator implements MessageGenerator {
  readonly name = 'deterministic';

  generate(cluster: CommitCluster): CommitMessage {
    return generateMessage(cluster);
  }
}

export const defaultMessageGenerator = new DeterministicMessageGenerator();
