/**
 * The shared data model for the whole pipeline.
 *
 * Flow: unified diff -> {@link ChangeBlock} -> {@link ChangeUnit} -> dependency
 * graph -> {@link CommitCluster} -> ordered {@link PlannedCommit}.
 *
 * Everything is anchored to the *base* revision. A unit never stores absolute
 * file content, only line-range edits against the base file. That is what makes
 * it possible to materialise any subset of units as a valid tree.
 */

/** Coarse category used for ordering and message generation. */
export type UnitKind =
  | 'config'
  | 'types'
  | 'manifest'
  | 'implementation'
  | 'other'
  | 'test'
  | 'docs'
  | 'lockfile';

export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'typechange';

export type SymbolKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'method'
  | 'variable'
  | 'import'
  | 'namespace';

/** A declaration discovered by the symbol mapper. Lines are 1-based inclusive. */
export interface DefinitionSymbol {
  name: string;
  kind: SymbolKind;
  startLine: number;
  endLine: number;
  /** Stable identity: `<relative file>#<name>#<startLine>`. */
  key: string;
}

/**
 * A single contiguous run of added/removed lines inside one file, expressed as
 * a replacement of base lines `[startOld..endOld]` by `newLines`.
 *
 * - pure insertion at the top: `startOld = 1`, `endOld = 0`
 * - pure append at EOF: `startOld = lineCount + 1`, `endOld = lineCount`
 */
export interface ChangeBlock {
  file: string;
  /** First base line number that is replaced (1-based). */
  startOld: number;
  /** Last base line number that is replaced (1-based, inclusive). */
  endOld: number;
  /** First line number in the *new* file touched by this block. */
  startNew: number;
  /** Replacement content (context lines excluded). */
  newLines: string[];
}

/**
 * The smallest coherent edit: one symbol's worth of change inside one file.
 * Multiple {@link ChangeBlock}s are grouped here when they touch the same symbol.
 */
export interface ChangeUnit {
  id: string;
  file: string;
  kind: UnitKind;
  /** Symbol this unit belongs to, or null for top-level / unmapped changes. */
  symbol: DefinitionSymbol | null;
  /** Stable grouping key (`symbol.key` or a synthetic file/line key). */
  symbolKey: string;
  /** Human-readable label for reports. */
  label: string;
  blocks: ChangeBlock[];
  /** True when the whole file is removed by this unit. */
  deletesFile: boolean;
  addedLines: string[];
  removedLines: string[];
  /** Symbol names introduced by this unit. */
  defines: string[];
  /** Identifiers referenced by this unit's added lines. */
  references: string[];
  /** Relative module specifiers imported by this unit's added lines. */
  imports: string[];
  /** Repo-relative paths this unit's imports resolve to (best effort). */
  resolvedImports: string[];
}

export type EdgeKind =
  | 'defines-before-use'
  | 'imports'
  | 'source-before-test'
  | 'manifest-before-lockfile'
  | 'same-file';

export interface DependencyEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  detail?: string;
}

export interface DependencyGraph {
  units: ChangeUnit[];
  edges: DependencyEdge[];
}

/** One connected/cohesive group of units that will become a single commit. */
export interface CommitCluster {
  id: string;
  units: ChangeUnit[];
  /** Topological rank used to break ordering ties. */
  rank: number;
  /** True when this cluster exists because of a dependency cycle. */
  fromCycle: boolean;
  reason: string;
}

export interface PlannedCommit {
  /** 1-based position in the new history. */
  index: number;
  cluster: CommitCluster;
  message: CommitMessage;
  /** Files whose content differs from the previous commit. */
  files: string[];
}

export interface CommitMessage {
  subject: string;
  body: string;
  type: string;
  scope: string | null;
}

export interface FileChange {
  path: string;
  status: ChangeStatus;
  kind: UnitKind;
  language: string;
  binary: boolean;
  /** Base blob content (empty string when the file is new). */
  baseContent: string;
  /** Working-tree content (empty string when the file is deleted or binary). */
  newContent: string;
  /** Raw working-tree bytes, captured for binary files (fidelity checks + apply). */
  rawBytes?: Uint8Array;
  /** Executable bit for the final state. */
  executable: boolean;
  /** Mode recorded in the base tree (e.g. '100755', '120000'), or null if new. */
  baseMode: string | null;
  blocks: ChangeBlock[];
}

export interface PlanStats {
  files: number;
  units: number;
  clusters: number;
  edges: number;
  addedLines: number;
  removedLines: number;
}

export interface Plan {
  repo: string;
  /** Resolved commit hash of the base revision. */
  base: string;
  /** The ref/sha the user asked for (for reporting). */
  baseRef: string;
  baseTree: string;
  branch: string;
  files: FileChange[];
  graph: DependencyGraph;
  clustered: CommitCluster[];
  commits: PlannedCommit[];
  stats: PlanStats;
  /** Non-fatal notes surfaced to the user (fallbacks, merges, ...). */
  notes: string[];
}

export interface ApplyResult {
  branch: string;
  base: string;
  head: string;
  commits: Array<{ sha: string; subject: string; files: string[] }>;
  manifestPath: string;
}
