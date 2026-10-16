import type {
  ChangeBlock,
  ChangeStatus,
  ChangeUnit,
  DefinitionSymbol,
  FileChange,
} from '../model/types.js';
import { extractBlocks, parseUnifiedDiff, splitContent } from '../diff/parse.js';
import type { GitRepo, NameStatusEntry } from '../git/repo.js';
import { findEnclosingSymbol, type SymbolMapper } from '../parse/symbols.js';
import {
  basename,
  detectKind,
  extractIdentifiers,
  extractImportSpecifiers,
  isKeyword,
  languageOf,
  matchesAnyGlob,
} from '../util/paths.js';

/** Blocks separated by more than this many lines are treated as distinct edits. */
const PROXIMITY_GAP = 8;
/** Same-file units closer than this collapse into a single commit. */
const SAME_FILE_MERGE_GAP = 12;

export interface CollectOptions {
  ignore: readonly string[];
}

export interface CollectResult {
  files: FileChange[];
  notes: string[];
}

function statusFromLetter(letter: string): ChangeStatus {
  switch (letter) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'T':
      return 'typechange';
    default:
      return 'modified';
  }
}

function looksBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 8000);
  for (let i = 0; i < limit; i += 1) if (bytes[i] === 0) return true;
  return false;
}

/**
 * Return the text git would store for this file (attributes/filters applied).
 *
 * Most files need no conversion, in which case we avoid writing any object and
 * simply decode the bytes. Files that *are* transformed (e.g. CRLF -> LF under
 * `core.autocrlf`) are normalised via a real blob so the reconstructed tree is
 * guaranteed to match what `git add` would produce.
 */
async function normalizedText(
  repo: GitRepo,
  buf: Buffer,
  file: string,
  mode: string | null,
): Promise<string> {
  if (mode === '120000') return buf.toString('utf8');
  const [filtered, plain] = await Promise.all([
    repo.hashObject(buf, file),
    repo.hashObject(buf),
  ]);
  if (filtered === plain) return buf.toString('utf8');
  const sha = await repo.hashObjectWrite(buf, file);
  return (await repo.catFileText(sha)) ?? buf.toString('utf8');
}

/** Snapshot the base -> working-tree diff into {@link FileChange}s. */
export async function collectFileChanges(
  repo: GitRepo,
  base: string,
  options: CollectOptions,
): Promise<CollectResult> {
  const notes: string[] = [];
  const files: FileChange[] = [];
  const entries = await repo.listNameStatus(base);
  const untracked = await repo.listUntracked();

  const seen = new Set<string>();
  const all: Array<NameStatusEntry | { status: 'A'; path: string; untracked: true }> = [
    ...entries,
    ...untracked.map((p) => ({ status: 'A' as const, path: p, untracked: true as const })),
  ];

  for (const entry of all) {
    const file = entry.path;
    if (seen.has(file)) continue;
    seen.add(file);
    if (options.ignore.length > 0 && matchesAnyGlob(file, options.ignore)) {
      notes.push(`ignored by config: ${file}`);
      continue;
    }

    const mode = await repo.baseMode(base, file);
    if (mode === '160000') {
      notes.push(`skipped submodule: ${file}`);
      continue;
    }

    const status = statusFromLetter(entry.status);
    const exists = await repo.workingFileExists(file);
    const effectiveStatus: ChangeStatus = !exists && status !== 'deleted' ? 'deleted' : status;
    const isDeleted = effectiveStatus === 'deleted';

    let rawBytes: Uint8Array | undefined;
    let newContent = '';
    let binary = false;
    if (!isDeleted) {
      const buf = await repo.readWorkingFile(file);
      rawBytes = buf;
      binary = looksBinary(buf);
      if (!binary) {
        newContent = await normalizedText(repo, buf, file, mode);
      }
    }

    const baseContent = (await repo.fileContentAt(base, file)) ?? '';
    const kind = detectKind(file);
    const language = languageOf(file);

    let blocks: ChangeBlock[] = [];
    if (!binary) {
      if ('untracked' in entry && entry.untracked) {
        const { lines } = splitContent(newContent);
        blocks =
          lines.length > 0 || newContent === ''
            ? [{ file, startOld: 1, endOld: 0, startNew: 1, newLines: lines }]
            : [];
      } else {
        const patch = await repo.filePatch(base, file);
        const parsed = parseUnifiedDiff(patch);
        const first = parsed.find((f) => (f.newPath ?? f.oldPath) === file) ?? parsed[0];
        if (first) {
          binary = first.binary;
          blocks = extractBlocks(file, first.hunks);
        }
      }
    }

    files.push({
      path: file,
      status: effectiveStatus,
      kind,
      language: language ?? 'other',
      binary,
      baseContent,
      newContent,
      ...(rawBytes ? { rawBytes } : {}),
      executable: !isDeleted && (await repo.workingFileMode(file)) === '100755',
      baseMode: mode,
      blocks,
    });
  }

  return { files, notes };
}

interface Group {
  symbol: DefinitionSymbol | null;
  symbolKey: string;
  blocks: ChangeBlock[];
}

/** Group a file's blocks by enclosing symbol, with a proximity fallback. */
function groupBlocks(file: FileChange, symbols: readonly DefinitionSymbol[]): Group[] {
  const groups: Group[] = [];
  const bySymbol = new Map<string, Group>();
  const { lines } = splitContent(file.newContent);
  const total = Math.max(1, lines.length);

  for (const block of file.blocks) {
    // A brand-new file arrives as a single whole-file insertion. Treat it as one
    // file-level unit: splitting a file across commits is not what users expect.
    const wholeFile =
      file.status === 'added' &&
      block.startNew <= 1 &&
      block.endOld < block.startOld &&
      block.newLines.length >= total;

    const line = Math.min(Math.max(block.startNew, 1), total);
    const symbol = wholeFile || symbols.length === 0 ? null : findEnclosingSymbol(symbols, line);
    if (symbol) {
      let group = bySymbol.get(symbol.key);
      if (!group) {
        group = { symbol, symbolKey: symbol.key, blocks: [] };
        bySymbol.set(symbol.key, group);
        groups.push(group);
      }
      group.blocks.push(block);
    } else {
      groups.push({ symbol: null, symbolKey: `@${line}`, blocks: [block] });
    }
  }

  // Proximity-cluster the symbol-less groups so unrelated top-level edits that
  // happen to be adjacent become one unit instead of many.
  const symbolLess = groups.filter((g) => g.symbol === null);
  const withSymbol = groups.filter((g) => g.symbol !== null);
  symbolLess.sort((a, b) => firstLine(a) - firstLine(b));

  const clustered: Group[] = [];
  for (const group of symbolLess) {
    const previous = clustered[clustered.length - 1];
    if (previous && firstLine(group) - lastLine(previous) <= PROXIMITY_GAP) {
      previous.blocks.push(...group.blocks);
    } else {
      clustered.push({ symbol: null, symbolKey: `@${firstLine(group)}`, blocks: [...group.blocks] });
    }
  }

  // Final pass: collapse same-file units that are close together (and any
  // import-only unit) so a local rewrite lands as one coherent commit.
  const ordered = [...withSymbol, ...clustered].sort((a, b) => firstLine(a) - firstLine(b));
  const merged: Group[] = [];
  for (const group of ordered) {
    const previous = merged[merged.length - 1];
    const isImport = (g: Group) => g.symbol?.kind === 'import';
    const close =
      previous !== undefined &&
      (isImport(group) ||
        isImport(previous) ||
        firstLine(group) - lastLine(previous) <= SAME_FILE_MERGE_GAP);
    if (previous && close) {
      previous.blocks.push(...group.blocks);
      if (isImport(previous) || isImport(group)) {
        previous.symbol = null;
        previous.symbolKey = `${file.path}#merged`;
      }
    } else {
      merged.push({ symbol: group.symbol, symbolKey: group.symbolKey, blocks: [...group.blocks] });
    }
  }

  return merged;
}

function firstLine(group: Group): number {
  return Math.min(...group.blocks.map((b) => b.startNew));
}

function lastLine(group: Group): number {
  return Math.max(...group.blocks.map((b) => b.startNew + b.newLines.length - 1));
}

const DEF_PATTERNS: Array<{ re: RegExp; kind: string }> = [
  { re: /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/g, kind: 'function' },
  { re: /\bclass\s+([A-Za-z_$][\w$]*)/g, kind: 'class' },
  { re: /\binterface\s+([A-Za-z_$][\w$]*)/g, kind: 'interface' },
  { re: /\benum\s+([A-Za-z_$][\w$]*)/g, kind: 'enum' },
  { re: /\btype\s+([A-Za-z_$][\w$]*)\s*[=<]/g, kind: 'type' },
  { re: /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g, kind: 'variable' },
];

function collectDefines(addedLines: readonly string[]): string[] {
  const names = new Set<string>();
  for (const line of addedLines) {
    for (const { re } of DEF_PATTERNS) {
      re.lastIndex = 0;
      for (const m of line.matchAll(re)) if (m[1]) names.add(m[1]);
    }
  }
  return [...names];
}

function collectReferences(addedLines: readonly string[], defines: readonly string[]): string[] {
  const defined = new Set(defines);
  const refs = new Set<string>();
  for (const line of addedLines) {
    for (const id of extractIdentifiers(line)) {
      if (id.length < 2 || isKeyword(id) || defined.has(id)) continue;
      refs.add(id);
    }
  }
  return [...refs];
}

/** Build change units from snapshotted file changes. */
export function buildUnits(files: readonly FileChange[], mapper: SymbolMapper | null): ChangeUnit[] {
  const units: ChangeUnit[] = [];

  for (const file of files) {
    const language = file.language;
    const canMap = mapper !== null && mapper.supports(language);
    const symbols =
      canMap && !file.binary && file.newContent !== ''
        ? mapper!.map(file.path, file.newContent, language)
        : [];

    const groups: Group[] = file.binary
      ? [{ symbol: null, symbolKey: file.path, blocks: [] as ChangeBlock[] }]
      : file.status === 'deleted'
        ? [{ symbol: null, symbolKey: file.path, blocks: file.blocks }]
        : groupBlocks(file, symbols);

    const fileUnits = mergeOverlaps(
      groups.map((group, index) => toUnit(file, group, index)),
      file,
    );
    units.push(...fileUnits);
  }

  return units;
}

function toUnit(file: FileChange, group: Group, index: number): ChangeUnit {
  const addedLines: string[] = [];
  const removedLines: string[] = [];
  for (const block of group.blocks) {
    addedLines.push(...block.newLines);
  }
  // Removed lines are not available per-block; approximate from the base file.
  const { lines: baseLines } = splitContent(file.baseContent);
  for (const block of group.blocks) {
    if (block.endOld >= block.startOld) {
      for (let i = block.startOld; i <= block.endOld; i += 1) {
        removedLines.push(baseLines[i - 1] ?? '');
      }
    }
  }

  const defines = collectDefines(addedLines);
  const references = collectReferences(addedLines, defines);
  const imports = [...new Set(addedLines.flatMap(extractImportSpecifiers))];

  const id = `${file.path}::${group.symbol ? group.symbol.name : `@${firstLine(group)}`}#${index}`;
  return {
    id,
    file: file.path,
    kind: file.kind,
    symbol: group.symbol,
    symbolKey: group.symbolKey,
    label: group.symbol ? group.symbol.name : basename(file.path),
    blocks: group.blocks,
    deletesFile: file.status === 'deleted',
    addedLines,
    removedLines,
    defines,
    references,
    imports,
    resolvedImports: [],
  };
}

/** Safety net: never let two units claim the same base lines. */
function mergeOverlaps(units: ChangeUnit[], file: FileChange): ChangeUnit[] {
  if (units.length <= 1) return units;
  const sorted = [...units].sort((a, b) => minOld(a) - minOld(b));
  const out: ChangeUnit[] = [];
  for (const unit of sorted) {
    const previous = out[out.length - 1];
    if (previous && rangesOverlap(previous, unit)) {
      previous.blocks.push(...unit.blocks);
      previous.addedLines.push(...unit.addedLines);
      previous.removedLines.push(...unit.removedLines);
      previous.defines = [...new Set([...previous.defines, ...unit.defines])];
      previous.references = [...new Set([...previous.references, ...unit.references])];
      previous.imports = [...new Set([...previous.imports, ...unit.imports])];
      previous.label = `${basename(file.path)}#merged`;
      previous.symbol = null;
      previous.symbolKey = `${file.path}#merged`;
    } else {
      out.push(unit);
    }
  }
  return out;
}

function minOld(unit: ChangeUnit): number {
  return Math.min(...unit.blocks.map((b) => b.startOld), Number.POSITIVE_INFINITY);
}

function maxOld(unit: ChangeUnit): number {
  return Math.max(...unit.blocks.map((b) => b.endOld), -1);
}

function rangesOverlap(a: ChangeUnit, b: ChangeUnit): boolean {
  return minOld(b) <= maxOld(a);
}
