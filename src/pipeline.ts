import { UsageError } from './errors.js';
import { applyPlan } from './apply/apply.js';
import { clusterUnits } from './cluster/cluster.js';
import { GitRepo } from './git/repo.js';
import { buildDependencyGraph } from './graph/build.js';
import { defaultMessageGenerator, type MessageGenerator } from './messages/generator.js';
import { orderClusters } from './order/order.js';
import { HeuristicSymbolMapper } from './parse/heuristic.js';
import type { SymbolMapper } from './parse/symbols.js';
import { resolveTreeSitterMapper } from './parse/treesitter.js';
import { buildUnits, collectFileChanges } from './units/extract.js';
import { basename } from './util/paths.js';
import type {
  ApplyResult,
  CommitCluster,
  Plan,
  PlannedCommit,
} from './model/types.js';

export interface PipelineOptions {
  cwd: string;
  base?: string;
  branch?: string;
  ignore?: string[];
  maxCommits?: number;
  /**
   * Symbol mapper override: `undefined` = auto (tree-sitter, heuristic
   * fallback), `null` = disable symbol mapping (proximity only).
   */
  mapper?: SymbolMapper | null;
  /** Commit-message source. Defaults to the deterministic offline generator. */
  messageGenerator?: MessageGenerator;
}

const DEFAULT_BRANCH = 'git-atomic/split';

/** Resolve the base ref the user means when they don't specify one. */
async function resolveBaseRef(repo: GitRepo, wanted?: string): Promise<string> {
  if (wanted) return wanted;
  const defaultBranch = await repo.defaultBranch();
  if (defaultBranch) {
    const mergeBase = await repo.mergeBase('HEAD', defaultBranch);
    if (mergeBase) return mergeBase;
  }
  return 'HEAD';
}

async function resolveMapper(
  preference: SymbolMapper | null | undefined,
  notes: string[],
): Promise<SymbolMapper | null> {
  if (preference === null) return null;
  if (preference !== undefined) return preference;
  const resolution = await resolveTreeSitterMapper();
  if (resolution.note) notes.push(resolution.note);
  return resolution.mapper ?? new HeuristicSymbolMapper();
}

function capCommits(clusters: CommitCluster[], max: number | undefined): CommitCluster[] {
  if (!max || clusters.length <= max) return clusters;
  const total = clusters.length;
  const merged: CommitCluster[] = [];
  for (let i = 0; i < max; i += 1) {
    const start = Math.floor((i * total) / max);
    const end = Math.floor(((i + 1) * total) / max);
    const slice = clusters.slice(start, end);
    if (slice.length === 0) continue;
    merged.push({
      id: `c${merged.length + 1}`,
      units: slice.flatMap((c) => c.units),
      rank: Math.min(...slice.map((c) => c.rank)),
      fromCycle: slice.some((c) => c.fromCycle),
      reason: 'merged to satisfy --max-commits',
    });
  }
  return merged;
}

/**
 * Build (but never write) the commit plan for a repository.
 *
 * This is the dry-run path and the M0 deliverable: it prints a plan without
 * touching any ref. {@link applyPlan} consumes the returned plan.
 */
export async function buildPlan(options: PipelineOptions): Promise<Plan> {
  const notes: string[] = [];
  const repo = await GitRepo.open(options.cwd);

  const baseRef = await resolveBaseRef(repo, options.base);
  const base = await repo.revParse(baseRef);
  if (!base) throw new UsageError(`Base ref not found: ${baseRef}`);
  const baseTree = await repo.revParseTree(base);
  if (!baseTree) throw new UsageError(`Could not resolve base tree for ${baseRef}`);

  const collected = await collectFileChanges(repo, base, { ignore: options.ignore ?? [] });
  notes.push(...collected.notes);

  const mapper = await resolveMapper(options.mapper, notes);
  const units = buildUnits(collected.files, mapper);
  const graph = buildDependencyGraph(units);
  // Order first, then cap: capping merges *adjacent* commits so the result
  // stays logically ordered.
  const ordered = capCommits(orderClusters(clusterUnits(graph), graph), options.maxCommits);

  const generator = options.messageGenerator ?? defaultMessageGenerator;
  const generated = await Promise.all(ordered.map((cluster) => generator.generate(cluster)));

  const commits: PlannedCommit[] = ordered.map((cluster, index) => ({
    index: index + 1,
    cluster,
    message: generated[index]!,
    files: [...new Set(cluster.units.map((u) => u.file))].sort(),
  }));

  return {
    repo: repo.root,
    base,
    baseRef,
    baseTree,
    branch: options.branch ?? DEFAULT_BRANCH,
    files: collected.files,
    graph,
    clustered: ordered,
    commits,
    stats: {
      files: collected.files.length,
      units: units.length,
      clusters: ordered.length,
      edges: graph.edges.length,
      addedLines: units.reduce((n, u) => n + u.addedLines.length, 0),
      removedLines: units.reduce((n, u) => n + u.removedLines.length, 0),
    },
    notes,
  };
}

export interface RunOptions extends PipelineOptions {
  apply?: boolean;
  force?: boolean;
  onCommit?: (info: { index: number; sha: string; subject: string; files: string[] }) => void;
}

export interface RunResult {
  plan: Plan;
  applied: ApplyResult | null;
}

/** Build the plan, and optionally apply it to a brand-new branch. */
export async function runPipeline(options: RunOptions): Promise<RunResult> {
  const plan = await buildPlan(options);
  if (!options.apply || plan.commits.length === 0) return { plan, applied: null };

  const applied = await applyPlan(await GitRepo.open(options.cwd), plan, {
    branch: plan.branch,
    force: options.force ?? false,
    // Ignore patterns make the working-tree tree comparison meaningless.
    verifyTree: (options.ignore ?? []).length === 0,
    ...(options.onCommit ? { onCommit: options.onCommit } : {}),
  });
  return { plan, applied };
}

export function repoName(plan: Plan): string {
  return basename(plan.repo);
}
