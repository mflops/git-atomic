import type { ChangeUnit, DependencyEdge, DependencyGraph } from '../model/types.js';
import { resolveImportPath } from '../util/paths.js';

const CALL_RE = /([A-Za-z_$][\w$]*)\s*\(/g;

function calledNames(unit: ChangeUnit): Set<string> {
  const out = new Set<string>();
  for (const line of unit.addedLines) {
    for (const m of line.matchAll(CALL_RE)) if (m[1]) out.add(m[1]);
  }
  return out;
}

/**
 * Build the dependency graph that makes ordering meaningful.
 *
 * Edges encode *real* coupling, not file proximity:
 *  - a definition must land before a call site that references it
 *  - a test must land after the module under test it imports
 *  - a manifest must land before its lockfile
 *
 * Extra edges only ever over-constrain ordering (cycles get merged), so the
 * heuristics err on the side of linking rather than missing a dependency.
 */
export function buildDependencyGraph(units: readonly ChangeUnit[]): DependencyGraph {
  const changedFiles = new Set(units.map((u) => u.file));
  const unitsByFile = new Map<string, ChangeUnit[]>();
  for (const unit of units) {
    const list = unitsByFile.get(unit.file) ?? [];
    list.push(unit);
    unitsByFile.set(unit.file, list);
  }

  // Resolve imports to repo paths that are part of this change set.
  for (const unit of units) {
    unit.resolvedImports = [
      ...new Set(
        unit.imports
          .map((spec) => resolveImportPath(spec, unit.file, changedFiles))
          .filter((p): p is string => p !== null),
      ),
    ];
  }

  const defs = new Map<string, ChangeUnit[]>();
  for (const unit of units) {
    for (const name of unit.defines) {
      const list = defs.get(name) ?? [];
      list.push(unit);
      defs.set(name, list);
    }
  }

  const edges: DependencyEdge[] = [];
  const seen = new Set<string>();
  const add = (from: string, to: string, kind: DependencyEdge['kind'], detail?: string) => {
    if (from === to) return;
    const key = `${from}\u0000${to}\u0000${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push(detail === undefined ? { from, to, kind } : { from, to, kind, detail });
  };

  for (const unit of units) {
    const calls = calledNames(unit);
    for (const ref of unit.references) {
      const definitions = defs.get(ref);
      if (!definitions) continue;
      const isCall = calls.has(ref);
      const looksLikeType = /^[A-Z]/.test(ref);
      for (const definition of definitions) {
        if (definition.id === unit.id) continue;
        const sameFile = definition.file === unit.file;
        const importsIt = unit.resolvedImports.includes(definition.file);
        if (isCall || looksLikeType || importsIt || sameFile) {
          add(definition.id, unit.id, 'defines-before-use', ref);
        }
      }
    }

    if (unit.kind === 'test') {
      for (const target of unit.resolvedImports) {
        for (const dependency of unitsByFile.get(target) ?? []) {
          if (dependency.id === unit.id) continue;
          add(dependency.id, unit.id, 'source-before-test', target);
        }
      }
    }
  }

  const manifests = units.filter((u) => u.kind === 'manifest');
  const lockfiles = units.filter((u) => u.kind === 'lockfile');
  for (const manifest of manifests) {
    for (const lockfile of lockfiles) {
      add(manifest.id, lockfile.id, 'manifest-before-lockfile');
    }
  }

  // Within a file, changes land in line order. This keeps an added import
  // ahead of the code that uses it even without a cross-file edge.
  for (const list of unitsByFile.values()) {
    const ordered = [...list].sort((a, b) => firstLineOf(a) - firstLineOf(b));
    for (let i = 1; i < ordered.length; i += 1) {
      add(ordered[i - 1]!.id, ordered[i]!.id, 'same-file');
    }
  }

  return { units: [...units], edges };
}

function firstLineOf(unit: ChangeUnit): number {
  if (unit.blocks.length === 0) return 0;
  return Math.min(...unit.blocks.map((b) => b.startNew));
}
