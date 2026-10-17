import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { GitRepo } from '../git/repo.js';

/** Result of running one check command. */
export interface CommandOutcome {
  ok: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string;
  durationMs: number;
  timedOut: boolean;
  command: string;
}

const OUTPUT_LIMIT = 16_000;

/**
 * Run a shell command in `cwd`, capturing combined stdout/stderr. The command
 * is killed once `timeoutMs` elapses. Shells (and their children) are the
 * user's own build tooling; we never interpret the output.
 */
export function runCommand(
  cwd: string,
  command: string,
  timeoutMs: number,
): Promise<CommandOutcome> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let output = '';
    let timedOut = false;

    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      env: process.env,
    });

    const append = (chunk: Buffer): void => {
      if (output.length < OUTPUT_LIMIT) output += chunk.toString('utf8');
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut,
        code,
        signal,
        output: output.trim(),
        durationMs: Date.now() - startedAt,
        timedOut,
        command,
      });
    };

    child.on('error', (error) => {
      append(Buffer.from(String(error)));
      finish(null, null);
    });
    child.on('close', finish);
  });
}

export interface Workspace {
  /** Absolute path to the scratch checkout. */
  dir: string;
  /** Hard-reset the checkout to a commit-ish without touching any ref. */
  reset(sha: string): Promise<void>;
  dispose(): Promise<void>;
}

/** Where scratch worktrees live. Overridable for sandboxes/CI. */
function tempRoot(): string {
  return process.env.GIT_ATOMIC_TMP ?? path.join(os.tmpdir(), 'opencode');
}

/**
 * Create a throwaway worktree of the repo so checks can run against a
 * materialised tree. The repo's own working tree and refs are untouched.
 *
 * Ignored dependency directories (e.g. `node_modules`) are linked into the
 * scratch checkout so the project's tooling can actually run.
 */
export async function createWorkspace(
  repo: GitRepo,
  baseCommit: string,
  links: readonly string[],
): Promise<Workspace> {
  const root = tempRoot();
  await fs.mkdir(root, { recursive: true });
  const dir = path.join(
    root,
    `git-atomic-verify-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  await repo.runGitAt(repo.root, ['worktree', 'add', '--detach', '--force', dir, baseCommit]);
  for (const rel of links) await linkDependency(repo.root, dir, rel);

  return {
    dir,
    reset: async (sha) => {
      await repo.runGitAt(dir, ['reset', '--hard', '--quiet', sha]);
      // Drop any untracked, non-ignored files left behind by a previous check.
      await repo.runGitAt(dir, ['clean', '-fdq'], { allowNonZero: true });
    },
    dispose: async () => {
      await repo.runGitAt(repo.root, ['worktree', 'remove', '--force', dir], {
        allowNonZero: true,
      });
      await repo.runGitAt(repo.root, ['worktree', 'prune'], { allowNonZero: true });
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

async function linkDependency(repoRoot: string, dir: string, rel: string): Promise<void> {
  const src = path.resolve(repoRoot, rel);
  const dest = path.join(dir, rel);
  try {
    await fs.access(src);
  } catch {
    return;
  }
  try {
    await fs.access(dest);
    return;
  } catch {
    // Not present in the commit tree: link it in below.
  }
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.symlink(src, dest, process.platform === 'win32' ? 'junction' : 'dir');
}
