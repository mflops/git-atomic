import { describe, expect, it } from 'vitest';
import { clusterUnits } from '../src/cluster/cluster.js';
import { buildDependencyGraph } from '../src/graph/build.js';
import { stronglyConnectedComponents } from '../src/graph/scc.js';
import { orderClusters } from '../src/order/order.js';
import type { ChangeUnit, UnitKind } from '../src/model/types.js';

function unit(
  id: string,
  file: string,
  overrides: Partial<ChangeUnit> = {},
): ChangeUnit {
  const kind: UnitKind = overrides.kind ?? 'implementation';
  return {
    id,
    file,
    kind,
    symbol: null,
    symbolKey: `${file}#${id}`,
    label: id,
    blocks: [{ file, startOld: 1, endOld: 0, startNew: 1, newLines: [''] }],
    deletesFile: false,
    addedLines: [],
    removedLines: [],
    defines: [],
    references: [],
    imports: [],
    resolvedImports: [],
    ...overrides,
  };
}

describe('stronglyConnectedComponents', () => {
  it('finds a simple cycle', () => {
    const components = stronglyConnectedComponents(
      ['a', 'b', 'c'],
      [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
        { from: 'c', to: 'a' },
      ],
    );
    const cyclic = components.find((c) => c.length > 1);
    expect(cyclic?.sort()).toEqual(['a', 'b', 'c']);
  });

  it('leaves a DAG as singletons', () => {
    const components = stronglyConnectedComponents(
      ['a', 'b', 'c'],
      [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
      ],
    );
    expect(components.every((c) => c.length === 1)).toBe(true);
  });
});

describe('buildDependencyGraph', () => {
  it('links a definition to a cross-file call site', () => {
    const a = unit('a', 'src/a.ts', { defines: ['add'], addedLines: ['export function add() {}'] });
    const b = unit('b', 'src/b.ts', {
      addedLines: ['const x = add(1, 2);'],
      references: ['add'],
      imports: ['./a.js'],
    });
    const graph = buildDependencyGraph([a, b]);
    expect(graph.edges).toContainEqual({ from: 'a', to: 'b', kind: 'defines-before-use', detail: 'add' });
    expect(b.resolvedImports).toContain('src/a.ts');
  });

  it('orders source before its tests', () => {
    const a = unit('a', 'src/a.ts', { defines: ['add'], addedLines: ['export function add() {}'] });
    const t = unit('t', 'test/a.test.ts', {
      kind: 'test',
      addedLines: ["import { add } from '../src/a.js';"],
      imports: ['../src/a.js'],
      references: ['add'],
    });
    const graph = buildDependencyGraph([a, t]);
    expect(graph.edges).toContainEqual({ from: 'a', to: 't', kind: 'source-before-test', detail: 'src/a.ts' });
  });

  it('orders manifest before lockfile', () => {
    const manifest = unit('m', 'package.json', { kind: 'manifest' });
    const lock = unit('l', 'package-lock.json', { kind: 'lockfile' });
    const graph = buildDependencyGraph([manifest, lock]);
    expect(graph.edges).toContainEqual({ from: 'm', to: 'l', kind: 'manifest-before-lockfile' });
  });

  it('preserves line order within a file', () => {
    const first = unit('first', 'src/a.ts');
    const second = unit('second', 'src/a.ts');
    second.blocks = [{ file: 'src/a.ts', startOld: 20, endOld: 19, startNew: 21, newLines: ['x'] }];
    const graph = buildDependencyGraph([second, first]);
    expect(graph.edges).toContainEqual({ from: 'first', to: 'second', kind: 'same-file' });
  });
});

describe('clusterUnits', () => {
  it('merges a dependency cycle into one cluster', () => {
    const a = unit('a', 'src/a.ts', {
      defines: ['x'],
      references: ['y'],
      addedLines: ['export function x() { return y(); }'],
      imports: ['./b.js'],
    });
    const b = unit('b', 'src/b.ts', {
      defines: ['y'],
      references: ['x'],
      addedLines: ['export function y() { return x(); }'],
      imports: ['./a.js'],
    });
    const graph = buildDependencyGraph([a, b]);
    const clusters = clusterUnits(graph);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.fromCycle).toBe(true);
    expect(clusters[0]?.units).toHaveLength(2);
  });

  it('merges cohesive units of the same test file', () => {
    const t1 = unit('t1', 'test/a.test.ts', { kind: 'test', blocks: [{ file: 'test/a.test.ts', startOld: 1, endOld: 0, startNew: 1, newLines: ['a'] }] });
    const t2 = unit('t2', 'test/a.test.ts', { kind: 'test', blocks: [{ file: 'test/a.test.ts', startOld: 30, endOld: 29, startNew: 31, newLines: ['b'] }] });
    const clusters = clusterUnits(buildDependencyGraph([t1, t2]));
    expect(clusters).toHaveLength(1);
  });

  it('keeps independent implementation units separate', () => {
    const a = unit('a', 'src/a.ts');
    const b = unit('b', 'src/b.ts');
    const clusters = clusterUnits(buildDependencyGraph([a, b]));
    expect(clusters).toHaveLength(2);
  });
});

describe('orderClusters', () => {
  it('places definitions before uses and lockfiles last', () => {
    const impl = unit('impl', 'src/a.ts', { defines: ['add'], addedLines: ['export function add() {}'] });
    const use = unit('use', 'src/b.ts', {
      references: ['add'],
      addedLines: ['add()'],
      imports: ['./a.js'],
    });
    const lock = unit('lock', 'package-lock.json', { kind: 'lockfile' });
    const manifest = unit('manifest', 'package.json', { kind: 'manifest' });

    const graph = buildDependencyGraph([use, lock, impl, manifest]);
    const ordered = orderClusters(clusterUnits(graph), graph);
    const ids = ordered.flatMap((c) => c.units.map((u) => u.id));
    expect(ids.indexOf('impl')).toBeLessThan(ids.indexOf('use'));
    expect(ids.indexOf('manifest')).toBeLessThan(ids.indexOf('lock'));
    expect(ids.indexOf('impl')).toBeLessThan(ids.indexOf('lock'));
  });
});
