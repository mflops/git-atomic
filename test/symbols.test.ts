import { describe, expect, it } from 'vitest';
import { HeuristicSymbolMapper } from '../src/parse/heuristic.js';
import { findEnclosingSymbol } from '../src/parse/symbols.js';
import { resolveTreeSitterMapper } from '../src/parse/treesitter.js';

const SOURCE = [
  "import { readFile } from 'node:fs/promises';",
  '',
  'export interface Options {',
  '  path: string;',
  '}',
  '',
  'export type Mode = "a" | "b";',
  '',
  'export class Loader {',
  '  load(): string {',
  '    return "x";',
  '  }',
  '}',
  '',
  'export function parse(input: string): string {',
  '  return input.trim();',
  '}',
  '',
  'export const VERSION = "1";',
  '',
].join('\n');

describe('HeuristicSymbolMapper', () => {
  const mapper = new HeuristicSymbolMapper();

  it('supports TS/JS languages only', () => {
    expect(mapper.supports('typescript')).toBe(true);
    expect(mapper.supports('tsx')).toBe(true);
    expect(mapper.supports('javascript')).toBe(true);
    expect(mapper.supports('python')).toBe(false);
  });

  it('finds declarations with line ranges', () => {
    const symbols = mapper.map('a.ts', SOURCE, 'typescript');
    const byName = new Map(symbols.map((s) => [s.name, s]));
    expect(byName.get('Options')?.startLine).toBe(3);
    expect(byName.get('Options')?.endLine).toBe(5);
    expect(byName.get('Mode')?.kind).toBe('type');
    expect(byName.get('Loader')?.kind).toBe('class');
    expect(byName.get('Loader')?.startLine).toBe(9);
    expect(byName.get('Loader')?.endLine).toBe(13);
    expect(byName.get('parse')?.kind).toBe('function');
    expect(byName.get('parse')?.startLine).toBe(15);
    expect(byName.get('parse')?.endLine).toBe(17);
    expect(byName.get('VERSION')?.kind).toBe('variable');
  });

  it('is not fooled by braces inside strings', () => {
    const source = ['const s = "}{";', 'export function f() {', '  return 1;', '}', ''].join('\n');
    const symbols = mapper.map('b.ts', source, 'typescript');
    const f = symbols.find((s) => s.name === 'f');
    expect(f?.endLine).toBe(4);
  });
});

describe('findEnclosingSymbol', () => {
  it('returns the innermost symbol containing the line', () => {
    const symbols = [
      { name: 'outer', kind: 'function' as const, startLine: 1, endLine: 20, key: 'k1' },
      { name: 'inner', kind: 'function' as const, startLine: 5, endLine: 10, key: 'k2' },
    ];
    expect(findEnclosingSymbol(symbols, 7)?.name).toBe('inner');
    expect(findEnclosingSymbol(symbols, 15)?.name).toBe('outer');
    expect(findEnclosingSymbol(symbols, 25)).toBeNull();
  });
});

describe('TreeSitterSymbolMapper', () => {
  it('parses TS via wasm and maps the same symbols', async () => {
    const { mapper } = await resolveTreeSitterMapper();
    if (!mapper) {
      // Environment without the wasm grammars: the heuristic mapper is the
      // documented fallback, so this is not a failure.
      expect(mapper).toBeNull();
      return;
    }
    expect(mapper.name).toBe('tree-sitter');
    const symbols = mapper.map('a.ts', SOURCE, 'typescript');
    const names = symbols.map((s) => s.name);
    expect(names).toContain('Options');
    expect(names).toContain('Loader');
    expect(names).toContain('parse');
    const parse = symbols.find((s) => s.name === 'parse');
    expect(parse?.startLine).toBe(15);
    expect(parse?.endLine).toBe(17);
  });
});
