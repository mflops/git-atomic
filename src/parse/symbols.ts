import type { DefinitionSymbol } from '../model/types.js';

/**
 * A pluggable source-symbol mapper.
 *
 * `web-tree-sitter` is the primary implementation; a dependency-free scanner
 * covers the case where the grammar wasm cannot be loaded (and unsupported
 * languages simply degrade to proximity clustering upstream).
 */
export interface SymbolMapper {
  readonly name: string;
  /** Whether this mapper can produce symbols for the given language id. */
  supports(language: string): boolean;
  map(file: string, content: string, language: string): DefinitionSymbol[];
}

/** Innermost symbol whose line range contains `line` (1-based). */
export function findEnclosingSymbol(
  symbols: readonly DefinitionSymbol[],
  line: number,
): DefinitionSymbol | null {
  let best: DefinitionSymbol | null = null;
  let bestSpan = Number.POSITIVE_INFINITY;
  for (const s of symbols) {
    if (line < s.startLine || line > s.endLine) continue;
    const span = s.endLine - s.startLine;
    if (span < bestSpan || (span === bestSpan && best !== null && s.startLine > best.startLine)) {
      best = s;
      bestSpan = span;
    }
  }
  return best;
}

export function makeSymbol(
  file: string,
  name: string,
  kind: DefinitionSymbol['kind'],
  startLine: number,
  endLine: number,
): DefinitionSymbol {
  return {
    name,
    kind,
    startLine,
    endLine: Math.max(startLine, endLine),
    key: `${file}#${name}#${startLine}`,
  };
}
