import fs from 'node:fs/promises';
import path from 'node:path';
import { FidelityError, UsageError } from '../errors.js';
import { applyBlocks, joinContent, splitContent } from '../diff/parse.js';
import type { GitRepo } from '../git/repo.js';
import type { ApplyResult, ChangeBlock, FileChange, Plan } from '../model/types.js';

export interface ApplyOptions {
  branch: string;
  force: boolean;
  /** Compare the final tree against a tree built from the working tree. */
  verifyTree: boolean;
  onCommit?: (info: { index: number; sha: string; subject: string; files: string[] }) => void;
}

function finalTrailingNewline(file: FileChange): boolean {
  return file.status !== 'deleted' && file.newContent.endsWith('\n');
}

function modeFor(file: FileChange): string {
  if (file.baseMode === '120000') return '120000';
  return file.executable ? '100755' : '100644';
}

/** Reconstruct a file's final content from the flattened block list. */
export function reconstructFile(file: FileChange): string {
  const { lines } = splitContent(file.baseContent);
  return joinContent(applyBlocks(lines, file.blocks), finalTrailingNewline(file));
}

/**
 * Verify — before touching git at all — that replaying every change unit
 * reproduces the working tree byte-for-byte. Returns a list of mismatches.
 */
export function verifyReconstruction(plan: Plan): string[] {
  const mismatches: string[] = [];
  for (const file of plan.files) {
    if (file.binary) {
      if (file.status !== 'deleted' && file.rawBytes === undefined) {
        mismatches.push(`${file.path}: binary content was not captured`);
      }
      continue;
    }
    if (file.status === 'deleted') {
      if (reconstructFile(file) !== '') {
        mismatches.push(`${file.path}: expected deletion but reconstruction is non-empty`);
      }
      continue;
    }
    const reconstructed = reconstructFile(file);
    if (reconstructed !== file.newContent) {
      mismatches.push(`${file.path}: reconstructed content differs from the working tree`);
    }
  }
  return mismatches;
}

async function runCommits(
  repo: GitRepo,
  plan: Plan,
  options: ApplyOptions,
  env: Record<string, string>,
): Promise<{ commits: ApplyResult['commits']; head: string; tree: string }> {
  const byPath = new Map(plan.files.map((f) => [f.path, f]));
  const applied = new Map<string, ChangeBlock[]>();
  const commits: ApplyResult['commits'] = [];

  let parent = plan.base;
  let tree = '';

  await repo.readTree(plan.baseTree, env);

  for (const [offset, commit] of plan.commits.entries()) {
    const files = [...new Set(commit.cluster.units.map((u) => u.file))].sort();
    for (const file of files) {
      const change = byPath.get(file);
      if (!change) throw new UsageError(`internal error: unknown file in plan: ${file}`);
      const fileUnits = commit.cluster.units.filter((u) => u.file === file);

      if (fileUnits.some((u) => u.deletesFile)) {
        await repo.updateIndexRemove(file, env);
        continue;
      }

      if (change.binary) {
        const bytes = change.rawBytes ?? new Uint8Array();
        const sha = await repo.hashObjectWrite(Buffer.from(bytes), file);
        await repo.updateIndexCacheInfo(modeFor(change), sha, file, env);
        continue;
      }

      const blocks = applied.get(file) ?? [];
      blocks.push(...fileUnits.flatMap((u) => u.blocks));
      applied.set(file, blocks);

      const { lines } = splitContent(change.baseContent);
      const content = joinContent(applyBlocks(lines, blocks), finalTrailingNewline(change));
      const sha = await repo.hashObjectWrite(content, modeFor(change) === '120000' ? undefined : file);
      await repo.updateIndexCacheInfo(modeFor(change), sha, file, env);
    }

    tree = await repo.writeTree(env);
    const message = `${commit.message.subject}\n\n${commit.message.body}\n`;
    const sha = await repo.commitTree(tree, parent ? [parent] : [], message);
    commits.push({ sha, subject: commit.message.subject, files });
    options.onCommit?.({
      index: offset + 1,
      sha,
      subject: commit.message.subject,
      files,
    });
    parent = sha;
  }

  return { commits, head: parent, tree };
}

/**
 * Apply the plan onto a brand-new branch. Original refs are never modified:
 * the only ref write is `update-ref refs/heads/<branch>`.
 */
export async function applyPlan(
  repo: GitRepo,
  plan: Plan,
  options: ApplyOptions,
): Promise<ApplyResult> {
  if (plan.commits.length === 0) {
    throw new UsageError('Nothing to apply: the plan contains no commits.');
  }
  if (await repo.branchExists(options.branch)) {
    if (!options.force) {
      throw new UsageError(
        `Branch '${options.branch}' already exists. Pass --force to overwrite it (the old commits stay in the reflog).`,
      );
    }
  }

  const mismatches = verifyReconstruction(plan);
  if (mismatches.length > 0) throw new FidelityError(mismatches);

  const gitDir = await repo.gitDir();
  const stamp = `${process.pid}-${Date.now()}`;
  const indexPath = path.join(gitDir, `git-atomic-index-${stamp}`);
  const verifyPath = path.join(gitDir, `git-atomic-verify-${stamp}`);
  const env = { GIT_INDEX_FILE: indexPath };
  const verifyEnv = { GIT_INDEX_FILE: verifyPath };

  try {
    // Strong proof: the working tree's own tree hash. Computed first so we can
    // abort before writing the branch if anything is off.
    const workingTreeSha = options.verifyTree
      ? await repo.computeWorkingTreeSha(verifyEnv)
      : null;

    const { commits, head, tree } = await runCommits(repo, plan, options, env);

    if (workingTreeSha !== null && workingTreeSha !== tree) {
      throw new FidelityError([
        `final tree ${tree} does not match working tree ${workingTreeSha}`,
      ]);
    }

    await repo.setBranch(options.branch, head);

    const manifestPath = path.join(gitDir, 'git-atomic', 'last-run.json');
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          createdAt: new Date().toISOString(),
          base: plan.base,
          baseRef: plan.baseRef,
          branch: options.branch,
          baseTree: plan.baseTree,
          head,
          tree,
          commits,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    return {
      branch: options.branch,
      base: plan.base,
      head,
      commits,
      manifestPath,
    };
  } finally {
    await fs.rm(indexPath, { force: true }).catch(() => {});
    await fs.rm(verifyPath, { force: true }).catch(() => {});
  }
}
