// Same contract in, same bytes out.

import { describe, expect, it } from "vitest";
import { compileContract } from "../src/index";
import { CONTRACT_NAMES, DIALECT_NAMES, MODEL, RAW_MODEL, contract, type Json } from "./helpers";

const CASES = CONTRACT_NAMES.flatMap((name) => DIALECT_NAMES.map((dialect) => [name, dialect] as const));

/** The same JSON with every object's keys in reverse order. */
function reverseKeys(value: Json): Json {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).reverse().map((k) => [k, reverseKeys(value[k])]));
  }
  return value;
}

describe.each(CASES)("determinism: %s on %s", (name, dialect) => {
  it("repeated calls are identical", () => {
    const outputs = new Set(Array.from({ length: 100 }, () => compileContract(MODEL, contract(name), dialect)));
    expect(outputs.size).toBe(1);
  });

  it("a pre-loaded and a raw model give the same SQL", () => {
    expect(compileContract(RAW_MODEL, contract(name), dialect)).toBe(compileContract(MODEL, contract(name), dialect));
  });

  it("JSON key order does not matter", () => {
    const reordered = reverseKeys(contract(name));
    expect(Object.keys(reordered)).not.toEqual(Object.keys(contract(name)));
    expect(compileContract(MODEL, reordered, dialect)).toBe(compileContract(MODEL, contract(name), dialect));
  });
});

describe("determinism", () => {
  it("does not mutate its inputs", () => {
    for (const name of CONTRACT_NAMES) {
      const given = contract(name);
      const model = structuredClone(RAW_MODEL);
      compileContract(model, given, "duckdb");
      expect(given).toEqual(contract(name));
      expect(model).toEqual(RAW_MODEL);
    }
  });

  it("keeps period order even though the labels look like integers", () => {
    // A plain JS object iterates integer-like keys ("2025") in numeric order,
    // not insertion order. Periods live in arrays, so the contract's order wins.
    const b = contract("b");
    b.compare.periods = ["2026", "2025"];
    const text = compileContract(MODEL, b, "duckdb");
    expect(text.indexOf('AS "total_revenue_2026"')).toBeLessThan(text.indexOf('AS "total_revenue_2025"'));
  });
});
