export type {
  ApplyResult,
  ChangeBlock,
  ChangeStatus,
  ChangeUnit,
  CommitCluster,
  CommitMessage,
  DefinitionSymbol,
  DependencyEdge,
  DependencyGraph,
  FileChange,
  Plan,
  PlanStats,
  PlannedCommit,
  SymbolKind,
  UnitKind,
} from './model/types.js';

export { GitAtomicError, FidelityError, GitError, UsageError } from './errors.js';

export { GitRepo } from './git/repo.js';
export { collectFileChanges, buildUnits } from './units/extract.js';
export { buildDependencyGraph } from './graph/build.js';
export { stronglyConnectedComponents } from './graph/scc.js';
export { clusterUnits } from './cluster/cluster.js';
export { orderClusters } from './order/order.js';
export { generateMessage } from './messages/generate.js';
export { DeterministicMessageGenerator, defaultMessageGenerator } from './messages/generator.js';
export type { MessageGenerator } from './messages/generator.js';
export { applyPlan, verifyReconstruction, reconstructFile } from './apply/apply.js';
export { buildPlan, runPipeline, repoName } from './pipeline.js';
export type { PipelineOptions, RunOptions, RunResult } from './pipeline.js';

export { parseUnifiedDiff, extractBlocks, applyBlocks, splitContent, joinContent } from './diff/parse.js';
export { HeuristicSymbolMapper } from './parse/heuristic.js';
export { TreeSitterSymbolMapper, resolveTreeSitterMapper } from './parse/treesitter.js';
export type { SymbolMapper } from './parse/symbols.js';

export { loadConfig, ConfigSchema, CONFIG_FILENAME } from './config.js';
export type { Config } from './config.js';

export { renderPlan, renderApplied } from './report.js';
