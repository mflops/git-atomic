import { describe, expect, it } from 'vitest';
import {
  applyBlocks,
  extractBlocks,
  joinContent,
  parseUnifiedDiff,
  splitContent,
} from '../src/diff/parse.js';

const insertionDiff = [
  'diff --git a/src/math.ts b/src/math.ts',
  'index 1111111..2222222 100644',
  '--- a/src/math.ts',
  '+++ b/src/math.ts',
  '@@ -5,0 +6,4 @@',
  '+',
  '+export function add(a: number, b: number): number {',
  '+  return a + b;',
  '+}',
  '',
].join('\n');

describe('parseUnifiedDiff', () => {
  it('parses a pure-insertion hunk', () => {
    const [file] = parseUnifiedDiff(insertionDiff);
    expect(file?.hunks).toHaveLength(1);
    const hunk = file!.hunks[0]!;
    expect(hunk.oldStart).toBe(5);
    expect(hunk.oldCount).toBe(0);
    expect(hunk.newStart).toBe(6);
    expect(hunk.newCount).toBe(4);
  });

  it('parses a new file', () => {
    const diff = [
      'diff --git a/src/new.ts b/src/new.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/new.ts',
      '@@ -0,0 +1,2 @@',
      '+export const x = 1;',
      '+export const y = 2;',
      '',
    ].join('\n');
    const [file] = parseUnifiedDiff(diff);
    expect(file?.oldPath).toBeNull();
    expect(file?.newPath).toBe('src/new.ts');
  });

  it('parses a file deletion', () => {
    const diff = [
      'diff --git a/gone.ts b/gone.ts',
      'deleted file mode 100644',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1,3 +0,0 @@',
      '-a',
      '-b',
      '-c',
      '',
    ].join('\n');
    const [file] = parseUnifiedDiff(diff);
    expect(file?.newPath).toBeNull();
    expect(file?.oldPath).toBe('gone.ts');
  });

  it('detects binary files', () => {
    const diff = [
      'diff --git a/logo.png b/logo.png',
      'index 1111111..2222222 100644',
      'Binary files a/logo.png and b/logo.png differ',
      '',
    ].join('\n');
    const [file] = parseUnifiedDiff(diff);
    expect(file?.binary).toBe(true);
  });
});

describe('extractBlocks', () => {
  it('anchors a pure insertion after the referenced base line', () => {
    const [file] = parseUnifiedDiff(insertionDiff);
    const blocks = extractBlocks('src/math.ts', file!.hunks);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ startOld: 6, endOld: 5, startNew: 6 });
  });

  it('splits a hunk at context lines', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,4 +1,4 @@',
      '+one',
      ' context',
      '-old',
      '+new',
      '',
    ].join('\n');
    const [parsed] = parseUnifiedDiff(diff);
    const blocks = extractBlocks('a.ts', parsed!.hunks);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ startOld: 1, endOld: 0, newLines: ['one'] });
    expect(blocks[1]).toMatchObject({ startOld: 2, endOld: 2, startNew: 3, newLines: ['new'] });
  });

  it('represents a pure deletion', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -2,2 +1,0 @@',
      '-x',
      '-y',
      '',
    ].join('\n');
    const [parsed] = parseUnifiedDiff(diff);
    const blocks = extractBlocks('a.ts', parsed!.hunks);
    expect(blocks[0]).toMatchObject({ startOld: 2, endOld: 3, newLines: [] });
  });
});

describe('applyBlocks', () => {
  const base = ['a', 'b', 'c', 'd', 'e'];

  it('inserts after a base line', () => {
    const result = applyBlocks(base, [
      { file: 'f', startOld: 3, endOld: 2, startNew: 3, newLines: ['X'] },
    ]);
    expect(result).toEqual(['a', 'b', 'X', 'c', 'd', 'e']);
  });

  it('inserts at the beginning', () => {
    const result = applyBlocks(base, [
      { file: 'f', startOld: 1, endOld: 0, startNew: 1, newLines: ['X'] },
    ]);
    expect(result).toEqual(['X', 'a', 'b', 'c', 'd', 'e']);
  });

  it('appends at the end', () => {
    const result = applyBlocks(base, [
      { file: 'f', startOld: 6, endOld: 5, startNew: 6, newLines: ['X'] },
    ]);
    expect(result).toEqual(['a', 'b', 'c', 'd', 'e', 'X']);
  });

  it('replaces a range and is order independent', () => {
    const result = applyBlocks(base, [
      { file: 'f', startOld: 4, endOld: 5, startNew: 4, newLines: ['D'] },
      { file: 'f', startOld: 2, endOld: 2, startNew: 2, newLines: ['B'] },
    ]);
    expect(result).toEqual(['a', 'B', 'c', 'D']);
  });

  it('deletes a range', () => {
    const result = applyBlocks(base, [
      { file: 'f', startOld: 2, endOld: 4, startNew: 2, newLines: [] },
    ]);
    expect(result).toEqual(['a', 'e']);
  });
});

describe('splitContent / joinContent', () => {
  it('round-trips content with and without a trailing newline', () => {
    for (const content of ['', 'a', 'a\n', 'a\nb', 'a\nb\n', '\n', 'a\n\nb\n']) {
      const { lines, trailingNewline } = splitContent(content);
      expect(joinContent(lines, trailingNewline)).toBe(content);
    }
  });
});
