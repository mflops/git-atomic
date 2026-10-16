import { createColors } from 'picocolors';
import type { Plan, PlannedCommit } from './model/types.js';
import { basename } from './util/paths.js';

export interface RenderOptions {
  color?: boolean;
}

function shortSha(sha: string): string {
  return sha.slice(0, 8);
}

function unitSummary(commit: PlannedCommit): string {
  const symbols = [
    ...new Set(commit.cluster.units.filter((u) => u.symbol).map((u) => u.label)),
  ];
  if (symbols.length > 0) return symbols.join(', ');
  return commit.files.join(', ');
}

/** Render the plan for humans (the default, colourful dry-run output). */
export function renderPlan(plan: Plan, options: RenderOptions = {}): string {
  const c = createColors(options.color ?? false);
  const lines: string[] = [];

  lines.push(
    `${c.bold('git-atomic')} ${c.dim('·')} ${c.cyan(basename(plan.repo))}`,
  );
  lines.push(
    `${c.dim('base')}   ${plan.baseRef} ${c.dim(`(${shortSha(plan.base)})`)}`,
  );
  lines.push(`${c.dim('branch')} ${c.green(plan.branch)} ${c.dim('(new branch, dry-run)')}`);
  lines.push(
    `${c.dim('stats')}  ${plan.stats.files} file(s), ${plan.stats.units} unit(s), ` +
      `${c.bold(String(plan.stats.clusters))} commit(s), ${plan.stats.edges} edge(s), ` +
      `+${plan.stats.addedLines}/-${plan.stats.removedLines}`,
  );
  lines.push('');

  if (plan.commits.length === 0) {
    lines.push(c.yellow('No changes to split.'));
    return lines.join('\n');
  }

  const width = String(plan.commits.length).length;
  for (const commit of plan.commits) {
    const index = `${String(commit.index).padStart(width)}.`;
    lines.push(`${c.dim(index)} ${c.bold(commit.message.subject)}`);
    const detail = unitSummary(commit);
    lines.push(
      `   ${c.dim(`${commit.files.length} file(s):`)} ${detail}`,
    );
    if (commit.cluster.fromCycle) {
      lines.push(`   ${c.yellow('! cycle: merged to stay buildable')}`);
    }
  }

  if (plan.notes.length > 0) {
    lines.push('');
    for (const note of plan.notes) lines.push(c.dim(`note: ${note}`));
  }

  return lines.join('\n');
}

export function renderApplied(
  plan: Plan,
  applied: { head: string; commits: Array<{ sha: string; subject: string }> },
  options: RenderOptions = {},
): string {
  const c = createColors(options.color ?? false);
  const lines: string[] = [];
  lines.push(
    `${c.green('created')} branch ${c.bold(plan.branch)} ` +
      `${c.dim(`(${shortSha(applied.head)})`)} from ${plan.baseRef}`,
  );
  for (const commit of applied.commits) {
    lines.push(`  ${c.dim(shortSha(commit.sha))} ${commit.subject}`);
  }
  lines.push(`${c.dim('original branch left untouched')}`);
  return lines.join('\n');
}
