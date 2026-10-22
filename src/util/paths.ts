import path from 'node:path';
import type { UnitKind } from '../model/types.js';

/** Extensions we attempt to parse with tree-sitter. */
export const SCRIPT_EXTS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.pyi',
  '.go',
  '.rs',
  '.java',
  '.c',
  '.h',
  '.cc',
  '.cpp',
  '.cxx',
  '.hpp',
  '.hh',
  '.hxx',
  '.rb',
  '.php',
  '.cs',
] as const;

const MODULE_EXTS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.py',
  '.go',
  '.rs',
];

const CONFIG_BASENAMES = new Set([
  'tsconfig.json',
  'jsconfig.json',
  'package.json.j2',
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  '.prettierrc',
  '.prettierrc.json',
  '.babelrc',
  '.editorconfig',
  'vite.config.ts',
  'vitest.config.ts',
  'jest.config.js',
  'jest.config.ts',
  'rollup.config.js',
  'tsup.config.ts',
  'babel.config.js',
]);

const MANIFEST_BASENAMES = new Set(['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod']);

const LOCKFILE_BASENAMES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'Cargo.lock',
  'poetry.lock',
  'go.sum',
]);

/** Always use forward slashes for repo-relative paths (git's convention). */
export function toPosix(p: string): string {
  return p.split(path.sep).join('/').replace(/\\/g, '/');
}

export function basename(p: string): string {
  const norm = toPosix(p);
  const i = norm.lastIndexOf('/');
  return i === -1 ? norm : norm.slice(i + 1);
}

export function dirname(p: string): string {
  const norm = toPosix(p);
  const i = norm.lastIndexOf('/');
  return i === -1 ? '' : norm.slice(0, i);
}

export function extname(p: string): string {
  const base = basename(p);
  const i = base.lastIndexOf('.');
  return i <= 0 ? '' : base.slice(i);
}

export function stripExt(p: string): string {
  const e = extname(p);
  return e ? p.slice(0, -e.length) : p;
}

export type ScriptLanguage =
  | 'typescript'
  | 'tsx'
  | 'javascript'
  | 'jsx'
  | 'python'
  | 'go'
  | 'rust'
  | 'java'
  | 'cpp'
  | 'c'
  | 'ruby'
  | 'php'
  | 'csharp';

/** Returns the tree-sitter language id for a path, or null when unsupported. */
export function languageOf(p: string): ScriptLanguage | null {
  switch (extname(p)) {
    case '.ts':
    case '.mts':
    case '.cts':
      return 'typescript';
    case '.tsx':
      return 'tsx';
    case '.js':
    case '.mjs':
    case '.cjs':
      return 'javascript';
    case '.jsx':
      return 'jsx';
    case '.py':
    case '.pyi':
      return 'python';
    case '.go':
      return 'go';
    case '.rs':
      return 'rust';
    case '.java':
      return 'java';
    case '.c':
    case '.h':
      return 'c';
    case '.cc':
    case '.cpp':
    case '.cxx':
    case '.hpp':
    case '.hh':
    case '.hxx':
      return 'cpp';
    case '.rb':
      return 'ruby';
    case '.php':
      return 'php';
    case '.cs':
      return 'csharp';
    default:
      return null;
  }
}

export function isTestPath(p: string): boolean {
  const norm = toPosix(p);
  if (/(^|\/)__tests__(\/|$)/.test(norm)) return true;
  if (/(^|\/)tests?\//.test(norm)) return true;
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(norm)) return true;
  return false;
}

export function isDocsPath(p: string): boolean {
  const norm = toPosix(p);
  if (/\.(md|mdx|rst|txt|adoc)$/i.test(norm)) return true;
  if (/(^|\/)docs?\//i.test(norm)) return true;
  return false;
}

export function isTypeDeclarationPath(p: string): boolean {
  const norm = toPosix(p);
  if (/\.d\.[cm]?ts$/.test(norm)) return true;
  if (/(^|\/)types?\//i.test(norm)) return true;
  return false;
}

/** Classify a file into a {@link UnitKind} used for ordering and messaging. */
export function detectKind(p: string): UnitKind {
  const base = basename(p);
  if (LOCKFILE_BASENAMES.has(base)) return 'lockfile';
  if (MANIFEST_BASENAMES.has(base)) return 'manifest';
  if (isTestPath(p)) return 'test';
  if (isDocsPath(p)) return 'docs';
  if (isTypeDeclarationPath(p)) return 'types';
  if (CONFIG_BASENAMES.has(base)) return 'config';
  if (/\.(json|ya?ml|toml|ini|properties)$/i.test(base)) return 'config';
  if (languageOf(p)) return 'implementation';
  return 'other';
}

/** Ordering priority: lower rank lands earlier in the new history. */
export const KIND_RANK: Record<UnitKind, number> = {
  config: 0,
  types: 1,
  manifest: 2,
  implementation: 3,
  other: 4,
  test: 5,
  docs: 6,
  lockfile: 7,
};

/**
 * Resolve a relative import specifier to a repo-relative path that exists in
 * `files`. Handles the TypeScript ESM convention where `./a.js` refers to
 * `./a.ts`.
 */
export function resolveImportPath(
  specifier: string,
  fromFile: string,
  files: ReadonlySet<string>,
): string | null {
  if (!specifier.startsWith('.')) return null;
  const baseDir = dirname(fromFile);
  const joined = path.posix.normalize(path.posix.join(baseDir, specifier));

  const candidates: string[] = [];
  candidates.push(joined);
  // ESM/TS: strip a trailing .js/.mjs/.cjs and retry with TS extensions.
  const e = extname(joined);
  if (e && ['.js', '.jsx', '.mjs', '.cjs'].includes(e)) {
    const stem = joined.slice(0, -e.length);
    for (const ext of MODULE_EXTS) candidates.push(stem + ext);
  }
  for (const ext of MODULE_EXTS) candidates.push(joined + ext);
  for (const ext of MODULE_EXTS) candidates.push(path.posix.join(joined, `index${ext}`));

  for (const c of candidates) {
    const norm = c.replace(/^\.\//, '');
    if (files.has(norm)) return norm;
  }
  return null;
}

/** Extract module specifiers from a single added line (import/require/export-from). */
export function extractImportSpecifiers(line: string): string[] {
  const out: string[] = [];
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
  ];
  for (const re of patterns) {
    for (const m of line.matchAll(re)) {
      const spec = m[1];
      if (spec) out.push(spec);
    }
  }
  return out;
}

const KEYWORDS = new Set([
  'abstract',
  'as',
  'async',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'from',
  'function',
  'get',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'let',
  'new',
  'null',
  'of',
  'package',
  'private',
  'protected',
  'public',
  'readonly',
  'return',
  'satisfies',
  'set',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'type',
  'typeof',
  'undefined',
  'var',
  'void',
  'while',
  'with',
  'yield',
]);

export function isKeyword(word: string): boolean {
  return KEYWORDS.has(word);
}

const IDENT_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g;

export function extractIdentifiers(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(IDENT_RE)) out.push(m[0]);
  return out;
}

function globToRegExp(pattern: string): RegExp {
  const norm = toPosix(pattern);
  let re = '';
  for (let i = 0; i < norm.length; i += 1) {
    const c = norm[i]!;
    if (c === '*') {
      if (norm[i + 1] === '*') {
        re += '.*';
        i += 1;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  // A pattern without a slash matches at any depth.
  const anchored = norm.includes('/') ? `^${re}(/.*)?$` : `(^|/)${re}(/.*)?$`;
  return new RegExp(anchored);
}

export function matchesAnyGlob(p: string, patterns: readonly string[]): boolean {
  const norm = toPosix(p);
  return patterns.some((pattern) => globToRegExp(pattern).test(norm));
}
