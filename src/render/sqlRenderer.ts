// Render step: QueryPlan -> SQL text. The layout is fixed (a WITH query
// for stage 1, a SELECT over it for stage 2); spelling comes from the dialect.

import { unreachable, type Expr, type QueryPlan, type SelectItem } from "../plan/ir";
import type { Dialect } from "./dialect";

const STAGE_1 = "aggregated";

const OPERATORS = { "=": "=", "!=": "<>", "<": "<", "<=": "<=", ">": ">", ">=": ">=" } as const;

export class SqlRenderer {
  constructor(private readonly dialect: Dialect) {}

  render(plan: QueryPlan): string {
    const q = (name: string) => this.dialect.identifier(name);
    const lines = [`WITH ${q(STAGE_1)} AS (`, "  SELECT", this.selectList(plan.aggregated, "    ")];
    lines.push(`  FROM ${q(plan.base)}`);
    for (const j of plan.joins) {
      lines.push(
        `  LEFT JOIN ${q(j.toDataset)} ON ${q(j.fromDataset)}.${q(j.fromColumn)} = ${q(j.toDataset)}.${q(j.toColumn)}`,
      );
    }
    if (plan.where.length > 0) {
      lines.push("  WHERE " + plan.where.map((p) => this.expr(p)).join("\n    AND "));
    }
    if (plan.groupBy.length > 0) {
      const columns = plan.groupBy.map((c) => this.expr(c)).join(", ");
      // The empty set () is the grand total, computed by the database from
      // the base rows, so a distinct count is recounted rather than summed.
      // Not ROLLUP: with two columns that would add per-column subtotals too.
      lines.push(plan.grandTotal ? `  GROUP BY GROUPING SETS ((${columns}), ())` : `  GROUP BY ${columns}`);
    }
    lines.push(")", "SELECT", this.selectList(plan.final, "  "), `FROM ${q(STAGE_1)}`);
    if (plan.orderBy.length > 0) {
      lines.push("ORDER BY " + plan.orderBy.map((n) => this.dialect.orderKey(q(n))).join(", "));
    }
    return lines.join("\n");
  }

  private selectList(items: readonly SelectItem[], indent: string): string {
    return items
      .map((item) => {
        const sql = this.expr(item.expr);
        const passThrough = item.expr.kind === "ref" && item.expr.name === item.name;
        return indent + (passThrough ? sql : `${sql} AS ${this.dialect.identifier(item.name)}`);
      })
      .join(",\n");
  }

  private expr(e: Expr): string {
    const d = this.dialect;
    switch (e.kind) {
      case "column":
        return `${d.identifier(e.table)}.${d.identifier(e.name)}`;
      case "literal":
        return d.literal(e.value);
      case "comparison":
        return `${this.expr(e.left)} ${OPERATORS[e.op]} ${this.expr(e.right)}`;
      case "inList":
        return `${this.expr(e.expr)} ${e.negated ? "NOT IN" : "IN"} (${e.values.map((v) => this.expr(v)).join(", ")})`;
      case "and":
        return e.items.map((i) => this.expr(i)).join(" AND ");
      case "aggregate":
        return d.aggregate(e.func, this.expr(e.arg), e.condition === undefined ? undefined : this.expr(e.condition));
      case "isGrandTotal":
        return `GROUPING(${e.columns.map((c) => this.expr(c)).join(", ")}) <> 0`;
      case "ref":
        return d.identifier(e.name);
      case "subtract":
        return `${this.expr(e.left)} - ${this.expr(e.right)}`;
      case "safeDivide":
        return d.safeDivide(this.expr(e.numerator), this.expr(e.denominator));
      default:
        return unreachable(e);
    }
  }
}
