// How one metric turns into columns. Without `compare` it's a single cell.
// With `compare` it's one cell per period plus the derived columns. The
// planner just asks the layout, so a new shape (say, a trend) is a new
// class here rather than an `if` wherever metrics are handled.

import type { BoundCompare, BoundMetric, BoundQuery } from "../binder";
import type { CompareOutput, Period } from "../contract";
import type { PlanBuilder } from "./builder";
import { dimensionColumn, metricAggregate } from "./expressions";
import { comparison, inList, literal, ref, safeDivide, subtract, type Expr } from "./ir";

export interface MetricLayout {
  prepare(plan: PlanBuilder): void;
  addMetric(metric: BoundMetric, plan: PlanBuilder): void;
}

export function layoutFor(query: BoundQuery): MetricLayout {
  return query.compare ? new PeriodComparisonLayout(query.compare) : new SingleValueLayout();
}

export class SingleValueLayout implements MetricLayout {
  prepare(): void {}

  addMetric(metric: BoundMetric, plan: PlanBuilder): void {
    const name = metric.request.outputName;
    plan.measure(name, metricAggregate(metric)).output(name, ref(name));
  }
}

export class PeriodComparisonLayout implements MetricLayout {
  constructor(private readonly compare: BoundCompare) {}

  prepare(plan: PlanBuilder): void {
    // Only rows in one of the periods can count, so don't scan the rest. This
    // also keeps out groups with no data in any compared period.
    plan.filter(inList(dimensionColumn(this.compare.dimension), this.compare.periods.map(literal), false));
  }

  addMetric(metric: BoundMetric, plan: PlanBuilder): void {
    const name = metric.request.outputName;
    for (const period of this.compare.periods) {
      const inPeriod = comparison("=", dimensionColumn(this.compare.dimension), literal(period));
      plan.measure(cellName(name, period), metricAggregate(metric, [inPeriod]));
    }
    for (const output of this.compare.outputs) {
      for (const [columnName, expr] of COMPARE_COLUMNS[output](name, this.compare)) plan.output(columnName, expr);
    }
  }
}

function cellName(metricName: string, period: Period): string {
  return `${metricName}_${period}`;
}

// Typed as a Record so adding an output to COMPARE_OUTPUTS without an entry
// here is a compile error.
const COMPARE_COLUMNS: Record<CompareOutput, (metric: string, compare: BoundCompare) => [string, Expr][]> = {
  values: (metric, compare) => compare.periods.map((p) => [cellName(metric, p), ref(cellName(metric, p))]),
  delta: (metric, compare) => [[`${metric}_delta`, delta(metric, compare)]],
  // A ratio (0.5 = +50%), computed from this row's own cells. On the totals
  // row that means total vs total, never a sum of percentages.
  pct_change: (metric, compare) => [
    [`${metric}_pct_change`, safeDivide(delta(metric, compare), ref(cellName(metric, change(compare).baseline)))],
  ],
};

function delta(metric: string, compare: BoundCompare): Expr {
  const { primary, baseline } = change(compare);
  return subtract(ref(cellName(metric, primary)), ref(cellName(metric, baseline)));
}

function change(compare: BoundCompare): NonNullable<BoundCompare["change"]> {
  // The parser sets `change` whenever delta or pct_change is requested.
  return compare.change!;
}
