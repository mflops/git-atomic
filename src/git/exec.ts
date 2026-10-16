import { spawn } from 'node:child_process';
import { GitError } from '../errors.js';

export interface GitRunOptions {
  cwd: string;
  input?: string | Uint8Array;
  env?: Record<string, string | undefined>;
  /** Return the result instead of throwing on a non-zero exit code. */
  allowNonZero?: boolean;
}

export interface GitRunResult {
  stdout: Buffer;
  stderr: string;
  code: number;
}

/**
 * Run raw git plumbing. No shell, no high-level wrapper library: this keeps the
 * tool reflog-safe and makes every operation explicit and auditable.
 */
export function runGit(args: readonly string[], options: GitRunOptions): Promise<GitRunResult> {
  return new Promise<GitRunResult>((resolve, reject) => {
    const child = spawn('git', [...args], {
      cwd: options.cwd,
      windowsHide: true,
      env: {
        ...process.env,
        ...options.env,
        GIT_PAGER: 'cat',
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        LC_ALL: 'C',
        LANG: 'C',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

    child.on('error', (error) => reject(new GitError(args, (error as Error).message, -1)));
    child.on('close', (code) => {
      const result: GitRunResult = {
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString('utf8'),
        code: code ?? -1,
      };
      if (result.code !== 0 && !options.allowNonZero) {
        reject(new GitError(args, result.stderr, result.code));
      } else {
        resolve(result);
      }
    });

    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

export async function gitText(
  args: readonly string[],
  options: GitRunOptions,
): Promise<string> {
  const result = await runGit(args, options);
  return result.stdout.toString('utf8');
}
