// A broken semantic model should be rejected when it's loaded.

import { describe, expect, it } from "vitest";
import { InvalidSemanticModelError, SemanticModel } from "../src/index";
import { rawModel, refusal, type Json } from "./helpers";

function brokenPath(change: (m: Json) => void): string | undefined {
  const m = rawModel();
  change(m);
  const error = refusal(() => SemanticModel.fromJSON(m));
  expect(error).toBeInstanceOf(InvalidSemanticModelError);
  return error.path;
}

describe("semantic model", () => {
  it("loads the take-home model", () => {
    const model = SemanticModel.fromJSON(rawModel());
    expect([...model.metrics.keys()]).toEqual(["total_revenue", "order_count"]);
    expect(model.dimensions.get("fiscal_year")?.model).toBe("dim_calendar");
  });

  it("refuses a duplicate metric name", () => {
    expect(brokenPath((m) => m.metrics.push({ ...m.metrics[0] }))).toBe("metrics[2]");
  });

  it("refuses a relationship to an unknown dataset", () => {
    expect(brokenPath((m) => (m.relationships[0].to = "dim_shop"))).toBe("relationships[0].to");
  });

  it("refuses many_to_many", () => {
    expect(brokenPath((m) => (m.relationships[0].cardinality = "many_to_many"))).toBe("relationships[0].cardinality");
  });

  it("refuses a metric expression that is not a single column", () => {
    // Pasting "revenue * 2" into SQL unparsed is how injection and wrong
    // column references happen, so it is refused until there is a parser.
    expect(brokenPath((m) => (m.metrics[0].expression = "revenue * 2"))).toBe("metrics[0].expression");
  });

  it("refuses an unknown agg", () => {
    expect(brokenPath((m) => (m.metrics[0].agg = "median"))).toBe("metrics[0].agg");
  });

  it("does not silently ignore an unknown field", () => {
    expect(brokenPath((m) => (m.dimensions[0].expression = "upper(region)"))).toBe("dimensions[0].expression");
  });

  it("refuses a metric on an unknown dataset", () => {
    expect(brokenPath((m) => (m.metrics[0].model = "fact_returns"))).toBe("metrics[0].model");
  });
});
