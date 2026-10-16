import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyReconstruction } from '../src/apply/apply.js';
import { UsageError } from '../src/errors.js';
import { GitRepo } from '../src/git/repo.js';
import { HeuristicSymbolMapper } from '../src/parse/heuristic.js';
import { buildPlan, runPipeline } from '../src/pipeline.js';
import { createFixtureRepo, seedBase, workingTreeSha, type FixtureRepo } from './helpers/repo.js';

const mapper = new HeuristicSymbolMapper();

let repo: FixtureRepo;

beforeEach(async () => {
  repo = await createFixtureRepo();
  await seedBase(repo);
});

afterEach(async () => {
  await repo.cleanup();
});

/** Apply a representative multi-file change on top of the seed. */
async function applyChanges(r: FixtureRepo): Promise<void> {
  await r.write(
    'src/math.ts',
    [
      'export const PI = 3.14159;',
      '',
      'export function square(n: number): number {',
      '  return n * n;',
      '}',
      '',
      'export function add(a: number, b: number): number {',
      '  return a + b;',
      '}',
      '',
    ].join('\n'),
  );
  await r.write(
    'src/string.ts',
    ['export function titleCase(input: string): string {', '  return input.toUpperCase();', '}', ''].join('\n'),
  );
  await r.write(
    'src/index.ts',
    [
      "import { add, square } from './math.js';",
      "import { titleCase } from './string.js';",
      '',
      'export function run(n: number): number {',
      '  return square(n);',
      '}',
      '',
      'export function compute(a: number, b: number): number {',
      '  return add(a, b);',
      '}',
      '',
      'export function label(name: string): string {',
      '  return titleCase(name);',
      '}',
      '',
    ].join('\n'),
  );
  await r.write(
    'test/math.test.ts',
    [
      "import { add } from '../src/math.js';",
      '',
      'export function testAdd(): void {',
      '  if (add(1, 2) !== 3) throw new Error("bad");',
      '}',
      '',
    ].join('\n'),
  );
  await r.write('README.md', '# fixture\n');
}

describe('buildPlan (dry run)', () => {
  it('produces an ordered, buildable plan without touching refs', async () => {
    await applyChanges(repo);
    const headBefore = repo.git(['rev-parse', 'HEAD']);

    const plan = await buildPlan({ cwd: repo.dir, base: 'HEAD', mapper });

    expect(plan.baseRef).toBe('HEAD');
    expect(plan.stats.files).toBe(5);
    expect(plan.commits.length).toBeGreaterThanOrEqual(4);
    expect(repo.git(['rev-parse', 'HEAD'])).toBe(headBefore);
    expect(() => repo.git(['rev-parse', 'verify', 'git-atomic/split'])).toThrow();

    const subjects = plan.commits.map((c) => c.message.subject);
    // Definitions land before the call site that uses them.
    const mathIndex = subjects.findIndex((s) => s.startsWith('feat(math):'));
    const indexCommit = subjects.findIndex((s) => s.startsWith('feat(index):'));
    expect(mathIndex).toBeGreaterThanOrEqual(0);
    expect(indexCommit).toBeGreaterThan(mathIndex);
    // Tests and docs land last.
    expect(subjects.findIndex((s) => s.startsWith('test('))).toBeGreaterThan(indexCommit);
    expect(subjects.at(-1)).toContain('docs');
  });

  it('verifies the reconstruction byte-for-byte', async () => {
    await applyChanges(repo);
    const plan = await buildPlan({ cwd: repo.dir, base: 'HEAD', mapper });
    expect(verifyReconstruction(plan)).toEqual([]);
  });

  it('refuses a tree that does not reconstruct', async () => {
    await applyChanges(repo);
    const plan = await buildPlan({ cwd: repo.dir, base: 'HEAD', mapper });
    const first = plan.files.find((f) => !f.binary && f.status !== 'deleted')!;
    first.newContent += '// tampered\n';
    expect(verifyReconstruction(plan).length).toBeGreaterThan(0);
  });

  it('caps the number of commits with maxCommits', async () => {
    await applyChanges(repo);
    const plan = await buildPlan({ cwd: repo.dir, base: 'HEAD', mapper, maxCommits: 2 });
    expect(plan.commits).toHaveLength(2);
  });
});

describe('runPipeline --apply', () => {
  it('creates a new branch whose tree matches the working tree exactly', async () => {
    await applyChanges(repo);
    const headBefore = repo.git(['rev-parse', 'HEAD']);

    const { plan, applied } = await runPipeline({
      cwd: repo.dir,
      base: 'HEAD',
      apply: true,
      mapper,
    });

    expect(applied).not.toBeNull();
    expect(applied!.branch).toBe('git-atomic/split');
    expect(applied!.commits).toHaveLength(plan.commits.length);

    const branchTree = repo.git(['rev-parse', 'git-atomic/split^{tree}']);
    expect(branchTree).toBe(workingTreeSha(repo));

    // The original branch is untouched.
    expect(repo.git(['rev-parse', 'HEAD'])).toBe(headBefore);
    expect(repo.git(['rev-parse', 'main'])).toBe(headBefore);
    expect(repo.git(['branch', '--show-current'])).toBe('main');
  });

  it('preserves file deletions', async () => {
    await repo.write('src/legacy.ts', 'export const legacy = true;\n');
    repo.commit('add legacy');
    await repo.remove('src/legacy.ts');

    const { applied } = await runPipeline({ cwd: repo.dir, base: 'HEAD', apply: true, mapper });
    expect(applied).not.toBeNull();
    expect(repo.git(['rev-parse', 'git-atomic/split^{tree}'])).toBe(workingTreeSha(repo));
    const tree = repo.git(['ls-tree', '-r', '--name-only', 'git-atomic/split']);
    expect(tree).not.toContain('src/legacy.ts');
  });

  it('handles binary files', async () => {
    await repo.write('assets/logo.bin', 'BM\u0000\u0001\u0002binary');
    const { applied } = await runPipeline({ cwd: repo.dir, base: 'HEAD', apply: true, mapper });
    expect(applied).not.toBeNull();
    expect(repo.git(['rev-parse', 'git-atomic/split^{tree}'])).toBe(workingTreeSha(repo));
  });

  it('refuses to overwrite an existing branch without --force', async () => {
    await applyChanges(repo);
    await runPipeline({ cwd: repo.dir, base: 'HEAD', apply: true, mapper });
    await expect(
      runPipeline({ cwd: repo.dir, base: 'HEAD', apply: true, mapper }),
    ).rejects.toBeInstanceOf(UsageError);
  });

  it('overwrites with --force', async () => {
    await applyChanges(repo);
    await runPipeline({ cwd: repo.dir, base: 'HEAD', apply: true, mapper });
    const { applied } = await runPipeline({
      cwd: repo.dir,
      base: 'HEAD',
      apply: true,
      force: true,
      mapper,
    });
    expect(applied).not.toBeNull();
    expect(repo.git(['rev-parse', 'git-atomic/split^{tree}'])).toBe(workingTreeSha(repo));
  });

  it('keeps tree fidelity when commits are capped', async () => {
    await applyChanges(repo);
    const { applied } = await runPipeline({
      cwd: repo.dir,
      base: 'HEAD',
      apply: true,
      maxCommits: 2,
      mapper,
    });
    expect(applied!.commits).toHaveLength(2);
    expect(repo.git(['rev-parse', 'git-atomic/split^{tree}'])).toBe(workingTreeSha(repo));
  });

  it('uses a custom (async) message generator without changing what is committed', async () => {
    await applyChanges(repo);
    const seen: string[] = [];
    const generator = {
      name: 'test',
      async generate(cluster: { units: Array<{ id: string }> }) {
        seen.push(cluster.units[0]!.id);
        return { subject: `custom: ${cluster.units.length} unit(s)`, body: 'body', type: 'chore', scope: null };
      },
    };
    const { plan, applied } = await runPipeline({
      cwd: repo.dir,
      base: 'HEAD',
      apply: true,
      mapper,
      messageGenerator: generator,
    });
    expect(applied!.commits.every((c) => c.subject.startsWith('custom:'))).toBe(true);
    expect(seen).toHaveLength(plan.commits.length);
    expect(repo.git(['rev-parse', 'git-atomic/split^{tree}'])).toBe(workingTreeSha(repo));
  });
});

describe('GitRepo', () => {
  it('rejects non-repository directories', async () => {
    const dir = repo.dir;
    await expect(GitRepo.open(`${dir}/does-not-exist`)).rejects.toBeInstanceOf(UsageError);
  });
});

describe('empty working tree', () => {
  it('plans nothing and applies nothing', async () => {
    const plan = await buildPlan({ cwd: repo.dir, base: 'HEAD', mapper });
    expect(plan.commits).toEqual([]);
    expect(plan.stats.files).toBe(0);

    const { applied } = await runPipeline({ cwd: repo.dir, base: 'HEAD', apply: true, mapper });
    expect(applied).toBeNull();
    expect(() => repo.git(['rev-parse', 'verify', 'git-atomic/split'])).toThrow();
  });
});
