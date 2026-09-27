// Joins, totals, NULLs and division, on both engines. Several tests add rows the
// take-home data doesn't have, like a sale from a store missing from dim_store.

import { describe, expect, it } from "vitest";
import { compileContract, SemanticModel } from "../src/index";
import { contract, DIALECT_NAMES, MODEL, rawModel, useEngine, type Engine } from "./helpers";

// A sale of 1000 from store S9, which isn't in dim_store.
async function addOrphanSale(engine: Engine): Promise<void> {
  await engine.exec("INSERT INTO fact_sales VALUES ('O-900','2026-02-01','2026-02-03','S9','Online',1000)");
}

const revenue = (filters: unknown[]) => ({ metrics: [{ name: "total_revenue" }], filters });

describe.each(DIALECT_NAMES)("semantics on %s", (dialect) => {
  const engine = useEngine(dialect);

  // ---- joins ---------------------------------------------------------------

  it("attaching a dimension never drops facts", async () => {
    await addOrphanSale(engine());
    const rows = await engine().run({ metrics: [{ name: "total_revenue" }], group_by: ["region"] });
    expect(rows.reduce((sum, r) => sum + (r.total_revenue as number), 0)).toBe(1160 + 1000);
    expect(rows).toContainEqual({ region: null, total_revenue: 1000 }); // kept, under an unknown region
  });

  it("a filter on a dimension field does restrict", async () => {
    await addOrphanSale(engine());
    const rows = await engine().run(revenue([{ field: "region", op: "=", value: "North" }]));
    expect(rows).toEqual([{ total_revenue: 100 + 120 + 80 + 50 }]);
  });

  it("!= excludes facts whose dimension row is missing", async () => {
    // SQL's three-valued logic: NULL <> 'North' is unknown, so the orphan sale
    // is not "not North". A documented choice (see README), pinned here.
    await addOrphanSale(engine());
    const rows = await engine().run(revenue([{ field: "region", op: "!=", value: "North" }]));
    expect(rows).toEqual([{ total_revenue: 1160 - 350 }]);
  });

  it("the unknown-region row is not mistaken for the total", async () => {
    await addOrphanSale(engine());
    const rows = await engine().run(contract("c"));
    const nulls = rows.filter((r) => r.region === null).map((r) => [r.is_total, r.order_count]);
    expect(nulls).toEqual([
      [false, 1], // the orphan's own group
      [true, 9], // the grand total
    ]);
  });

  // ---- totals --------------------------------------------------------------

  it("a grand total with two group columns has no subtotals", async () => {
    const rows = await engine().run({ metrics: [{ name: "order_count" }], group_by: ["region", "channel"], totals: "grand" });
    expect(rows.filter((r) => r.is_total)).toHaveLength(1);
    expect(rows.at(-1)).toEqual({ region: null, channel: null, is_total: true, order_count: 8 });
  });

  it("a grand total without group_by is the single row", async () => {
    const rows = await engine().run({ metrics: [{ name: "total_revenue" }], totals: "grand" });
    expect(rows).toEqual([{ is_total: true, total_revenue: 1160 }]);
  });

  it("non-additive totals (avg, min, max) are recomputed from the base rows", async () => {
    const model = rawModel();
    model.metrics.push(
      { name: "avg_line", agg: "avg", expression: "revenue", model: "fact_sales" },
      { name: "min_line", agg: "min", expression: "revenue", model: "fact_sales" },
      { name: "max_line", agg: "max", expression: "revenue", model: "fact_sales" },
      { name: "line_count", agg: "count", expression: "order_id", model: "fact_sales" },
    );
    const metrics = ["avg_line", "min_line", "max_line", "line_count"].map((name) => ({ name }));
    const rows = await engine().run({ metrics, group_by: ["region"], totals: "grand" }, SemanticModel.fromJSON(model));
    expect(rows.map((r) => [r.region, r.avg_line, r.min_line, r.max_line, r.line_count])).toEqual([
      ["North", 87.5, 50, 120, 4],
      ["South", 190, 70, 300, 3],
      ["West", 120, 90, 150, 2],
      [null, expect.closeTo(1160 / 9, 10), 50, 300, 9],
    ]);
    // The average of the region averages would be 132.5; the real average is 128.9.
    expect(rows.at(-1)!.avg_line).not.toBeCloseTo((87.5 + 190 + 120) / 3);
  });

  it("an additive total equals the sum of the detail rows", async () => {
    const rows = await engine().run({ metrics: [{ name: "total_revenue" }], group_by: ["channel"], totals: "grand" });
    const total = rows.pop()!;
    expect(total.total_revenue).toBe(rows.reduce((sum, r) => sum + (r.total_revenue as number), 0));
  });

  // ---- compare -------------------------------------------------------------

  it("pct_change of a count is not integer-divided", async () => {
    // Orders: 3 in 2025, 5 in 2026, so +66.7%. Without the Postgres cast,
    // bigint / bigint would truncate the total row's pct_change to 0.
    const rows = await engine().run({
      metrics: [{ name: "order_count" }],
      group_by: ["region"],
      compare: { dimension: "fiscal_year", periods: ["2025", "2026"], primary: "2026", outputs: ["values", "pct_change"] },
      totals: "grand",
    });
    const total = rows.at(-1)!;
    expect([total.order_count_2025, total.order_count_2026]).toEqual([3, 5]);
    expect(total.order_count_pct_change).toBeCloseTo(2 / 3, 10);
  });

  it("an empty or zero baseline gives NULL, not a crash", async () => {
    await engine().exec("INSERT INTO dim_store VALUES ('S5','Harbour','East'), ('S6','Airport','Central')");
    await engine().exec(
      "INSERT INTO fact_sales VALUES" +
        " ('O-901','2026-02-01','2026-02-03','S5','Online',50)," + // East: nothing in 2025
        " ('O-902','2025-03-10','2025-03-12','S6','Online',0)," + // Central: 0 in 2025
        " ('O-903','2026-02-01','2026-02-03','S6','Online',40)",
    );
    const rows = await engine().run(contract("b"));
    const byRegion = new Map(rows.filter((r) => !r.is_total).map((r) => [r.region, r]));
    const east = byRegion.get("East")!;
    const central = byRegion.get("Central")!;
    // No 2025 rows is "no data", not zero: the compiler does not invent a 0.
    expect([east.total_revenue_2025, east.total_revenue_delta, east.total_revenue_pct_change]).toEqual([null, null, null]);
    // A real 0 baseline: the delta is known, the percentage is undefined.
    expect([central.total_revenue_delta, central.total_revenue_pct_change]).toEqual([40, null]);
  });

  it("compare outputs control the columns", async () => {
    const b = contract("b");
    b.compare.outputs = ["pct_change"];
    const { columns, rows } = await engine().query(compileContract(MODEL, b, dialect));
    expect(columns).toEqual(["region", "is_total", "total_revenue_pct_change"]);
    expect(rows.at(-1)!.total_revenue_pct_change).toBeCloseTo(260 / 450, 10);
  });

  it("compare combines with per-metric filters", async () => {
    const rows = await engine().run({
      metrics: [{ name: "total_revenue", as: "online", filters: [{ field: "channel", op: "=", value: "Online" }] }],
      compare: { dimension: "fiscal_year", periods: [2025, 2026], primary: 2026, outputs: ["values", "delta"] },
    });
    expect(rows).toEqual([{ online_2025: 250, online_2026: 420, online_delta: 170 }]);
  });

  // ---- filters -------------------------------------------------------------

  it("a metric filter on a joined dimension", async () => {
    const rows = await engine().run({
      metrics: [
        { name: "order_count", as: "north_orders", filters: [{ field: "region", op: "=", value: "North" }] },
        { name: "order_count" },
      ],
      filters: [{ field: "fiscal_year", op: "=", value: 2026 }],
    });
    expect(rows).toEqual([{ north_orders: 3, order_count: 5 }]);
  });

  it.each([
    ["in", ["North", "West"], 100 + 120 + 80 + 50 + 150 + 90],
    ["not_in", ["North", "West"], 200 + 300 + 70],
    ["!=", "North", 200 + 300 + 70 + 150 + 90],
  ])("filter operator %s", async (op, value, expected) => {
    expect(await engine().run(revenue([{ field: "region", op, value }]))).toEqual([{ total_revenue: expected }]);
  });

  it("string values are escaped, not injected", async () => {
    await engine().exec("INSERT INTO dim_store VALUES ('S7','Pier','O''Brien; DROP TABLE fact_sales; --')");
    await engine().exec("INSERT INTO fact_sales VALUES ('O-904','2026-02-01','2026-02-03','S7','Retail',5)");
    const rows = await engine().run(revenue([{ field: "region", op: "=", value: "O'Brien; DROP TABLE fact_sales; --" }]));
    expect(rows).toEqual([{ total_revenue: 5 }]);
  });
});
