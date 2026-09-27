// The one-command deliverable: `npm run demo` compiles and runs A, B and C.

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "./helpers";

const cli = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { cwd: ROOT, encoding: "utf8" });

describe("cli", () => {
  it("runs the three contracts on DuckDB and prints the brief's numbers", () => {
    const result = cli("run");
    expect(result.status).toBe(0);
    const out = result.stdout;
    expect(out).toMatch(/420\s+710/);
    expect(out).toMatch(/Total\s+450\s+710\s+260\s+57\.8%/);
    expect(out).toMatch(/Total\s+8\n/);
  });

  it("exits with 1 and a named error when it refuses", () => {
    const bad = join(tmpdir(), "qc-bad-contract.json");
    writeFileSync(bad, JSON.stringify({ metrics: [{ name: "total_revenue" }], filters: [{ field: "region", op: "LIKE", value: "N%" }] }));
    const result = cli("sql", bad);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("UnsupportedOperatorError: filters[0].op");
  });
});
