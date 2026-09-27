// Each case breaks a good contract in one way and checks the error class and the path it reports.

import { describe, expect, it } from "vitest";
import {
  compileContract,
  DuplicateOutputError,
  InvalidContractError,
  QueryContractError,
  UnknownDimensionError,
  UnknownMetricError,
  UnsupportedDialectError,
  UnsupportedFeatureError,
  UnsupportedOperatorError,
} from "../src/index";
import { contract, MODEL, refusal, type ContractName, type Json } from "./helpers";

type ErrorType = abstract new (...args: never[]) => QueryContractError;

function changed(name: ContractName, change: (c: Json) => void): Json {
  const c = contract(name);
  change(c);
  return c;
}

const CASES: Record<string, [bad: Json, error: ErrorType, path: string]> = {
  // unknown names
  "unknown metric": [changed("a", (c) => (c.metrics[0].name = "total_revnue")), UnknownMetricError, "metrics[0].name"],
  "unknown group_by": [changed("c", (c) => (c.group_by = ["country"])), UnknownDimensionError, "group_by[0]"],
  "unknown filter field": [changed("a", (c) => (c.filters[0].field = "fiscal_week")), UnknownDimensionError, "filters[0].field"],
  "unknown metric filter field": [
    changed("a", (c) => (c.metrics[0].filters[0].field = "colour")),
    UnknownDimensionError,
    "metrics[0].filters[0].field",
  ],
  "unknown compare dimension": [changed("b", (c) => (c.compare.dimension = "fiscal_week")), UnknownDimensionError, "compare.dimension"],
  "filter on a non-dimension column": [changed("a", (c) => (c.filters[0].field = "revenue")), UnknownDimensionError, "filters[0].field"],
  "filter model disagrees with the semantic model": [
    changed("a", (c) => (c.filters[0].model = "fact_sales")),
    InvalidContractError,
    "filters[0].model",
  ],
  // names that exist on every JS object, which a plain-object lookup would "find"
  "metric named constructor": [changed("a", (c) => (c.metrics[1].name = "constructor")), UnknownMetricError, "metrics[1].name"],
  "dimension named toString": [changed("c", (c) => (c.group_by = ["toString"])), UnknownDimensionError, "group_by[0]"],
  // vocabulary we do not support
  having: [changed("c", (c) => (c.having = [{ metric: "order_count", op: ">", value: 2 }])), UnsupportedFeatureError, "having"],
  limit: [changed("c", (c) => (c.limit = 10)), UnsupportedFeatureError, "limit"],
  "unknown metric field": [changed("a", (c) => (c.metrics[1].window = "rolling_7d")), UnsupportedFeatureError, "metrics[1].window"],
  "unknown filter field key": [changed("a", (c) => (c.filters[0].negate = true)), UnsupportedFeatureError, "filters[0].negate"],
  "operator LIKE": [changed("a", (c) => (c.filters[0].op = "LIKE")), UnsupportedOperatorError, "filters[0].op"],
  subtotals: [changed("c", (c) => (c.totals = "subtotal")), UnsupportedFeatureError, "totals"],
  "compare output": [changed("b", (c) => (c.compare.outputs = ["values", "ratio"])), UnsupportedFeatureError, "compare.outputs[1]"],
  "delta over three periods": [
    changed("b", (c) => (c.compare.periods = ["2024", "2025", "2026"])),
    UnsupportedFeatureError,
    "compare.periods",
  ],
  // contradictions and malformed input
  "no metrics": [changed("c", (c) => (c.metrics = [])), InvalidContractError, "metrics"],
  "same metric twice without alias": [
    changed("a", (c) => (c.metrics[0] = { name: "total_revenue" })),
    DuplicateOutputError,
    "metrics",
  ],
  "alias collides with a group column": [changed("c", (c) => (c.metrics[0].as = "region")), DuplicateOutputError, "metrics"],
  "group_by listed twice": [changed("c", (c) => (c.group_by = ["region", "region"])), InvalidContractError, "group_by[1]"],
  "group_by not a list": [changed("c", (c) => (c.group_by = "region")), InvalidContractError, "group_by"],
  "primary not a period": [changed("b", (c) => (c.compare.primary = "2027")), InvalidContractError, "compare.primary"],
  "delta without primary": [changed("b", (c) => (c.compare.primary = null)), InvalidContractError, "compare.primary"],
  "period listed twice": [changed("b", (c) => (c.compare.periods = ["2025", 2025])), InvalidContractError, "compare.periods[1]"],
  "boolean period": [changed("b", (c) => (c.compare.periods = [true, "2026"])), InvalidContractError, "compare.periods[0]"],
  "compare dimension is also grouped": [
    changed("b", (c) => (c.group_by = ["region", "fiscal_year"])),
    InvalidContractError,
    "compare.dimension",
  ],
  "filter on the compared dimension": [
    changed("b", (c) => (c.filters = [{ field: "fiscal_year", op: "=", value: 2026 }])),
    InvalidContractError,
    "filters[0]",
  ],
  "null filter value": [changed("a", (c) => (c.filters[0].value = null)), InvalidContractError, "filters[0].value"],
  "missing filter value": [changed("a", (c) => delete c.filters[0].value), InvalidContractError, "filters[0].value"],
  "integer too big to be exact": [
    changed("a", (c) => (c.filters[0].value = 2 ** 53 + 2)),
    InvalidContractError,
    "filters[0].value",
  ],
  "in with a scalar": [
    changed("a", (c) => (c.filters[0] = { field: "region", op: "in", value: "North" })),
    InvalidContractError,
    "filters[0].value",
  ],
  "in with an empty list": [
    changed("a", (c) => (c.filters[0] = { field: "region", op: "in", value: [] })),
    InvalidContractError,
    "filters[0].value",
  ],
  "object value": [changed("a", (c) => (c.filters[0].value = { gte: 2025 })), InvalidContractError, "filters[0].value"],
  "contract is not an object": [["total_revenue"], InvalidContractError, "contract"],
};

describe("refusals", () => {
  it.each(Object.entries(CASES))("%s", (_, [bad, ErrorType, path]) => {
    const error = refusal(() => compileContract(MODEL, bad, "duckdb"));
    expect(error).toBeInstanceOf(ErrorType);
    expect(error.path).toBe(path);
    expect(error.message).toContain(path);
  });

  it("an unknown dialect", () => {
    const error = refusal(() => compileContract(MODEL, contract("a"), "oracle"));
    expect(error).toBeInstanceOf(UnsupportedDialectError);
    expect(error.message).toContain("supported: duckdb, postgres");
  });

  it("an unknown metric lists the known ones", () => {
    const error = refusal(() => compileContract(MODEL, changed("a", (c) => (c.metrics[0].name = "revenue")), "duckdb"));
    expect(error.message).toContain("known: total_revenue, order_count");
  });

  it("errors carry their class name", () => {
    const error = refusal(() => compileContract(MODEL, changed("a", (c) => (c.filters[0].op = "LIKE")), "duckdb"));
    expect(error.name).toBe("UnsupportedOperatorError");
    expect(String(error)).toBe(
      "UnsupportedOperatorError: filters[0].op: unsupported operator 'LIKE' (supported: =, !=, <, <=, >, >=, in, not_in)",
    );
  });
});
