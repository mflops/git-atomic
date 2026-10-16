import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface FixtureRepo {
  dir: string;
  git: (args: string[], env?: Record<string, string>) => string;
  write: (file: string, content: string) => Promise<void>;
  remove: (file: string) => Promise<void>;
  read: (file: string) => Promise<string>;
  commit: (message: string) => void;
  cleanup: () => Promise<void>;
}

const ROOT = path.join(os.tmpdir(), 'git-atomic-tests');

/** Create a throwaway git repo configured for byte-exact, deterministic tests. */
export async function createFixtureRepo(): Promise<FixtureRepo> {
  await fs.mkdir(ROOT, { recursive: true });
  const dir = await fs.mkdtemp(path.join(ROOT, 'repo-'));

  const git = (args: string[], env: Record<string, string> = {}): string =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: '0' },
    }).trim();

  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['config', 'core.autocrlf', 'false']);
  git(['config', 'core.safecrlf', 'false']);

  const write = async (file: string, content: string): Promise<void> => {
    const abs = path.join(dir, file);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  };

  const remove = async (file: string): Promise<void> => {
    await fs.rm(path.join(dir, file), { force: true, recursive: true });
  };

  const read = (file: string): Promise<string> => fs.readFile(path.join(dir, file), 'utf8');

  const commit = (message: string): void => {
    git(['add', '-A']);
    git(['commit', '-q', '-m', message]);
  };

  return {
    dir,
    git,
    write,
    remove,
    read,
    commit,
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  };
}

/** A small app fixture with a clean base commit. */
export async function seedBase(repo: FixtureRepo): Promise<void> {
  await repo.write(
    'package.json',
    `${JSON.stringify({ name: 'fixture', version: '1.0.0', type: 'module' }, null, 2)}\n`,
  );
  await repo.write(
    'src/math.ts',
    ['export const PI = 3.14159;', '', 'export function square(n: number): number {', '  return n * n;', '}', ''].join(
      '\n',
    ),
  );
  await repo.write(
    'src/index.ts',
    ["import { square } from './math.js';", '', 'export function run(n: number): number {', '  return square(n);', '}', ''].join(
      '\n',
    ),
  );
  repo.commit('initial');
}

/** Tree hash of the working tree, computed with a throwaway index. */
export function workingTreeSha(repo: FixtureRepo): string {
  const index = path.join(repo.dir, '.git', `verify-${Math.random().toString(36).slice(2)}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    repo.git(['read-tree', '--empty'], env);
    repo.git(['add', '-A', '--', '.'], env);
    return repo.git(['write-tree'], env);
  } finally {
    void fs.rm(index, { force: true });
  }
}
