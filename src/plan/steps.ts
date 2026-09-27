// One planning step per contract feature. Each reads its part of the bound
// query and tells the builder what it needs; none of them calls another.
// Adding a feature like `having` means adding a step to DEFAULT_STEPS.

import type { BoundQuery } from "../binder";
import type { PlanBuilder } from "./builder";
import { dimensionColumn, predicate } from "./expressions";
import { isGrandTotal, literal } from "./ir";
import { layoutFor } from "./layouts";

const IS_TOTAL = "is_total";

export interface PlanStep {
  apply(query: BoundQuery, plan: PlanBuilder): void;
}

export class GroupByStep implements PlanStep {
  apply(query: BoundQuery, plan: PlanBuilder): void {
    for (const dim of query.groupBy) plan.groupBy(dim.name, dimensionColumn(dim));
  }
}

export class QueryFilterStep implements PlanStep {
  apply(query: BoundQuery, plan: PlanBuilder): void {
    for (const f of query.filters) plan.filter(predicate(f));
  }
}

export class GrandTotalStep implements PlanStep {
  apply(query: BoundQuery, plan: PlanBuilder): void {
    if (!query.grandTotal) return;
    const columns = plan.groupedColumns;
    // Without a group_by the single result row is already the grand total.
    plan.rowKey(IS_TOTAL, columns.length > 0 ? isGrandTotal(columns) : literal(true)).withGrandTotal();
  }
}

export class MetricColumnsStep implements PlanStep {
  apply(query: BoundQuery, plan: PlanBuilder): void {
    const layout = layoutFor(query);
    layout.prepare(plan);
    for (const metric of query.metrics) layout.addMetric(metric, plan);
  }
}

/** Detail rows first, then the total; within those, by the group columns. */
export class DefaultOrderStep implements PlanStep {
  apply(query: BoundQuery, plan: PlanBuilder): void {
    if (query.groupBy.length === 0) return;
    plan.orderBy([...(query.grandTotal ? [IS_TOTAL] : []), ...query.groupBy.map((d) => d.name)]);
  }
}

// Order matters: GrandTotalStep reads the group columns GroupByStep added,
// and query filters come before the compare period filter in WHERE.
export const DEFAULT_STEPS: readonly PlanStep[] = [
  new GroupByStep(),
  new QueryFilterStep(),
  new GrandTotalStep(),
  new MetricColumnsStep(),
  new DefaultOrderStep(),
];
