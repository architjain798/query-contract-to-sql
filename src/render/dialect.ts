// A dialect decides how things are spelled for one engine, nothing more. The
// renderer owns the shape of the query and only asks the dialect about
// quoting, literals, aggregates and division, so adding a dialect can't
// change what a query means.
//
// safeDivide has no default on purpose: engines disagree about integer
// division (see postgres.ts), so every dialect has to decide.

import type { Scalar } from "../json";
import type { Agg } from "../model/semanticModel";

const AGGREGATES: Record<Agg, (arg: string) => string> = {
  sum: (arg) => `SUM(${arg})`,
  count: (arg) => `COUNT(${arg})`,
  count_distinct: (arg) => `COUNT(DISTINCT ${arg})`,
  avg: (arg) => `AVG(${arg})`,
  min: (arg) => `MIN(${arg})`,
  max: (arg) => `MAX(${arg})`,
};

export abstract class Dialect {
  abstract readonly name: string;

  /** Always quoted, so a column called `date` is fine. */
  identifier(name: string): string {
    return `"${name.replaceAll('"', '""')}"`;
  }

  literal(value: Scalar): string {
    if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
    if (typeof value === "number") return String(value);
    return `'${value.replaceAll("'", "''")}'`;
  }

  /**
   * Conditional aggregates use CASE WHEN. DuckDB and Postgres also support
   * FILTER (WHERE ...), but not every engine does, and the result is the same
   * because aggregates skip the NULLs CASE produces for non-matching rows.
   */
  aggregate(func: Agg, arg: string, condition: string | undefined): string {
    return AGGREGATES[func](condition === undefined ? arg : `CASE WHEN ${condition} THEN ${arg} END`);
  }

  /** numerator / denominator as a real number, NULL when the denominator is 0. */
  abstract safeDivide(numerator: string, denominator: string): string;

  /** Spelled out because engines put NULLs in different places by default. */
  orderKey(sql: string): string {
    return `${sql} ASC NULLS LAST`;
  }
}
