/**
 * Typed errors. Every externally-visible failure mode has a stable `code`
 * so callers (CLI, library consumers) can branch on it without string matching.
 */
export class GitAtomicError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'GitAtomicError';
    this.code = code;
  }
}

export class UsageError extends GitAtomicError {
  constructor(message: string) {
    super('USAGE', message);
    this.name = 'UsageError';
  }
}

export class GitError extends GitAtomicError {
  readonly args: readonly string[];
  readonly stderr: string;
  readonly exitCode: number;

  constructor(args: readonly string[], stderr: string, exitCode: number) {
    super('GIT', `git ${args.join(' ')} failed (exit ${exitCode})\n${stderr.trim()}`);
    this.name = 'GitError';
    this.args = args;
    this.stderr = stderr;
    this.exitCode = exitCode;
  }
}

/** Raised when the reconstructed tree does not reproduce the working tree byte-for-byte. */
export class FidelityError extends GitAtomicError {
  readonly mismatches: readonly string[];

  constructor(mismatches: readonly string[]) {
    super(
      'FIDELITY',
      `Refusing to proceed: reconstructed tree does not match the working tree byte-for-byte.\n` +
        mismatches.map((m) => `  - ${m}`).join('\n'),
    );
    this.name = 'FidelityError';
    this.mismatches = mismatches;
  }
}
