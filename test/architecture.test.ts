// The extension points the README talks about, exercised directly.

import { describe, expect, it } from "vitest";
import { Binder } from "../src/binder";
import { parseContract } from "../src/contract";
import { DEFAULT_DIALECTS, Dialect, InternalCompilerError, QueryCompiler, QueryContractError } from "../src/index";
import { PlanBuilder } from "../src/plan/builder";
import { column, comparison, literal, ref, type Aggregate } from "../src/plan/ir";
import { layoutFor, PeriodComparisonLayout, SingleValueLayout } from "../src/plan/layouts";
import { planQuery } from "../src/plan/planner";
import { DEFAULT_STEPS, type PlanStep } from "../src/plan/steps";
import { SqlRenderer } from "../src/render";
import { contract, MODEL } from "./helpers";

/** A toy dialect for an engine that stores names in upper case. */
class ShoutingDialect extends Dialect {
  readonly name = "shouting";
  override identifier(name: string): string {
    return `"${name.toUpperCase()}"`;
  }
  safeDivide(numerator: string, denominator: string): string {
    return `DIV0(${numerator}, ${denominator})`;
  }
}

describe("extension points", () => {
  it("a new dialect plugs in through the registry, without editing the package", () => {
    const compiler = new QueryCompiler(MODEL, DEFAULT_DIALECTS.with(new ShoutingDialect()));
    const sql = compiler.compile(contract("b"), "shouting");
    expect(sql).toContain('FROM "FACT_SALES"');
    expect(sql).toContain('DIV0("TOTAL_REVENUE_2026" - "TOTAL_REVENUE_2025", "TOTAL_REVENUE_2025")');
    // ...and the default registry is untouched (registries are immutable).
    expect(DEFAULT_DIALECTS.names).toEqual(["duckdb", "postgres"]);
  });

  it("a new feature is one more planning step", () => {
    // A made-up feature: "online sales only". It only has to say what it
    // needs; the builder puts it in the right place.
    class OnlineOnlyStep implements PlanStep {
      apply(_: unknown, plan: PlanBuilder): void {
        plan.filter(comparison("=", column("fact_sales", "channel"), literal("Online")));
      }
    }
    const query = new Binder(MODEL).bind(parseContract(contract("c")));
    const plan = planQuery(query, [...DEFAULT_STEPS, new OnlineOnlyStep()]);
    const sql = new SqlRenderer(DEFAULT_DIALECTS.get("duckdb")).render(plan);
    expect(sql).toContain(`WHERE "fact_sales"."channel" = 'Online'`);
  });

  it("the metric layout is chosen by the contract", () => {
    const bind = (name: "a" | "b") => new Binder(MODEL).bind(parseContract(contract(name)));
    expect(layoutFor(bind("a"))).toBeInstanceOf(SingleValueLayout);
    expect(layoutFor(bind("b"))).toBeInstanceOf(PeriodComparisonLayout);
  });
});

describe("the plan", () => {
  it("is dialect-free data that can be tested without SQL", () => {
    const plan = new QueryCompiler(MODEL).plan(contract("a"));
    expect(JSON.stringify(plan)).not.toMatch(/SELECT|SUM\(|"fact_sales"\."/);
    const onlineRev = plan.aggregated.find((item) => item.name === "online_rev")!.expr as Aggregate;
    expect(onlineRev.kind).toBe("aggregate");
    expect(onlineRev.condition).toEqual(comparison("=", column("fact_sales", "channel"), literal("Online")));
    expect(plan.where).toEqual([comparison("=", column("dim_calendar", "fiscal_year"), literal(2026))]);
  });
});

describe("PlanBuilder refuses an inconsistent plan", () => {
  const builder = () => new PlanBuilder("fact_sales", []);

  it("a column from a table that is not joined", () => {
    const plan = builder().groupBy("region", column("dim_store", "region"));
    expect(() => plan.build()).toThrow(InternalCompilerError);
  });

  it("a result column that refers to a cell stage 1 does not compute", () => {
    const plan = builder().output("total_revenue", ref("total_revnue"));
    expect(() => plan.build()).toThrow(InternalCompilerError);
  });

  it("ordering by something that is not a result column", () => {
    const plan = builder().groupBy("channel", column("fact_sales", "channel")).orderBy(["region"]);
    expect(() => plan.build()).toThrow(InternalCompilerError);
  });

  it("an internal error is never reported as the caller's fault", () => {
    const plan = builder().output("x", ref("missing"));
    let thrown: unknown;
    try {
      plan.build();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(InternalCompilerError);
    expect(thrown).not.toBeInstanceOf(QueryContractError);
  });
});
