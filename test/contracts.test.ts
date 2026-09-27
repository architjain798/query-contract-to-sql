// Contracts A, B and C from the brief, with the expected results, on both engines.

import { describe, expect, it } from "vitest";
import { contract, DIALECT_NAMES, useEngine } from "./helpers";

describe.each(DIALECT_NAMES)("take-home contracts on %s", (dialect) => {
  const engine = useEngine(dialect);

  it("A: two readings of one metric", async () => {
    // Online revenue must not filter out the Retail rows that total_revenue needs.
    expect(await engine().run(contract("a"))).toEqual([{ online_rev: 420, total_revenue: 710 }]);
  });

  it("B: compare with derived columns and a grand total", async () => {
    const rows = await engine().run(contract("b"));
    expect(rows.map((r) => r.region)).toEqual(["North", "South", "West", null]);
    expect(rows.map((r) => r.is_total)).toEqual([false, false, false, true]);
    expect(rows.map((r) => [r.total_revenue_2025, r.total_revenue_2026, r.total_revenue_delta])).toEqual([
      [100, 250, 150],
      [200, 370, 170],
      [150, 90, -60],
      [450, 710, 260],
    ]);
    expect(rows.map((r) => r.total_revenue_pct_change)).toEqual(
      [1.5, 0.85, -0.4, 260 / 450].map((v) => expect.closeTo(v, 10)),
    );
  });

  it("B: the total's pct_change is rebuilt from its own cells", async () => {
    const rows = await engine().run(contract("b"));
    const pcts = rows.map((r) => r.total_revenue_pct_change as number);
    const total = pcts.pop()!;
    const sum = pcts.reduce((a, b) => a + b, 0);
    expect(Math.round(total * 1000) / 10).toBe(57.8);
    expect(total).not.toBeCloseTo(sum); // 195%
    expect(total).not.toBeCloseTo(sum / pcts.length); // 65%
  });

  it("C: a distinct count's total is recounted, not summed", async () => {
    const rows = await engine().run(contract("c"));
    expect(rows.map((r) => [r.region, r.is_total, r.order_count])).toEqual([
      ["North", false, 4],
      ["South", false, 3],
      ["West", false, 2],
      [null, true, 8], // not 4 + 3 + 2 = 9: O-203 has lines in North and South
    ]);
  });
});
