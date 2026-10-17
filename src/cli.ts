#!/usr/bin/env node
import { createRequire } from 'node:module';
import { Command } from 'commander';
import { loadConfig, type Config } from './config.js';
import { GitAtomicError, UsageError } from './errors.js';
import { GitRepo } from './git/repo.js';
import { buildPlan, runPipeline } from './pipeline.js';
import { renderApplied, renderPlan } from './report.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

interface CliOptions {
  base?: string;
  branch?: string;
  apply?: boolean;
  dryRun?: boolean;
  force?: boolean;
  json?: boolean;
  ignore: string[];
  maxCommits?: number;
  symbols: boolean;
  config?: string;
  color?: boolean;
  check: string[];
  skipCheck?: boolean;
  checkTimeout?: number;
}

function useColor(option: boolean | undefined): boolean {
  if (option === false) return false;
  if (process.env.NO_COLOR) return false;
  return Boolean(process.env.FORCE_COLOR) || process.stdout.isTTY === true;
}

async function main(): Promise<number> {
  let exitCode = 0;
  const program = new Command();
  program
    .name('git-atomic')
    .description(
      'Turn a messy branch into clean, logically-ordered, buildable atomic commits.\n' +
        'Your original branch is never touched.',
    )
    .version(pkg.version)
    .option('--base <ref>', 'base ref to flatten from (default: merge-base with the main branch)')
    .option('--branch <name>', 'name of the new branch to create')
    .option('--apply', 'create the new branch (default: dry-run)')
    .option('--dry-run', 'print the plan without writing anything (default)')
    .option('--force', 'overwrite the target branch if it already exists')
    .option('--json', 'emit the plan as JSON (dry-run only)')
    .option(
      '--ignore <glob>',
      'exclude paths matching glob (repeatable)',
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option('--max-commits <n>', 'upper bound on generated commits', (value) => {
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) throw new UsageError(`--max-commits must be a positive integer`);
      return parsed;
    })
    .option('--no-symbols', 'disable symbol mapping (proximity clustering only)')
    .option('--config <path>', 'path to git-atomic.config.json')
    .option('--no-color', 'disable coloured output')
    .option('--check <cmd>', 'build/test command to run after each commit (repeatable)', (value: string, previous: string[]) => [...previous, value], [] as string[])
    .option('--skip-check', 'do not run checks even if configured')
    .option(
      '--check-timeout <ms>',
      'timeout for each check command in milliseconds',
      (value: string) => {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isFinite(parsed) || parsed <= 0) throw new UsageError('--check-timeout must be a positive integer');
        return parsed;
      },
    )
    .action(async (options: CliOptions) => {
      exitCode = await run(options);
    });

  await program.parseAsync(process.argv);
  return exitCode;
}

async function run(options: CliOptions): Promise<number> {
  const cwd = process.cwd();
  const repo = await GitRepo.open(cwd);
  const config: Config = await loadConfig(repo.root, options.config);

  const ignore = options.ignore.length > 0 ? options.ignore : (config.ignore ?? []);
  const base = options.base ?? config.base;
  const branch = options.branch ?? config.branch;
  const maxCommits = options.maxCommits ?? config.maxCommits;
  const apply = options.dryRun ? false : (options.apply ?? config.apply ?? false);

  const cliCheck = options.check ?? [];
  const configCheck = config.check === undefined ? [] : Array.isArray(config.check) ? config.check : [config.check];
  const check = options.skipCheck ? [] : (cliCheck.length > 0 ? cliCheck : configCheck);
  const checkTimeout = options.checkTimeout ?? config.checkTimeout;
  const checkLinks = config.checkLinks;

  const common = {
    cwd,
    ...(base ? { base } : {}),
    ...(branch ? { branch } : {}),
    ...(ignore.length > 0 ? { ignore } : {}),
    ...(maxCommits ? { maxCommits } : {}),
    ...(options.symbols ? {} : { mapper: null }),
    ...(check.length > 0 ? { check } : {}),
    ...(checkTimeout ? { checkTimeout } : {}),
    ...(checkLinks && checkLinks.length > 0 ? { checkLinks } : {}),
  };

  if (apply) {
    const { plan, applied } = await runPipeline({
      ...common,
      apply: true,
      force: options.force ?? false,
      onCommit: (info) => {
        if (!options.json) {
          process.stdout.write(`  ${info.index}. ${info.subject}\n`);
        }
      },
    });
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ plan: summarize(plan), applied }, null, 2)}\n`);
    } else if (applied) {
      process.stdout.write(`\n${renderApplied(plan, applied, { color: useColor(options.color) })}\n`);
    } else {
      process.stdout.write('No changes to apply.\n');
    }
    return 0;
  }

  const { plan } = await runPipeline({ ...common, apply: false });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(summarize(plan), null, 2)}\n`);
  } else {
    process.stdout.write(`${renderPlan(plan, { color: useColor(options.color) })}\n`);
  }
  return 0;
}

function summarize(plan: Awaited<ReturnType<typeof buildPlan>>) {
  return {
    repo: plan.repo,
    base: plan.base,
    baseRef: plan.baseRef,
    branch: plan.branch,
    stats: plan.stats,
    commits: plan.commits.map((c) => ({
      subject: c.message.subject,
      files: c.files,
      reason: c.cluster.reason,
      fromCycle: c.cluster.fromCycle,
      units: c.cluster.units.map((u) => ({
        file: u.file,
        label: u.label,
        kind: u.kind,
        defines: u.defines,
        imports: u.imports,
      })),
    })),
    edges: plan.graph.edges,
    notes: plan.notes,
    buildability: plan.buildability ?? null,
  };
}

main().catch((error: unknown) => {
  if (error instanceof GitAtomicError) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = error.code === 'USAGE' ? 2 : 1;
    return;
  }
  process.stderr.write(`error: ${(error as Error).stack ?? String(error)}\n`);
  process.exitCode = 1;
});
