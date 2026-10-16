import type { ChangeBlock } from '../model/types.js';

export interface DiffLine {
  kind: '+' | '-' | ' ';
  text: string;
}

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  header: string;
  lines: DiffLine[];
}

export interface ParsedDiffFile {
  oldPath: string | null;
  newPath: string | null;
  binary: boolean;
  hunks: DiffHunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function unquotePath(raw: string): string {
  let p = raw;
  // Strip the a/ or b/ prefix git emits.
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  // git quotes paths containing special characters with C-style escapes.
  if (p.startsWith('"') && p.endsWith('"')) {
    p = p.slice(1, -1).replace(/\\([\\"])/g, '$1').replace(/\\t/g, '\t').replace(/\\n/g, '\n');
  }
  return p;
}

/**
 * Parse a unified diff (as produced by `git diff -U0`) into per-file hunks.
 *
 * Deliberately hand-written and dependency-free: we only need line-range
 * information, and being able to feed it literal strings makes it testable.
 */
export function parseUnifiedDiff(text: string): ParsedDiffFile[] {
  const lines = text.split('\n');
  const files: ParsedDiffFile[] = [];
  let current: ParsedDiffFile | null = null;
  let hunk: DiffHunk | null = null;

  const pushHunk = () => {
    if (current && hunk) current.hunks.push(hunk);
    hunk = null;
  };

  for (const raw of lines) {
    if (raw.startsWith('diff --git ')) {
      pushHunk();
      current = { oldPath: null, newPath: null, binary: false, hunks: [] };
      // Binary diffs omit the ---/+++ lines, so seed the paths from the header.
      const m = /^diff --git a\/(.*?) b\/(.*)$/.exec(raw);
      if (m) {
        current.oldPath = unquotePath(`a/${m[1]}`);
        current.newPath = unquotePath(`b/${m[2]}`);
      }
      files.push(current);
      continue;
    }
    if (!current) continue;

    if (raw.startsWith('--- ')) {
      const p = raw.slice(4);
      current.oldPath = p === '/dev/null' ? null : unquotePath(p);
      continue;
    }
    if (raw.startsWith('+++ ')) {
      const p = raw.slice(4);
      current.newPath = p === '/dev/null' ? null : unquotePath(p);
      continue;
    }
    if (raw.startsWith('@@')) {
      pushHunk();
      const m = HUNK_RE.exec(raw);
      if (!m) continue;
      hunk = {
        oldStart: Number(m[1]),
        oldCount: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newCount: m[4] === undefined ? 1 : Number(m[4]),
        header: raw,
        lines: [],
      };
      continue;
    }
    if (hunk) {
      if (raw.startsWith('+')) hunk.lines.push({ kind: '+', text: raw.slice(1) });
      else if (raw.startsWith('-')) hunk.lines.push({ kind: '-', text: raw.slice(1) });
      else if (raw.startsWith(' ')) hunk.lines.push({ kind: ' ', text: raw.slice(1) });
      else if (raw.startsWith('\\')) continue; // "\ No newline at end of file"
      else pushHunk();
      continue;
    }

    if (raw.startsWith('Binary files ') || raw.startsWith('GIT binary patch')) {
      current.binary = true;
    }
    // Other headers (index, mode changes, similarity index, ...) are ignored.
  }
  pushHunk();

  return files.filter((f) => f.oldPath !== null || f.newPath !== null);
}

/**
 * Split hunks into contiguous replacement blocks.
 *
 * With `-U0` a hunk body is normally already a single block, but the parser
 * also handles diffs with context lines so the logic can be reused for tests
 * and for the `git apply`-style patches of the future.
 */
export function extractBlocks(file: string, hunks: readonly DiffHunk[]): ChangeBlock[] {
  const blocks: ChangeBlock[] = [];

  for (const h of hunks) {
    // Git's hunk header is subtle: when a side has zero lines, its start line
    // is the line *before* the change, not the next line. Normalise so the
    // cursor always points at the next line to consume on each side.
    let oldLine = h.oldCount === 0 ? h.oldStart + 1 : h.oldStart;
    let newLine = h.newCount === 0 ? h.newStart + 1 : h.newStart;
    let cur: ChangeBlock | null = null;

    const flush = () => {
      if (!cur) return;
      if (cur.newLines.length > 0 || cur.endOld >= cur.startOld) blocks.push(cur);
      cur = null;
    };

    for (const line of h.lines) {
      if (line.kind === '-') {
        if (!cur) cur = { file, startOld: oldLine, endOld: oldLine - 1, startNew: newLine, newLines: [] };
        cur.endOld = oldLine;
        oldLine += 1;
      } else if (line.kind === '+') {
        if (!cur) cur = { file, startOld: oldLine, endOld: oldLine - 1, startNew: newLine, newLines: [] };
        cur.newLines.push(line.text);
        newLine += 1;
      } else {
        flush();
        oldLine += 1;
        newLine += 1;
      }
    }
    flush();
  }

  return blocks;
}

export function isDeletionBlock(block: ChangeBlock): boolean {
  return block.newLines.length === 0 && block.endOld >= block.startOld;
}

/**
 * Apply line edits to a base file.
 *
 * Edits are sorted by position and must not overlap. `blocks` are validated by
 * construction (a single file's hunks never overlap once `-U0` is used), but
 * the sort makes the operation deterministic regardless of input order.
 */
export function applyBlocks(baseLines: readonly string[], blocks: readonly ChangeBlock[]): string[] {
  const sorted = [...blocks].sort((a, b) => a.startOld - b.startOld || a.endOld - b.endOld);
  const out: string[] = [];
  let cursor = 1; // next base line (1-based) to copy

  for (const block of sorted) {
    while (cursor < block.startOld) {
      out.push(baseLines[cursor - 1] ?? '');
      cursor += 1;
    }
    out.push(...block.newLines);
    if (block.endOld >= cursor) cursor = block.endOld + 1;
  }
  while (cursor <= baseLines.length) {
    out.push(baseLines[cursor - 1] ?? '');
    cursor += 1;
  }
  return out;
}

/** Detect whether two blocks touch the same base lines (i.e. cannot both apply). */
export function blocksOverlap(a: ChangeBlock, b: ChangeBlock): boolean {
  const aEmpty = a.endOld < a.startOld;
  const bEmpty = b.endOld < b.startOld;
  if (aEmpty && bEmpty) return a.startOld === b.startOld;
  if (aEmpty) return a.startOld > b.startOld && a.startOld <= b.endOld + 1;
  if (bEmpty) return b.startOld > a.startOld && b.startOld <= a.endOld + 1;
  return a.startOld <= b.endOld && b.startOld <= a.endOld;
}

/**
 * Split file content into lines plus a trailing-newline flag. The result is
 * byte-exact: `joinContent(splitContent(c)).equals(c)` for any input.
 */
export interface SplitContent {
  lines: string[];
  trailingNewline: boolean;
}

export function splitContent(content: string): SplitContent {
  if (content === '') return { lines: [], trailingNewline: false };
  const trailingNewline = content.endsWith('\n');
  const lines = content.split('\n');
  if (trailingNewline) lines.pop();
  return { lines, trailingNewline };
}

export function joinContent(lines: readonly string[], trailingNewline: boolean): string {
  if (lines.length === 0) return '';
  return lines.join('\n') + (trailingNewline ? '\n' : '');
}
