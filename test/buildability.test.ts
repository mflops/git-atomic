import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GitRepo } from '../src/git/repo.js';
import { runPipeline } from '../src/pipeline.js';
import { verifyReconstruction } from '../src/apply/apply.js';

async function initRepo(name: string): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), `git-atomic-test-${name}-`));
  const { execSync } = await import('node:child_process');
  execSync('git init', { cwd });
  execSync('git config user.name "Test User"', { cwd });
  execSync('git config user.email "test@example.com"', { cwd });
  execSync('git config core.autocrlf false', { cwd });
  execSync('git config commit.gpgsign false', { cwd });
  return cwd;
}

async function write(cwd: string, path: string, content: string): Promise<void> {
  await writeFile(join(cwd, path), content);
}

async function commitAll(repo: GitRepo, msg: string): Promise<void> {
  await repo.run(['add', '-A']);
  await repo.run(['commit', '-m', msg]);
}

async function lastSha(repo: GitRepo): Promise<string> {
  const r = await repo.run(['rev-parse', 'HEAD']);
  return r.stdout.toString('utf8').trim();
}

async function makeBase(cwd: string, repo: GitRepo): Promise<void> {
  // Base: two feature files for a parity check; check counts feature/*.txt (odd must fail; even must pass)
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(cwd, 'feature'), { recursive: true });
  await write(cwd, 'check.js', `const fs=require('fs');\nconst files=fs.readdirSync('feature');\nconst count=files.filter(f=>f.endsWith('.txt')).length;\nif(count%2!==0){process.exit(1);}\nprocess.exit(0);\n`);
  await write(cwd, 'feature/a.txt', 'a');
  await write(cwd, 'feature/b.txt', 'b');
  await commitAll(repo, 'base');
}

describe('buildability', () => {
  it('folds failing commit forward to satisfy a check', async () => {
    const cwd = await initRepo('fold');
    const repo = await GitRepo.open(cwd);
    await makeBase(cwd, repo);
    const baseSha = await lastSha(repo);

    // Stage messy changes against base
    await write(cwd, 'feature/a.txt', 'a-modified');
    await write(cwd, 'feature/c.txt', 'c');
    await write(cwd, 'feature/d.txt', 'd');

    // Check: even count of .txt files passes
    const { plan, applied } = await runPipeline({
      cwd,
      base: baseSha,
      apply: true,
      force: true,
      check: ['node check.js'],
      checkTimeout: 5000,
    });

    expect(plan.buildability?.ran).toBe(true);
    expect(plan.buildability?.initialTotal).toBeGreaterThan(1);
    expect(plan.buildability?.total).toBeLessThanOrEqual(plan.buildability!.initialTotal);
    expect(plan.buildability?.passed).toBe(plan.buildability!.total);
    expect(plan.buildability?.unbuildable).toEqual([]);
    expect(plan.buildability?.folds.length).toBeGreaterThanOrEqual(1);

    expect(applied).not.toBeNull();
    const reopened = await GitRepo.open(cwd);
    expect(await reopened.branchExists('git-atomic/split')).toBe(true);
    expect(await reopened.revParse('git-atomic/split')).toBe(applied!.head);

    const mismatches = verifyReconstruction(plan);
    expect(mismatches).toEqual([]);

    await rm(cwd, { recursive: true, force: true });
  });

  it('skips verification when no check is configured', async () => {
    const cwd = await initRepo('no-check');
    const repo = await GitRepo.open(cwd);
    await makeBase(cwd, repo);
    const baseSha = await lastSha(repo);
    await write(cwd, 'feature/c.txt', 'c');

    const { plan } = await runPipeline({ cwd, base: baseSha, check: [] });
    expect(plan.buildability).toBeUndefined();
  });

  it('reports a check command and passes when it always succeeds', async () => {
    const cwd = await initRepo('pass');
    const repo = await GitRepo.open(cwd);
    await makeBase(cwd, repo);
    const baseSha = await lastSha(repo);
    await write(cwd, 'feature/c.txt', 'c');
    await write(cwd, 'feature/d.txt', 'd');

    const { plan } = await runPipeline({ cwd, base: baseSha, check: ['node check.js'] });
    expect(plan.buildability?.ran).toBe(true);
    expect(plan.buildability?.commands).toContain('node check.js');
    expect(plan.buildability?.passed).toBe(plan.buildability!.total);
    expect(plan.buildability?.unbuildable).toEqual([]);
  });

  it('leaves a failing commit as unbuildable when it cannot be folded further', async () => {
    const cwd = await initRepo('lastfails');
    const repo = await GitRepo.open(cwd);
    await makeBase(cwd, repo);
    const baseSha = await lastSha(repo);
    await write(cwd, 'failing.js', 'process.exit(1);\n');

    const { plan } = await runPipeline({
      cwd,
      base: baseSha,
      check: ['node failing.js'],
    });
    expect(plan.buildability?.ran).toBe(true);
    expect(plan.buildability?.total).toBe(1);
    expect(plan.buildability?.passed).toBe(0);
    expect(plan.buildability?.unbuildable.length).toBeGreaterThan(0);
  });
});
