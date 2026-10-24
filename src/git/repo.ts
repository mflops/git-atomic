import fs from 'node:fs/promises';
import path from 'node:path';
import { UsageError } from '../errors.js';
import { toPosix } from '../util/paths.js';
import { gitText, runGit, type GitRunResult } from './exec.js';

export interface NameStatusEntry {
  status: string;
  path: string;
}

export interface GitRunOpts {
  env?: Record<string, string | undefined>;
  input?: string | Uint8Array;
  allowNonZero?: boolean;
}

/**
 * Thin, typed wrapper over git *plumbing*. Deliberately uses no high-level
 * library so we can guarantee we never touch existing refs, and so that
 * intermediate trees are built from a private index file (GIT_INDEX_FILE).
 */
export class GitRepo {
  private identityEnv: Record<string, string> | null = null;

  private constructor(readonly root: string) {}

  static async open(cwd: string): Promise<GitRepo> {
    let inside: Awaited<ReturnType<typeof runGit>>;
    try {
      inside = await runGit(['rev-parse', '--is-inside-work-tree'], {
        cwd,
        allowNonZero: true,
      });
    } catch {
      throw new UsageError(`Not a git working tree: ${cwd}`);
    }
    if (inside.code !== 0 || inside.stdout.toString('utf8').trim() !== 'true') {
      throw new UsageError(`Not a git working tree: ${cwd}`);
    }
    const top = await gitText(['rev-parse', '--show-toplevel'], { cwd });
    return new GitRepo(toPosix(top.trim()));
  }

  private run(args: readonly string[], opts: GitRunOpts = {}): Promise<GitRunResult> {
    return runGit(args, { cwd: this.root, ...opts });
  }

  private text(args: readonly string[], opts: GitRunOpts = {}): Promise<string> {
    return gitText(args, { cwd: this.root, ...opts });
  }

  async gitDir(): Promise<string> {
    return toPosix((await this.text(['rev-parse', '--absolute-git-dir'])).trim());
  }

  async currentBranch(): Promise<string | null> {
    const result = await this.run(['symbolic-ref', '--quiet', '--short', 'HEAD'], {
      allowNonZero: true,
    });
    if (result.code !== 0) return null;
    return result.stdout.toString('utf8').trim() || null;
  }

  /** Best-effort default branch: origin/HEAD, then main, then master. */
  async defaultBranch(): Promise<string | null> {
    const remoteHead = await this.run(
      ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
      { allowNonZero: true },
    );
    if (remoteHead.code === 0) {
      const name = remoteHead.stdout.toString('utf8').trim().replace(/^origin\//, '');
      if (name) return name;
    }
    for (const candidate of ['main', 'master']) {
      if (await this.revParse(candidate)) return candidate;
    }
    return null;
  }

  async revParse(ref: string): Promise<string | null> {
    const result = await this.run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      allowNonZero: true,
    });
    if (result.code !== 0) return null;
    return result.stdout.toString('utf8').trim() || null;
  }

  async revParseTree(ref: string): Promise<string | null> {
    const result = await this.run(['rev-parse', '--verify', '--quiet', `${ref}^{tree}`], {
      allowNonZero: true,
    });
    if (result.code !== 0) return null;
    return result.stdout.toString('utf8').trim() || null;
  }

  async branchExists(branch: string): Promise<boolean> {
    return (await this.revParse(`refs/heads/${branch}`)) !== null;
  }

  async mergeBase(a: string, b: string): Promise<string | null> {
    const result = await this.run(['merge-base', a, b], { allowNonZero: true });
    if (result.code !== 0) return null;
    return result.stdout.toString('utf8').trim() || null;
  }

  /** Tracked changes between `base` and the working tree (untracked excluded). */
  async listNameStatus(base: string): Promise<NameStatusEntry[]> {
    const result = await this.run([
      '-c',
      'core.quotepath=false',
      'diff',
      '--name-status',
      '--no-renames',
      '-z',
      base,
      '--',
    ]);
    return parseNameStatus(result.stdout.toString('utf8'));
  }

  async listUntracked(): Promise<string[]> {
    const result = await this.run([
      '-c',
      'core.quotepath=false',
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
    ]);
    return result.stdout.toString('utf8').split('\0').filter(Boolean).map(toPosix);
  }

  async filePatch(base: string, file: string): Promise<string> {
    const result = await this.run([
      '-c',
      'core.quotepath=false',
      'diff',
      '--no-color',
      '--no-ext-diff',
      '--no-renames',
      '--unified=0',
      base,
      '--',
      file,
    ]);
    return result.stdout.toString('utf8');
  }

  async fileContentAt(ref: string, file: string): Promise<string | null> {
    const result = await this.run(['cat-file', 'blob', `${ref}:${file}`], { allowNonZero: true });
    if (result.code !== 0) return null;
    return result.stdout.toString('utf8');
  }

  async baseMode(ref: string, file: string): Promise<string | null> {
    const result = await this.run(['ls-tree', ref, '--', file], { allowNonZero: true });
    if (result.code !== 0) return null;
    const line = result.stdout.toString('utf8').split('\n')[0];
    if (!line) return null;
    const mode = line.split(/\s+/)[0];
    return mode ?? null;
  }

  async readWorkingFile(file: string): Promise<Buffer> {
    const abs = path.join(this.root, file);
    const stat = await fs.lstat(abs);
    if (stat.isSymbolicLink()) return Buffer.from(await fs.readlink(abs), 'utf8');
    return fs.readFile(abs);
  }

  async workingFileExists(file: string): Promise<boolean> {
    try {
      await fs.lstat(path.join(this.root, file));
      return true;
    } catch {
      return false;
    }
  }

  async workingFileMode(file: string): Promise<string> {
    const stat = await fs.lstat(path.join(this.root, file));
    if (stat.isSymbolicLink()) return '120000';
    return stat.mode & 0o111 ? '100755' : '100644';
  }

  /**
   * Hash and store a blob. Passing `path` makes git apply the repo's
   * attributes (e.g. line-ending normalisation) exactly as `git add` would.
   */
  async hashObjectWrite(content: Buffer | string, file?: string): Promise<string> {
    const args = ['hash-object', '-w', '--stdin'];
    if (file) args.push('--path', file);
    const result = await this.run(args, { input: content });
    return result.stdout.toString('utf8').trim();
  }

  /**
   * Hash without storing. Passing `path` applies the repo's attributes so the
   * result matches `git add`; without it the raw bytes are hashed.
   */
  async hashObject(content: Buffer | string, file?: string): Promise<string> {
    const args = ['hash-object', '--stdin'];
    if (file) args.push('--path', file);
    const result = await this.run(args, { input: content });
    return result.stdout.toString('utf8').trim();
  }

  async catFileText(sha: string): Promise<string | null> {
    const result = await this.run(['cat-file', 'blob', sha], { allowNonZero: true });
    if (result.code !== 0) return null;
    return result.stdout.toString('utf8');
  }

  async readTree(treeish: string, env: Record<string, string>): Promise<void> {
    await this.run(['read-tree', treeish], { env });
  }

  async writeTree(env: Record<string, string>): Promise<string> {
    const result = await this.run(['write-tree'], { env });
    return result.stdout.toString('utf8').trim();
  }

  /**
   * Compute the tree hash of the *working tree* (tracked + untracked, honouring
   * .gitignore) using a throwaway index. Used for the byte-for-byte fidelity
   * proof; it creates blobs but never touches refs.
   */
  async computeWorkingTreeSha(env: Record<string, string>): Promise<string> {
    await this.run(['read-tree', '--empty'], { env });
    await this.run(['add', '-A', '--', '.'], { env });
    return (await this.run(['write-tree'], { env })).stdout.toString('utf8').trim();
  }

  async updateIndexCacheInfo(
    mode: string,
    sha: string,
    file: string,
    env: Record<string, string>,
  ): Promise<void> {
    await this.run(['update-index', '--add', '--cacheinfo', mode, sha, file], { env });
  }

  async updateIndexRemove(file: string, env: Record<string, string>): Promise<void> {
    await this.run(['update-index', '--force-remove', '--', file], { env });
  }

  /**
   * Create a commit object. Uses the repo's configured identity when present,
   * otherwise a deterministic fallback so the tool never blocks on config.
   */
  async commitTree(
    tree: string,
    parents: readonly string[],
    message: string,
  ): Promise<string> {
    const args = ['commit-tree', tree];
    for (const parent of parents) args.push('-p', parent);
    args.push('-m', message);
    const result = await this.run(args, { env: (await this.identity()) ?? undefined });
    return result.stdout.toString('utf8').trim();
  }

  async setBranch(branch: string, sha: string): Promise<void> {
    await this.run(['update-ref', `refs/heads/${branch}`, sha]);
  }

  /** Run a git command in an arbitrary working directory (e.g. a worktree). */
  runGitAt(cwd: string, args: readonly string[], opts: GitRunOpts = {}): Promise<GitRunResult> {
    return runGit(args, { cwd, ...opts });
  }

  /** Delete a branch ref. Used by `--undo`; never touches other refs. */
  async deleteBranch(branch: string): Promise<void> {
    await this.run(['update-ref', '-d', `refs/heads/${branch}`]);
  }

  private async identity(): Promise<Record<string, string> | null> {
    if (this.identityEnv) return this.identityEnv;
    const email = (await this.text(['config', '--get', 'user.email'], { allowNonZero: true })).trim();
    const name = (await this.text(['config', '--get', 'user.name'], { allowNonZero: true })).trim();
    if (email && name) {
      this.identityEnv = {};
      return this.identityEnv;
    }
    this.identityEnv = {
      GIT_AUTHOR_NAME: name || 'git-atomic',
      GIT_AUTHOR_EMAIL: email || 'git-atomic@localhost',
      GIT_COMMITTER_NAME: name || 'git-atomic',
      GIT_COMMITTER_EMAIL: email || 'git-atomic@localhost',
    };
    return this.identityEnv;
  }
}

function parseNameStatus(raw: string): NameStatusEntry[] {
  const parts = raw.split('\0');
  const entries: NameStatusEntry[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const status = parts[i];
    if (!status) continue;
    const file = parts[i + 1];
    if (file === undefined || file === '') {
      // Malformed/truncated entry: skip without consuming the next token.
      continue;
    }
    entries.push({ status: status[0] ?? 'M', path: toPosix(file) });
    i += 1;
  }
  return entries;
}
