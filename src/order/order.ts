import type { CommitCluster, DependencyGraph } from '../model/types.js';

function primaryFile(cluster: CommitCluster): string {
  return [...cluster.units.map((u) => u.file)].sort()[0] ?? '';
}

/**
 * Kahn topological sort with a deterministic priority tie-break:
 * config/types -> manifest -> implementation -> tests -> docs -> lockfile.
 */
export function orderClusters(
  clusters: readonly CommitCluster[],
  graph: DependencyGraph,
): CommitCluster[] {
  const clusterOf = new Map<string, string>();
  for (const cluster of clusters) {
    for (const unit of cluster.units) clusterOf.set(unit.id, cluster.id);
  }

  const adjacency = new Map<string, Set<string>>();
  const indegree = new Map<string, number>();
  for (const cluster of clusters) {
    adjacency.set(cluster.id, new Set());
    indegree.set(cluster.id, 0);
  }
  for (const edge of graph.edges) {
    const from = clusterOf.get(edge.from);
    const to = clusterOf.get(edge.to);
    if (from === undefined || to === undefined || from === to) continue;
    const targets = adjacency.get(from)!;
    if (targets.has(to)) continue;
    targets.add(to);
    indegree.set(to, (indegree.get(to) ?? 0) + 1);
  }

  const byId = new Map(clusters.map((c) => [c.id, c]));
  const ready = clusters.filter((c) => (indegree.get(c.id) ?? 0) === 0);
  const result: CommitCluster[] = [];

  const compare = (a: CommitCluster, b: CommitCluster): number =>
    a.rank - b.rank ||
    primaryFile(a).localeCompare(primaryFile(b)) ||
    a.id.localeCompare(b.id);

  while (ready.length > 0) {
    ready.sort(compare);
    const next = ready.shift()!;
    result.push(next);
    for (const target of adjacency.get(next.id) ?? []) {
      const remaining = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, remaining);
      if (remaining === 0) {
        const cluster = byId.get(target);
        if (cluster) ready.push(cluster);
      }
    }
  }

  // Cycles are pre-collapsed by clustering, so `result` should hold everything.
  // Append any stragglers defensively to avoid silently dropping commits.
  if (result.length !== clusters.length) {
    const placed = new Set(result.map((c) => c.id));
    for (const cluster of clusters) if (!placed.has(cluster.id)) result.push(cluster);
  }

  return result;
}
