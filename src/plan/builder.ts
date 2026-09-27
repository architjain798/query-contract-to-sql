// Planning steps describe what they want ("group by this", "add this cell")
// and the builder puts it in the right place in the two-stage plan. build()
// checks the result before anything is rendered: duplicate column names are
// the caller's problem, anything else inconsistent is a compiler bug.

import { DuplicateOutputError, InternalCompilerError } from "../errors";
import { show } from "../json";
import type { JoinEdge } from "../model/joinGraph";
import { forEachNode, ref, type Column, type Expr, type QueryPlan, type SelectItem } from "./ir";

export class PlanBuilder {
  private readonly groupColumns: Column[] = [];
  /** Columns that identify a row (group columns, is_total). They appear in both stages. */
  private readonly rowKeys: SelectItem[] = [];
  private readonly predicates: Expr[] = [];
  private readonly measures: SelectItem[] = [];
  private readonly outputs: SelectItem[] = [];
  private grandTotal = false;
  private sortKeys: readonly string[] = [];

  constructor(
    private readonly base: string,
    private readonly joins: readonly JoinEdge[],
  ) {}

  get groupedColumns(): readonly Column[] {
    return this.groupColumns;
  }

  groupBy(name: string, column: Column): this {
    this.groupColumns.push(column);
    this.rowKeys.push({ expr: column, name });
    return this;
  }

  rowKey(name: string, expr: Expr): this {
    this.rowKeys.push({ expr, name });
    return this;
  }

  filter(predicate: Expr): this {
    this.predicates.push(predicate);
    return this;
  }

  withGrandTotal(): this {
    this.grandTotal = true;
    return this;
  }

  /** A stage 1 value cell. Only shown if an output refers to it. */
  measure(name: string, expr: Expr): this {
    this.measures.push({ expr, name });
    return this;
  }

  /** A result column, computed from stage 1 cells. */
  output(name: string, expr: Expr): this {
    this.outputs.push({ expr, name });
    return this;
  }

  orderBy(names: readonly string[]): this {
    this.sortKeys = names;
    return this;
  }

  build(): QueryPlan {
    const aggregated = [...this.rowKeys, ...this.measures];
    const final = [...this.rowKeys.map((k) => ({ expr: ref(k.name), name: k.name })), ...this.outputs];
    assertUniqueNames(aggregated);
    assertUniqueNames(final);
    this.assertConsistent(aggregated, final);
    return {
      base: this.base,
      joins: this.joins,
      where: this.predicates,
      groupBy: this.groupColumns,
      grandTotal: this.grandTotal,
      aggregated,
      final,
      orderBy: this.sortKeys,
    };
  }

  private assertConsistent(aggregated: readonly SelectItem[], final: readonly SelectItem[]): void {
    const tables = new Set([this.base, ...this.joins.map((j) => j.toDataset)]);
    const checkStage1 = (node: Expr) => {
      if (node.kind === "column" && !tables.has(node.table)) {
        throw new InternalCompilerError(`plan uses ${node.table}.${node.name}, but ${show(node.table)} is not joined`);
      }
      if (node.kind === "ref") throw new InternalCompilerError(`stage 1 cannot reference ${show(node.name)} by name`);
    };
    for (const e of [...this.predicates, ...aggregated.map((i) => i.expr)]) forEachNode(e, checkStage1);

    const stage1Names = new Set(aggregated.map((i) => i.name));
    const checkStage2 = (node: Expr) => {
      if (node.kind === "ref" && !stage1Names.has(node.name)) {
        throw new InternalCompilerError(`result refers to ${show(node.name)}, which stage 1 does not compute`);
      }
      if (node.kind === "column") throw new InternalCompilerError("stage 2 can only use stage 1 columns");
    };
    for (const item of final) forEachNode(item.expr, checkStage2);

    const resultNames = new Set(final.map((i) => i.name));
    for (const name of this.sortKeys) {
      if (!resultNames.has(name)) throw new InternalCompilerError(`cannot order by ${show(name)}: not a result column`);
    }
  }
}

function assertUniqueNames(items: readonly SelectItem[]): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.name)) {
      throw new DuplicateOutputError(
        `two output columns would both be named ${show(item.name)}; give one metric an \`as\` alias`,
        "metrics",
      );
    }
    seen.add(item.name);
  }
}
