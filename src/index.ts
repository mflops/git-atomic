export { buildCommitSteps, applyPlan, verifyReconstruction, reconstructFile } from './apply/apply.js';
export type { ApplyOptions, CommitStep } from './apply/apply.js';
export { loadConfig } from './config.js';
export type { Config } from './config.js';
export { GitAtomicError, UsageError, FidelityError, GitError } from './errors.js';
export { GitRepo } from './git/repo.js';
export type { NameStatusEntry } from './git/repo.js';
export { buildPlan, runPipeline, repoName } from './pipeline.js';
export type { PipelineOptions, RunOptions, RunResult } from './pipeline.js';
export { renderPlan, renderApplied } from './report.js';
export type { RenderOptions } from './report.js';
export type {
  ChangeStatus,
  UnitKind,
  SymbolKind,
  DefinitionSymbol,
  ChangeBlock,
  FileChange,
  ChangeUnit,
  DependencyEdge,
  DependencyGraph,
  CommitCluster,
  PlannedCommit,
  PlanStats,
  CheckReport,
  FoldReport,
  BuildabilityReport,
  Plan,
  ApplyResult,
} from './model/types.js';
export { verifyBuildability } from './verify/buildability.js';
export type { VerifiedPlan, VerifyOptions } from './verify/buildability.js';
export { runCommand } from './verify/workspace.js';
export type { CommandOutcome } from './verify/workspace.js';
