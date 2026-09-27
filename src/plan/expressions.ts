import type { BoundFilter, BoundMetric } from "../binder";
import type { Dimension } from "../model/semanticModel";
import { aggregate, and, column, comparison, inList, literal, type Aggregate, type Column, type Expr } from "./ir";

export function dimensionColumn(dim: Dimension): Column {
  return column(dim.model, dim.column);
}

export function predicate({ filter, dimension }: BoundFilter): Expr {
  const col = dimensionColumn(dimension);
  if (filter.kind === "list") return inList(col, filter.values.map(literal), filter.op === "not_in");
  return comparison(filter.op, col, literal(filter.value));
}

/**
 * The metric's aggregate, restricted by its own filters plus `extra`
 * conditions (e.g. a compare period). These go inside the aggregate, not in
 * WHERE, so they can't remove rows another metric in the same query needs.
 */
export function metricAggregate(m: BoundMetric, extra: readonly Expr[] = []): Aggregate {
  const conditions = [...extra, ...m.filters.map(predicate)];
  const condition = conditions.length === 0 ? undefined : conditions.length === 1 ? conditions[0] : and(conditions);
  return aggregate(m.metric.agg, column(m.metric.model, m.metric.column), condition);
}
