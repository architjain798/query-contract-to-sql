// Exact SQL snapshots. Result tests show the SQL is right; these show it didn't change.
// After an intended change: npm run golden, then review the diff.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileContract } from "../src/index";
import { CONTRACT_FILES, CONTRACT_NAMES, DIALECT_NAMES, MODEL, ROOT, contract } from "./helpers";

const CASES = CONTRACT_NAMES.flatMap((name) => DIALECT_NAMES.map((dialect) => [name, dialect] as const));

describe("golden SQL", () => {
  it.each(CASES)("%s on %s matches its snapshot", (name, dialect) => {
    const sql = compileContract(MODEL, contract(name), dialect) + "\n";
    const path = join(ROOT, "test", "golden", `${CONTRACT_FILES[name]}.${dialect}.sql`);
    if (process.env.UPDATE_GOLDEN) writeFileSync(path, sql);
    expect(sql).toBe(readFileSync(path, "utf8"));
  });
});
