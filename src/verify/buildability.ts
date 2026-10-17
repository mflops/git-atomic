import fs from 'node:fs/promises';
import path from 'node:path';
import { buildCommitSteps, type CommitStep } from '../apply/apply.js';
import type { GitRepo } from '../git/repo.js';
import type { MessageGenerator } from '../messages/generator.js';
import type {
  BuildabilityReport,
  CheckReport,
  CommitCluster,
  FoldReport,
  Plan,
  PlannedCommit,
} from '../model/types.js';
import { createWorkspace, runCommand } from './workspace.js';

export interface VerifyOptions {
  /** Build/test commands to run after each commit. All must pass. */
  commands: readonly string[];
  /** Per-command timeout in milliseconds (default 5 minutes). */
  timeoutMs?: number;
  /** Ignored directories to link into the scratch checkout. */
  links?: readonly string[];
  onCheck?: (report: CheckReport) => void;
}

export interface VerifiedPlan {
  /** The plan with any fold-back repairs applied. */
  plan: Plan;
  /** Pre-built commit steps, ready to hand to `applyPlan`. */
  steps: CommitStep[];
  report: BuildabilityReport;
}

const DEFAULT_TIMEOUT_MS = 300_000;

/**
 * Merge two adjacent clusters into one. Trees are cumulative, so a commit only
 * builds once its prerequisite changes are present; merging a failing commit
 * with the next one lets those changes land together.
 */
function mergeClusters(a: CommitCluster, b: CommitCluster): CommitCluster {
  return {
    id: a.id,
    units: [...a.units, ...b.units],
    rank: Math.min(a.rank, b.rank),
    fromCycle: a.fromCycle || b.fromCycle,
    reason: 'merged to make the commit buildable',
  };
}

async function regenerateCommits(
  clusters: readonly CommitCluster[],
  generator: MessageGenerator,
): Promise<PlannedCommit[]> {
  return Promise.all(
    clusters.map(async (cluster, index) => ({
      index: index + 1,
      cluster,
      message: await generator.generate(cluster),
      files: [...new Set(cluster.units.map((u) => u.file))].sort(),
    })),
  );
}

interface CommandsOutcome {
  ok: boolean;
  output: string;
  command: string;
  durationMs: number;
}

async function runCommands(
  dir: string,
  commands: readonly string[],
  timeoutMs: number,
): Promise<CommandsOutcome> {
  const startedAt = Date.now();
  let output = '';
  let command = commands[commands.length - 1] ?? '';

  for (const cmd of commands) {
    command = cmd;
    const outcome = await runCommand(dir, cmd, timeoutMs);
    if (outcome.output) output += `${outcome.output}\n`;
    if (!outcome.ok) {
      return { ok: false, output: output.trim(), command, durationMs: Date.now() - startedAt };
    }
  }
  return { ok: true, output: '', command, durationMs: Date.now() - startedAt };
}

/**
 * Build the commits, run the configured check after each one, and repair any
 * commit that fails by folding it into the next commit until the history is
 * buildable. The union of units is never changed, so the final tree still
 * reproduces the working tree exactly.
 */
export async function verifyBuildability(
  repo: GitRepo,
  inputPlan: Plan,
  generator: MessageGenerator,
  options: VerifyOptions,
): Promise<VerifiedPlan> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const links = options.links ?? ['node_modules'];
  const checks: CheckReport[] = [];
  const folds: FoldReport[] = [];
  const initialTotal = inputPlan.commits.length;

  const gitDir = await repo.gitDir();
  const stamp = `${process.pid}-${Date.now()}`;
  const env = { GIT_INDEX_FILE: path.join(gitDir, `git-atomic-verify-index-${stamp}`) };

  let clusters = inputPlan.commits.map((commit) => commit.cluster);
  let commits = inputPlan.commits;

  const workspace = await createWorkspace(repo, inputPlan.base, links);
  try {
    let steps = await buildCommitSteps(repo, inputPlan, env, commits);
    // `verified[i]` mirrors `steps[i]`; entries survive folds at other indices.
    let verified: Array<CheckReport | undefined> = steps.map(() => undefined);
    let i = 0;

    while (i < steps.length) {
      const step = steps[i]!;
      await workspace.reset(step.sha);
      const outcome = await runCommands(workspace.dir, options.commands, timeoutMs);

      const report: CheckReport = {
        index: i + 1,
        subject: step.subject,
        ok: outcome.ok,
        durationMs: outcome.durationMs,
        ...(outcome.ok ? {} : { command: outcome.command, output: outcome.output }),
      };
      verified[i] = report;
      checks.push(report);
      options.onCheck?.(report);

      if (outcome.ok || i + 1 >= steps.length) {
        i += 1;
        continue;
      }

      // Fold this failing commit forward into the next one and retry.
      const merged = mergeClusters(clusters[i]!, clusters[i + 1]!);
      clusters = [...clusters.slice(0, i), merged, ...clusters.slice(i + 2)];
      commits = await regenerateCommits(clusters, generator);
      folds.push({
        fromIndex: i + 1,
        intoIndex: i + 2,
        reason: `"${step.subject}" failed the check; merged with the next commit`,
      });

      steps = await buildCommitSteps(repo, inputPlan, env, commits);
      verified = [...verified.slice(0, i), undefined, ...verified.slice(i + 2)];
      // Do not advance: the merged commit sits at index `i` and must be re-checked.
    }

    const finalPlan: Plan = {
      ...inputPlan,
      clustered: clusters,
      commits,
      stats: { ...inputPlan.stats, clusters: clusters.length },
    };

    const total = steps.length;
    const passed = verified.filter((report) => report?.ok).length;
    const unbuildable = verified
      .map((report, index) => (report && !report.ok ? index + 1 : null))
      .filter((value): value is number => value !== null);

    return {
      plan: finalPlan,
      steps,
      report: {
        ran: true,
        commands: [...options.commands],
        passed,
        total,
        initialTotal,
        folds,
        checks,
        unbuildable,
      },
    };
  } finally {
    await workspace.dispose();
    await fs.rm(env.GIT_INDEX_FILE, { force: true }).catch(() => {});
  }
}
