// DuckDB and Postgres output should differ only where they have to.

import { describe, expect, it } from "vitest";
import { compileContract } from "../src/index";
import { Dialect } from "../src/render";
import { contract, MODEL } from "./helpers";

describe("dialects", () => {
  it("share everything but division", () => {
    for (const name of ["a", "c"] as const) {
      // no division in these
      expect(compileContract(MODEL, contract(name), "postgres")).toBe(compileContract(MODEL, contract(name), "duckdb"));
    }
    const duck = compileContract(MODEL, contract("b"), "duckdb").split("\n");
    const pg = compileContract(MODEL, contract("b"), "postgres").split("\n");
    expect(duck.length).toBe(pg.length);
    expect(duck.map((line, i) => [line, pg[i]]).filter(([d, p]) => d !== p)).toEqual([
      [
        '  ("total_revenue_2026" - "total_revenue_2025") / NULLIF("total_revenue_2025", 0) AS "total_revenue_pct_change"',
        '  CAST("total_revenue_2026" - "total_revenue_2025" AS DOUBLE PRECISION) / NULLIF("total_revenue_2025", 0) AS "total_revenue_pct_change"',
      ],
    ]);
  });

  it("make a new dialect decide division (checked by the type checker)", () => {
    // `npm test` runs `tsc` first. If `safeDivide` ever stopped being abstract,
    // this directive would be unused and type-checking would fail.
    // @ts-expect-error -- Non-abstract class does not implement inherited abstract member 'safeDivide'
    class Incomplete extends Dialect {
      readonly name = "incomplete";
    }
    expect(new Incomplete().name).toBe("incomplete");
  });
});
