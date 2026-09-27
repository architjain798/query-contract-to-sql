// Join resolution: only the joins that are needed, never fan-out, never a guess.

import { describe, expect, it } from "vitest";
import {
  AmbiguousJoinPathError,
  compileContract,
  NoJoinPathError,
  SemanticModel,
  UnsupportedFeatureError,
} from "../src/index";
import { contract, MODEL, rawModel, refusal, type Json } from "./helpers";

const sql = (model: Json, contractJson: Json) => compileContract(SemanticModel.fromJSON(model), contractJson, "duckdb");

describe("joins", () => {
  it("emits only the joins a query needs", () => {
    const channelOnly = compileContract(MODEL, { metrics: [{ name: "total_revenue" }], group_by: ["channel"] }, "duckdb");
    expect(channelOnly).not.toContain("JOIN"); // channel lives on the fact table
    expect(compileContract(MODEL, contract("a"), "duckdb").match(/LEFT JOIN/g)).toHaveLength(1); // calendar only
  });

  it("makes every join a LEFT JOIN", () => {
    for (const name of ["a", "b", "c"] as const) {
      const text = compileContract(MODEL, contract(name), "duckdb");
      expect(text.match(/ JOIN /g)?.length).toBe(text.match(/LEFT JOIN /g)?.length);
    }
  });

  it("gives the same join when the relationship is declared from the other side", () => {
    const m = rawModel();
    const r = m.relationships[0];
    m.relationships[0] = { from: r.to, from_column: r.to_column, to: r.from, to_column: r.from_column, cardinality: "one_to_many" };
    expect(sql(m, contract("c"))).toBe(compileContract(MODEL, contract("c"), "duckdb"));
  });

  it("follows one_to_one relationships in either direction", () => {
    const forward = rawModel();
    forward.relationships[0].cardinality = "one_to_one";
    expect(sql(forward, contract("c"))).toBe(compileContract(MODEL, contract("c"), "duckdb"));

    const backward = rawModel();
    const r = backward.relationships[0];
    backward.relationships[0] = { from: r.to, from_column: r.to_column, to: r.from, to_column: r.from_column, cardinality: "one_to_one" };
    expect(sql(backward, contract("c"))).toBe(compileContract(MODEL, contract("c"), "duckdb"));
  });

  it("refuses a role-playing dimension as ambiguous", () => {
    // ship_date also leads to dim_calendar. "fiscal year" of which date?
    const m = rawModel();
    m.relationships.push({ from: "fact_sales", from_column: "ship_date", to: "dim_calendar", to_column: "date", cardinality: "many_to_one" });
    const error = refusal(() => sql(m, contract("a")));
    expect(error).toBeInstanceOf(AmbiguousJoinPathError);
    expect(error.path).toBe("filters[0]");
    // ...but a query that never touches dim_calendar is unaffected.
    expect(sql(m, contract("c"))).toContain("dim_store");
  });

  it("orders multi-hop joins parent first", () => {
    const m = rawModel();
    m.datasets.push({ name: "dim_region", grain: "one region" });
    m.relationships.unshift({ from: "dim_store", from_column: "region", to: "dim_region", to_column: "region", cardinality: "many_to_one" });
    m.dimensions.push({ name: "region_manager", model: "dim_region" });
    const joins = sql(m, { metrics: [{ name: "total_revenue" }], group_by: ["region_manager"] })
      .split("\n")
      .filter((line) => line.includes("LEFT JOIN"))
      .map((line) => line.trim());
    expect(joins).toEqual([
      'LEFT JOIN "dim_store" ON "fact_sales"."store_id" = "dim_store"."store_id"',
      'LEFT JOIN "dim_region" ON "dim_store"."region" = "dim_region"."region"',
    ]);
  });

  it("finds no path to an unconnected dataset", () => {
    const m = rawModel();
    m.datasets.push({ name: "dim_weather", grain: "one day" });
    m.dimensions.push({ name: "temperature", model: "dim_weather" });
    const error = refusal(() => sql(m, { metrics: [{ name: "total_revenue" }], group_by: ["temperature"] }));
    expect(error).toBeInstanceOf(NoJoinPathError);
    expect(error.path).toBe("group_by[0]");
  });

  it("never walks a one_to_many direction", () => {
    // Counting stores by channel would need dim_store -> fact_sales, which
    // repeats each store once per sale line. That is fan-out: refused.
    const m = rawModel();
    m.metrics.push({ name: "store_count", agg: "count_distinct", expression: "store_id", model: "dim_store" });
    expect(refusal(() => sql(m, { metrics: [{ name: "store_count" }], group_by: ["channel"] }))).toBeInstanceOf(NoJoinPathError);
  });

  it("refuses metrics from two fact tables", () => {
    const m = rawModel();
    m.datasets.push({ name: "fact_returns", grain: "one returned line" });
    m.metrics.push({ name: "refunds", agg: "sum", expression: "amount", model: "fact_returns" });
    const error = refusal(() => sql(m, { metrics: [{ name: "total_revenue" }, { name: "refunds" }] }));
    expect(error).toBeInstanceOf(UnsupportedFeatureError);
    expect(error.path).toBe("metrics[1].name");
  });
});
