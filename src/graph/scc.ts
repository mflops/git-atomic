import type { DependencyEdge } from '../model/types.js';

/**
 * Iterative Tarjan SCC. Returns one component per node, with multi-node
 * components (and self-loops) representing dependency cycles.
 */
export function stronglyConnectedComponents(
  nodes: readonly string[],
  edges: readonly Pick<DependencyEdge, 'from' | 'to'>[],
): string[][] {
  const adjacency = new Map<string, string[]>();
  for (const node of nodes) adjacency.set(node, []);
  for (const edge of edges) {
    adjacency.get(edge.from)?.push(edge.to);
  }

  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  const work: Array<{ v: string; i: number }> = [];

  for (const start of nodes) {
    if (index.has(start)) continue;
    work.push({ v: start, i: 0 });

    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const v = frame.v;

      if (frame.i === 0) {
        index.set(v, counter);
        low.set(v, counter);
        counter += 1;
        stack.push(v);
        onStack.add(v);
      }

      const neighbors = adjacency.get(v) ?? [];
      let descended = false;
      while (frame.i < neighbors.length) {
        const w = neighbors[frame.i]!;
        frame.i += 1;
        if (!index.has(w)) {
          work.push({ v: w, i: 0 });
          descended = true;
          break;
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v)!, index.get(w)!));
        }
      }
      if (descended) continue;

      if (low.get(v) === index.get(v)) {
        const component: string[] = [];
        for (;;) {
          const w = stack.pop()!;
          onStack.delete(w);
          component.push(w);
          if (w === v) break;
        }
        components.push(component);
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.v, Math.min(low.get(parent.v)!, low.get(v)!));
    }
  }

  return components;
}
