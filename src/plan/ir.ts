// The query plan: what to compute, with no SQL text in it. Every plan has
// the same two stages:
//
//   aggregated (stage 1)  join, filter, group and aggregate the fact rows.
//                         The grand total comes from GROUPING SETS, so the
//                         database computes it from the base rows.
//   final (stage 2)       arithmetic within a row (delta, pct_change). The
//                         totals row rebuilds its ratios from its own cells.

import type { ComparisonOp } from "../contract";
import type { Scalar } from "../json";
import type { JoinEdge } from "../model/joinGraph";
import type { Agg } from "../model/semanticModel";

export interface Column {
  readonly kind: "column";
  readonly table: string;
  readonly name: string;
}

export interface Literal {
  readonly kind: "literal";
  readonly value: Scalar;
}

export interface Comparison {
  readonly kind: "comparison";
  readonly op: ComparisonOp;
  readonly left: Expr;
  readonly right: Expr;
}

export interface InList {
  readonly kind: "inList";
  readonly expr: Expr;
  readonly values: readonly Literal[];
  readonly negated: boolean;
}

export interface And {
  readonly kind: "and";
  readonly items: readonly Expr[];
}

/** AGG(arg) over the rows where `condition` holds. Other rows stay in the query for other aggregates. */
export interface Aggregate {
  readonly kind: "aggregate";
  readonly func: Agg;
  readonly arg: Expr;
  readonly condition: Expr | undefined;
}

/** True on the grand-total row. Not `region IS NULL`: an unknown store has a NULL region too. */
export interface IsGrandTotal {
  readonly kind: "isGrandTotal";
  readonly columns: readonly Column[];
}

/** A stage 1 column, referenced by name from stage 2. */
export interface Ref {
  readonly kind: "ref";
  readonly name: string;
}

export interface Subtract {
  readonly kind: "subtract";
  readonly left: Expr;
  readonly right: Expr;
}

/** Real-number division; NULL when the denominator is 0. */
export interface SafeDivide {
  readonly kind: "safeDivide";
  readonly numerator: Expr;
  readonly denominator: Expr;
}

export type Expr = Column | Literal | Comparison | InList | And | Aggregate | IsGrandTotal | Ref | Subtract | SafeDivide;

export const column = (table: string, name: string): Column => ({ kind: "column", table, name });
export const literal = (value: Scalar): Literal => ({ kind: "literal", value });
export const comparison = (op: ComparisonOp, left: Expr, right: Expr): Comparison => ({ kind: "comparison", op, left, right });
export const inList = (expr: Expr, values: readonly Literal[], negated: boolean): InList => ({ kind: "inList", expr, values, negated });
export const and = (items: readonly Expr[]): And => ({ kind: "and", items });
export const aggregate = (func: Agg, arg: Expr, condition: Expr | undefined): Aggregate => ({ kind: "aggregate", func, arg, condition });
export const isGrandTotal = (columns: readonly Column[]): IsGrandTotal => ({ kind: "isGrandTotal", columns });
export const ref = (name: string): Ref => ({ kind: "ref", name });
export const subtract = (left: Expr, right: Expr): Subtract => ({ kind: "subtract", left, right });
export const safeDivide = (numerator: Expr, denominator: Expr): SafeDivide => ({ kind: "safeDivide", numerator, denominator });

function children(e: Expr): readonly Expr[] {
  switch (e.kind) {
    case "column":
    case "literal":
    case "ref":
      return [];
    case "comparison":
    case "subtract":
      return [e.left, e.right];
    case "inList":
      return [e.expr, ...e.values];
    case "and":
      return e.items;
    case "aggregate":
      return e.condition === undefined ? [e.arg] : [e.arg, e.condition];
    case "isGrandTotal":
      return e.columns;
    case "safeDivide":
      return [e.numerator, e.denominator];
    default:
      return unreachable(e);
  }
}

export function forEachNode(e: Expr, visit: (node: Expr) => void): void {
  visit(e);
  for (const child of children(e)) forEachNode(child, visit);
}

/** Put this in the default branch of a switch over Expr: it stops compiling if a kind is missed. */
export function unreachable(e: never): never {
  throw new TypeError(`unhandled plan node ${JSON.stringify(e)}`);
}

export interface SelectItem {
  readonly expr: Expr;
  readonly name: string;
}

export interface QueryPlan {
  readonly base: string;
  readonly joins: readonly JoinEdge[];
  /** ANDed together. */
  readonly where: readonly Expr[];
  readonly groupBy: readonly Column[];
  readonly grandTotal: boolean;
  readonly aggregated: readonly SelectItem[];
  readonly final: readonly SelectItem[];
  readonly orderBy: readonly string[];
}
