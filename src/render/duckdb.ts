import { Dialect } from "./dialect";

export class DuckDBDialect extends Dialect {
  readonly name = "duckdb";

  safeDivide(numerator: string, denominator: string): string {
    // In DuckDB `/` is always floating-point division, even for two integers.
    return `(${numerator}) / NULLIF(${denominator}, 0)`;
  }
}
