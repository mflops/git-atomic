import type { DefinitionSymbol } from '../model/types.js';
import { makeSymbol, type SymbolMapper } from './symbols.js';

/**
 * Replace comments and string/template literals with spaces, preserving byte
 * offsets and newlines. This lets brace matching and declaration regexes run on
 * "code only" text without being fooled by braces inside strings.
 *
 * Regex literals are intentionally not handled: they are rare as declaration
 * boundaries and mishandling one only degrades a single symbol's line range.
 */
export function maskSource(src: string): string {
  const out = new Array<string>(src.length).fill(' ');
  let i = 0;
  const n = src.length;
  const put = (idx: number, ch: string) => {
    out[idx] = ch === '\n' ? '\n' : ' ';
  };
  while (i < n) {
    const ch = src[i]!;
    const next = src[i + 1];
    if (ch === '/' && next === '/') {
      while (i < n && src[i] !== '\n') {
        put(i, src[i]!);
        i += 1;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      put(i, ch);
      put(i + 1, next!);
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        put(i, src[i]!);
        i += 1;
      }
      if (i < n) {
        put(i, '*');
        put(i + 1, '/');
        i += 2;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      out[i] = ' ';
      i += 1;
      while (i < n) {
        const c = src[i]!;
        if (c === '\\') {
          put(i, c);
          if (i + 1 < n) put(i + 1, src[i + 1]!);
          i += 2;
          continue;
        }
        if (c === ch) {
          out[i] = ' ';
          i += 1;
          break;
        }
        put(i, c);
        i += 1;
      }
      continue;
    }
    out[i] = ch;
    i += 1;
  }
  return out.join('');
}

function lineStarts(src: string): number[] {
  const starts = [0];
  for (let i = 0; i < src.length; i += 1) {
    if (src[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function lineAt(starts: readonly number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1; // 1-based
}

function findBraceEnd(mask: string, from: number): number {
  let depth = 0;
  let started = false;
  for (let i = from; i < mask.length; i += 1) {
    const c = mask[i];
    if (c === '{') {
      depth += 1;
      started = true;
    } else if (c === '}') {
      depth -= 1;
      if (started && depth === 0) return i;
    }
  }
  return -1;
}

interface DeclarationMatch {
  name: string;
  kind: DefinitionSymbol['kind'];
  index: number;
}

// Order matters: more specific keywords first so `class` wins over `const`.
const DECL_PATTERNS: Array<{ re: RegExp; kind: DefinitionSymbol['kind'] }> = [
  { re: /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/g, kind: 'function' },
  { re: /\bclass\s+([A-Za-z_$][\w$]*)/g, kind: 'class' },
  { re: /\binterface\s+([A-Za-z_$][\w$]*)/g, kind: 'interface' },
  { re: /\benum\s+([A-Za-z_$][\w$]*)/g, kind: 'enum' },
  { re: /\b(?:namespace|module)\s+([A-Za-z_$][\w$]*)\s*\{/g, kind: 'namespace' },
  { re: /\btype\s+([A-Za-z_$][\w$]*)\s*[=<]/g, kind: 'type' },
  { re: /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g, kind: 'variable' },
];

/**
 * Dependency-free TS/JS symbol scanner (fallback when tree-sitter is
 * unavailable). Line ranges are derived from brace matching on masked source.
 */
export class HeuristicSymbolMapper implements SymbolMapper {
  readonly name = 'heuristic';

  supports(language: string): boolean {
    return (
      language === 'typescript' ||
      language === 'tsx' ||
      language === 'javascript' ||
      language === 'jsx'
    );
  }

  map(file: string, content: string, _language: string): DefinitionSymbol[] {
    const mask = maskSource(content);
    const starts = lineStarts(content);
    const found: DeclarationMatch[] = [];

    for (const { re, kind } of DECL_PATTERNS) {
      re.lastIndex = 0;
      for (const m of mask.matchAll(re)) {
        if (m.index === undefined) continue;
        const name = m[1];
        if (!name) continue;
        found.push({ name, kind, index: m.index });
      }
    }

    found.sort((a, b) => a.index - b.index || a.name.localeCompare(b.name));

    const symbols: DefinitionSymbol[] = [];
    const seen = new Set<string>();
    for (const decl of found) {
      const startLine = lineAt(starts, decl.index);
      const braceIdx = mask.indexOf('{', decl.index + decl.name.length);
      let endLine = startLine;
      const stmtEnd = findStatementEnd(mask, decl.index + decl.name.length);
      if (braceIdx !== -1 && (stmtEnd === -1 || braceIdx < stmtEnd)) {
        const close = findBraceEnd(mask, braceIdx);
        endLine = close === -1 ? startLine : lineAt(starts, close);
      } else if (stmtEnd !== -1) {
        endLine = lineAt(starts, stmtEnd);
      }
      const key = `${file}#${decl.name}#${startLine}`;
      if (seen.has(key)) continue;
      seen.add(key);
      symbols.push(makeSymbol(file, decl.name, decl.kind, startLine, endLine));
    }

    return symbols;
  }
}

/** Offset of the first `;` or newline after `from`, whichever comes first. */
function findStatementEnd(mask: string, from: number): number {
  for (let i = from; i < mask.length; i += 1) {
    const c = mask[i];
    if (c === ';' || c === '\n') return i;
  }
  return -1;
}
