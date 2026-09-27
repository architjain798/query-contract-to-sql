// The 10 ms budget, with lots of headroom so it can't flake on a slow CI box.
// `npm run bench` prints the real numbers.

import { describe, expect, it } from "vitest";
import { compileContract } from "../src/index";
import { CONTRACT_NAMES, DIALECT_NAMES, RAW_MODEL, contract } from "./helpers";

const BUDGET_MS = 10;
const CASES = CONTRACT_NAMES.flatMap((name) => DIALECT_NAMES.map((dialect) => [name, dialect] as const));

describe("performance", () => {
  it.each(CASES)("%s on %s is well under budget", (name, dialect) => {
    const c = contract(name);
    const samples: number[] = [];
    for (let i = 0; i < 1000; i++) {
      const start = performance.now();
      compileContract(RAW_MODEL, c, dialect); // worst case: parses the model every call
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    expect(samples[989]!).toBeLessThan(BUDGET_MS); // p99
  });
});
