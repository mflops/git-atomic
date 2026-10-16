import { KIND_RANK } from '../util/paths.js';
import type {
  ChangeUnit,
  CommitCluster,
  DependencyGraph,
  UnitKind,
} from '../model/types.js';
import { stronglyConnectedComponents } from '../graph/scc.js';

/** Kinds whose units are always committed together when they share a file. */
const COHESIVE_KINDS = new Set<UnitKind>([
  'config',
  'types',
  'manifest',
  'lockfile',
  'test',
  'docs',
  'other',
]);

interface InternalCluster {
  units: ChangeUnit[];
  fromCycle: boolean;
  reasons: Set<string>;
}

class UnionFind {
  private parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i);
  }

  find(a: number): number {
    let root = a;
    while (this.parent[root] !== root) root = this.parent[root]!;
    while (this.parent[a] !== root) {
      const next = this.parent[a]!;
      this.parent[a] = root;
      a = next;
    }
    return root;
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[rb] = ra;
  }
}

function collapseCycles(clusters: InternalCluster[], graph: DependencyGraph): InternalCluster[] {
  const clusterOf = new Map<string, number>();
  clusters.forEach((cluster, index) => {
    for (const unit of cluster.units) clusterOf.set(unit.id, index);
  });

  const edges: Array<{ from: string; to: string }> = [];
  const seen = new Set<string>();
  for (const edge of graph.edges) {
    const from = clusterOf.get(edge.from);
    const to = clusterOf.get(edge.to);
    if (from === undefined || to === undefined || from === to) continue;
    const key = `${from}\u0000${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ from: String(from), to: String(to) });
  }

  const nodes = clusters.map((_, index) => String(index));
  const components = stronglyConnectedComponents(nodes, edges);

  const merged: InternalCluster[] = [];
  for (const component of components) {
    const indices = component.map(Number);
    if (indices.length === 1) {
      merged.push(clusters[indices[0]!]!);
      continue;
    }
    const units: ChangeUnit[] = [];
    const reasons = new Set<string>(['dependency cycle']);
    for (const index of indices) {
      const cluster = clusters[index]!;
      units.push(...cluster.units);
      for (const reason of cluster.reasons) reasons.add(reason);
    }
    merged.push({ units, fromCycle: true, reasons });
  }
  return merged;
}

/**
 * Partition units into logical commits.
 *
 * 1. Each dependency cycle (SCC) becomes one commit — a cycle cannot be split
 *    into an order that builds.
 * 2. Units in the same cohesive file (tests, docs, config, locks, ...) merge,
 *    because such a file is only meaningful as a whole. Implementation files
 *    keep their per-symbol units so definition/call-site ordering can apply.
 * 3. Any cycle introduced by step 2 is collapsed again.
 */
export function clusterUnits(graph: DependencyGraph): CommitCluster[] {
  const byId = new Map(graph.units.map((unit) => [unit.id, unit]));
  if (graph.units.length === 0) return [];

  const components = stronglyConnectedComponents(
    graph.units.map((u) => u.id),
    graph.edges,
  );

  let clusters: InternalCluster[] = components.map((component) => {
    const units = component.map((id) => byId.get(id)!).filter(Boolean);
    const isCycle = component.length > 1;
    return {
      units,
      fromCycle: isCycle,
      reasons: new Set<string>(isCycle ? ['dependency cycle'] : []),
    };
  });

  // Step 2: transitive closure of file-cohesion merges.
  const uf = new UnionFind(clusters.length);
  const cohesiveByFile = new Map<string, number[]>();
  clusters.forEach((cluster, index) => {
    const files = new Set(cluster.units.map((u) => u.file));
    if (files.size !== 1) return;
    const file = [...files][0]!;
    const kinds = new Set(cluster.units.map((u) => u.kind));
    if ([...kinds].some((k) => !COHESIVE_KINDS.has(k))) return;
    const list = cohesiveByFile.get(file) ?? [];
    list.push(index);
    cohesiveByFile.set(file, list);
  });
  for (const indices of cohesiveByFile.values()) {
    for (let i = 1; i < indices.length; i += 1) uf.union(indices[0]!, indices[i]!);
  }

  const grouped = new Map<number, InternalCluster>();
  clusters.forEach((cluster, index) => {
    const root = uf.find(index);
    const existing = grouped.get(root);
    if (existing) {
      existing.units.push(...cluster.units);
      if (cluster.fromCycle) existing.fromCycle = true;
      for (const reason of cluster.reasons) existing.reasons.add(reason);
    } else {
      grouped.set(root, {
        units: [...cluster.units],
        fromCycle: cluster.fromCycle,
        reasons: new Set(cluster.reasons),
      });
    }
  });
  clusters = [...grouped.values()];

  // Step 3: re-collapse cycles that the merge may have introduced.
  clusters = collapseCycles(clusters, graph);

  return clusters.map((cluster, index) => {
    cluster.units.sort((a, b) => a.file.localeCompare(b.file) || a.label.localeCompare(b.label));
    const rank = Math.min(...cluster.units.map((u) => KIND_RANK[u.kind]));
    return {
      id: `c${index + 1}`,
      units: cluster.units,
      rank,
      fromCycle: cluster.fromCycle,
      reason: cluster.reasons.size > 0 ? [...cluster.reasons].join('; ') : defaultReason(cluster),
    };
  });
}

function defaultReason(cluster: InternalCluster): string {
  if (cluster.units.length === 1) return 'single change unit';
  const files = new Set(cluster.units.map((u) => u.file));
  if (files.size === 1) return 'cohesive file';
  return 'coupled changes';
}
