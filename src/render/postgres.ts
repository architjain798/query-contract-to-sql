import { Dialect } from "./dialect";

export class PostgresDialect extends Dialect {
  readonly name = "postgres";

  safeDivide(numerator: string, denominator: string): string {
    // Postgres truncates integer division (2 / 3 = 0). COUNT returns an
    // integer, so without the cast pct_change of order_count would come out 0.
    return `CAST(${numerator} AS DOUBLE PRECISION) / NULLIF(${denominator}, 0)`;
  }
}
