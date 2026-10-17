import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { UsageError } from './errors.js';

export const CONFIG_FILENAME = 'git-atomic.config.json';

export const ConfigSchema = z.strictObject({
  /** Base ref to flatten from. Defaults to the merge-base with the main branch. */
  base: z.string().min(1).optional(),
  /** Name of the branch to write. Defaults to `git-atomic/split`. */
  branch: z.string().min(1).optional(),
  /** Apply instead of dry-running. */
  apply: z.boolean().optional(),
  /** Paths (globs) to exclude from the split. */
  ignore: z.array(z.string()).optional(),
  /** Upper bound on the number of generated commits. */
  maxCommits: z.number().int().positive().optional(),
  /**
   * Build/test command(s) to run after each generated commit. Every command
   * must exit 0 for a commit to be considered buildable. Commits that fail are
   * folded into the next commit and retried.
   */
  check: z
    .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
    .optional(),
  /** Per-command timeout in milliseconds. Defaults to 300000 (5 minutes). */
  checkTimeout: z.number().int().positive().optional(),
  /** Ignored dependency directories to link into the scratch checkout. */
  checkLinks: z.array(z.string().min(1)).optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

/** Load `git-atomic.config.json` from the repo root, if present. */
export async function loadConfig(repoRoot: string, explicitPath?: string): Promise<Config> {
  const file = explicitPath ?? path.join(repoRoot, CONFIG_FILENAME);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    if (explicitPath) throw new UsageError(`Config file not found: ${explicitPath}`);
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new UsageError(`Invalid JSON in ${file}: ${(error as Error).message}`);
  }
  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new UsageError(
      `Invalid config in ${file}:\n${result.error.issues
        .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('\n')}`,
    );
  }
  return result.data;
}
