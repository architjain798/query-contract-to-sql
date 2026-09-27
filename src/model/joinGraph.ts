// Which tables can be joined to which without duplicating fact rows.
//
// Only the many -> one direction of a relationship becomes an edge. Walking
// one -> many would repeat each fact row once per match and inflate every
// SUM, so there's simply no edge for it. resolve() takes the shortest path
// and refuses when there's none, or when two paths are equally short (e.g.
// order_date and ship_date both leading to dim_calendar), because picking
// one would be a guess.

import { AmbiguousJoinPathError, NoJoinPathError } from "../errors";
import { show } from "../json";

export const CARDINALITIES = ["many_to_one", "one_to_one", "one_to_many"] as const;
type Cardinality = (typeof CARDINALITIES)[number];

export interface Relationship {
  readonly fromDataset: string;
  readonly fromColumn: string;
  readonly toDataset: string;
  readonly toColumn: string;
  readonly cardinality: Cardinality;
}

/** LEFT JOIN toDataset ON fromDataset.fromColumn = toDataset.toColumn */
export interface JoinEdge {
  readonly fromDataset: string;
  readonly fromColumn: string;
  readonly toDataset: string;
  readonly toColumn: string;
}

/** A table the query needs, and the contract field that needs it (for errors). */
export interface JoinNeed {
  readonly dataset: string;
  readonly path: string;
}

interface Reached {
  via: JoinEdge | undefined;
  distance: number;
  pathCount: number;
}

export class JoinGraph {
  private constructor(private readonly edges: ReadonlyMap<string, readonly JoinEdge[]>) {}

  static build(datasets: Iterable<string>, relationships: readonly Relationship[]): JoinGraph {
    const edges = new Map<string, JoinEdge[]>([...datasets].map((name) => [name, []]));
    for (const rel of relationships) {
      const forward = { fromDataset: rel.fromDataset, fromColumn: rel.fromColumn, toDataset: rel.toDataset, toColumn: rel.toColumn };
      const backward = { fromDataset: rel.toDataset, fromColumn: rel.toColumn, toDataset: rel.fromDataset, toColumn: rel.fromColumn };
      if (rel.cardinality !== "one_to_many") edges.get(rel.fromDataset)!.push(forward);
      if (rel.cardinality !== "many_to_one") edges.get(rel.toDataset)!.push(backward);
    }
    return new JoinGraph(edges);
  }

  /** The joins needed to reach every dataset in `needs` from `base`, parents first. */
  resolve(base: string, needs: readonly JoinNeed[]): readonly JoinEdge[] {
    const reachable = this.breadthFirst(base);
    const chosen = new Map<string, JoinEdge>();
    for (const { dataset, path } of needs) {
      const reached = reachable.get(dataset);
      if (!reached) {
        throw new NoJoinPathError(
          `no join path from ${show(base)} to ${show(dataset)} ` +
            "(only many_to_one relationships are followed, so fact rows are never duplicated)",
          path,
        );
      }
      if (reached.pathCount > 1) {
        throw new AmbiguousJoinPathError(
          `${show(dataset)} can be reached from ${show(base)} in ${reached.pathCount} equally short ways; ` +
            "the semantic model must make the path unambiguous",
          path,
        );
      }
      for (let edge = reached.via; edge !== undefined; edge = reachable.get(edge.fromDataset)!.via) {
        chosen.set(edge.toDataset, edge);
      }
    }
    // Map order is discovery order, so a table always comes after the one it hangs off.
    const order = [...reachable.keys()];
    return [...chosen.values()].sort((a, b) => order.indexOf(a.toDataset) - order.indexOf(b.toDataset));
  }

  /** BFS from base, counting how many shortest paths reach each dataset. */
  private breadthFirst(base: string): Map<string, Reached> {
    const found = new Map<string, Reached>([[base, { via: undefined, distance: 0, pathCount: 1 }]]);
    const queue = [base];
    for (let head = 0; head < queue.length; head++) {
      const current = found.get(queue[head]!)!;
      for (const edge of this.edges.get(queue[head]!) ?? []) {
        const next = found.get(edge.toDataset);
        if (next === undefined) {
          found.set(edge.toDataset, { via: edge, distance: current.distance + 1, pathCount: current.pathCount });
          queue.push(edge.toDataset);
        } else if (next.distance === current.distance + 1) {
          next.pathCount += current.pathCount;
        }
      }
    }
    return found;
  }
}
