import type { ChangeUnit, CommitCluster, CommitMessage, UnitKind } from '../model/types.js';
import { basename, stripExt } from '../util/paths.js';

const KIND_TYPE: Record<UnitKind, string> = {
  config: 'build',
  types: 'types',
  manifest: 'build',
  implementation: 'refactor',
  other: 'chore',
  test: 'test',
  docs: 'docs',
  lockfile: 'build',
};

/** Tie-break order when several kinds appear equally often in a cluster. */
const KIND_PRIORITY: UnitKind[] = [
  'implementation',
  'test',
  'types',
  'config',
  'manifest',
  'docs',
  'other',
  'lockfile',
];

function dominantKind(units: readonly ChangeUnit[]): UnitKind {
  const counts = new Map<UnitKind, number>();
  for (const unit of units) counts.set(unit.kind, (counts.get(unit.kind) ?? 0) + 1);
  const priority = (kind: UnitKind): number => KIND_PRIORITY.indexOf(kind);
  return [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || priority(a[0]) - priority(b[0]),
  )[0]![0];
}

function pickRepresentative(units: readonly ChangeUnit[]): ChangeUnit {
  const score = (unit: ChangeUnit): number => {
    let value = 0;
    if (unit.kind === 'implementation') value += 100;
    if (unit.defines.length > 0) value += 20;
    value += unit.addedLines.length;
    return value;
  };
  return [...units].sort(
    (a, b) => score(b) - score(a) || a.file.localeCompare(b.file) || a.label.localeCompare(b.label),
  )[0]!;
}

function unitNames(unit: ChangeUnit): string[] {
  if (unit.defines.length > 0) return unit.defines;
  return unit.symbol ? [unit.symbol.name] : [];
}

function scopeFor(units: readonly ChangeUnit[], representative: ChangeUnit): string | null {
  const base = stripExt(basename(representative.file)).replace(/\.(test|spec)$/, '');
  if (base) return base;
  const file = units[0]?.file;
  return file ? stripExt(basename(file)) : null;
}

function summarize(names: string[], fallback: string): string {
  const unique = [...new Set(names)].filter(Boolean);
  if (unique.length === 0) return fallback;
  if (unique.length <= 3) return unique.join(', ');
  return `${unique.slice(0, 3).join(', ')} +${unique.length - 3} more`;
}

function fileListBody(units: readonly ChangeUnit[], reason: string): string {
  const byFile = new Map<string, ChangeUnit[]>();
  for (const unit of units) {
    const list = byFile.get(unit.file) ?? [];
    list.push(unit);
    byFile.set(unit.file, list);
  }
  const lines: string[] = [reason];
  const added = units.reduce((n, u) => n + u.addedLines.length, 0);
  const removed = units.reduce((n, u) => n + u.removedLines.length, 0);
  lines.push(`${byFile.size} file(s), +${added}/-${removed}`);
  lines.push('');
  for (const [file, fileUnits] of [...byFile.entries()].sort()) {
    const labels = fileUnits.filter((u) => u.symbol).map((u) => u.label);
    lines.push(labels.length > 0 ? `- ${file} (${summarize(labels, '')})` : `- ${file}`);
  }
  return lines.join('\n');
}

/**
 * Deterministic, offline commit message generator (conventional commits).
 * An LLM can be layered on top later; this is always the fallback and the
 * default so the tool works with no network at all.
 */
export function generateMessage(cluster: CommitCluster): CommitMessage {
  const units = cluster.units;
  const kind = dominantKind(units);
  const representative = pickRepresentative(units);
  const scoped = kind === 'implementation' || kind === 'types' || kind === 'test';
  const scope = scoped ? scopeFor(units, representative) : null;

  const newDefs = [...new Set(units.flatMap(unitNames))];
  const added = units.reduce((n, u) => n + u.addedLines.length, 0);
  const removed = units.reduce((n, u) => n + u.removedLines.length, 0);
  const allDeleted = units.every((u) => u.deletesFile);

  let type: string;
  let subject: string;

  if (allDeleted) {
    type = 'chore';
    subject = `remove ${summarize(newDefs, basename(representative.file))}`;
  } else if (kind === 'test') {
    type = 'test';
    const targets = units.flatMap((u) =>
      u.resolvedImports.map((p) => stripExt(basename(p))),
    );
    subject = `add tests for ${summarize(targets.length > 0 ? targets : newDefs, scope ?? 'module')}`;
  } else if (kind === 'docs') {
    type = 'docs';
    subject = `update ${summarize(newDefs, basename(representative.file))}`;
  } else if (kind === 'manifest' || kind === 'lockfile') {
    type = 'build';
    subject = 'update dependencies';
  } else if (kind === 'config') {
    type = 'build';
    subject = `update ${summarize(newDefs, basename(representative.file))}`;
  } else if (kind === 'types') {
    type = newDefs.length > 0 ? 'types' : 'refactor';
    subject = `${newDefs.length > 0 ? 'add' : 'update'} ${summarize(newDefs, scope ?? 'types')}`;
  } else if (kind === 'implementation') {
    if (newDefs.length > 0 && added >= removed) {
      type = 'feat';
      subject = `add ${summarize(newDefs, scope ?? 'feature')}`;
    } else if (removed > added) {
      type = 'refactor';
      subject = `simplify ${summarize(newDefs, scope ?? 'module')}`;
    } else {
      type = KIND_TYPE.implementation;
      subject = `update ${summarize(newDefs, scope ?? 'module')}`;
    }
  } else {
    type = KIND_TYPE[kind];
    subject = `update ${summarize(newDefs, basename(representative.file))}`;
  }

  const header = scope ? `${type}(${scope}): ${subject}` : `${type}: ${subject}`;
  const body = fileListBody(units, cluster.reason);
  return { subject: header, body, type, scope };
}
