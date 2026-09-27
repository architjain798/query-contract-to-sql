// npm run demo                     compile A, B and C and run them on DuckDB
// npm run demo -- --dialect postgres
// npm run demo -- --raw            show rows exactly as the database returns them
// npm run sql -- <contract.json> [--dialect postgres]
// npm run explain -- <contract.json>
// npm run bench

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { openDuckDB, openPostgres } from "./databases";
import { compileContract, DEFAULT_DIALECTS, QueryCompiler, QueryContractError, SemanticModel } from "./index";

const MODEL = "semantic_model.json";
const SEED = "data/seed.sql";
const CONTRACTS = "contracts";

type Cell = string | number | bigint | boolean | null;

const USAGE = `usage: cli.ts run [contract.json...] [--dialect duckdb|postgres] [--raw]
       cli.ts sql <contract.json> [--dialect duckdb|postgres]
       cli.ts explain <contract.json>
       cli.ts bench [--iterations N]`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      dialect: { type: "string", default: "duckdb" },
      model: { type: "string", default: MODEL },
      iterations: { type: "string", default: "10000" },
      raw: { type: "boolean", default: false },
    },
  });
  const [command, ...files] = positionals;
  const compiler = QueryCompiler.fromJSON(loadJson(values.model));
  try {
    if (command === "sql" && files.length === 1) {
      console.log(compiler.compile(loadJson(files[0]!), values.dialect));
    } else if (command === "explain" && files.length === 1) {
      console.log(JSON.stringify(compiler.plan(loadJson(files[0]!)), null, 2));
    } else if (command === "run") {
      await run(compiler, files.length > 0 ? files : contractFiles(), values.dialect, values.raw);
    } else if (command === "bench") {
      bench(values.model, Number(values.iterations));
    } else {
      console.error(USAGE);
      return 2;
    }
  } catch (error) {
    if (!(error instanceof QueryContractError)) throw error;
    console.error(`refused: ${error.name}: ${error.message}`);
    return 1;
  }
  return 0;
}

function loadJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function contractFiles(): string[] {
  return readdirSync(CONTRACTS).filter((f) => f.endsWith(".json")).sort().map((f) => join(CONTRACTS, f));
}

async function run(compiler: QueryCompiler, paths: string[], dialect: string, raw: boolean): Promise<void> {
  const seed = readFileSync(SEED, "utf8");
  const db = dialect === "postgres" ? await openPostgres(seed) : await openDuckDB(seed);
  try {
    for (const path of paths) {
      const sql = compiler.compile(loadJson(path), dialect);
      const result = (await db.query(sql)) as { columns: string[]; rows: Cell[][] };
      console.log(`== ${path} (${dialect}, run on ${db.label})\n\n${sql}\n`);
      const table = raw ? { columns: result.columns, rows: result.rows.map((r) => r.map(format)) } : present(result);
      printTable(table.columns, table.rows);
      console.log();
    }
  } finally {
    await db.close();
  }
}

/**
 * Display formatting, the way the brief shows results: the total row is
 * labelled "Total" and pct_change is shown as a percentage. The SQL returns
 * NULL + is_total = true and a ratio; turning that into a label is the
 * presentation layer's job, and this is the presentation layer.
 */
function present({ columns, rows }: { columns: string[]; rows: Cell[][] }): { columns: string[]; rows: string[][] } {
  const totalAt = columns.indexOf("is_total");
  const keep = columns.map((_, i) => i).filter((i) => i !== totalAt);
  return {
    columns: keep.map((i) => columns[i]!),
    rows: rows.map((row) => {
      const isTotal = totalAt >= 0 && row[totalAt] === true;
      return keep.map((i) => {
        if (isTotal && i < totalAt) return i === 0 ? "Total" : "";
        const value = row[i]!;
        if (columns[i]!.endsWith("_pct_change") && typeof value === "number") return `${(value * 100).toFixed(1)}%`;
        return format(value);
      });
    }),
  };
}

function format(value: Cell): string {
  if (value === null) return "NULL";
  if (typeof value === "number" && !Number.isInteger(value)) return String(Number(value.toFixed(4)));
  return String(value);
}

function printTable(columns: string[], rows: string[][]): void {
  const widths = columns.map((c, i) => Math.max(c.length, ...rows.map((r) => r[i]!.length)));
  console.log(columns.map((c, i) => c.padEnd(widths[i]!)).join("  "));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) console.log(row.map((v, i) => v.padStart(widths[i]!)).join("  "));
}

function bench(modelPath: string, iterations: number): void {
  const rawModel = loadJson(modelPath);
  const model = SemanticModel.fromJSON(rawModel);
  const contracts = contractFiles().map((path) => [path.slice(CONTRACTS.length + 1), loadJson(path)] as const);

  console.log(`contract -> SQL string, ${iterations.toLocaleString("en-US")} calls each, times in microseconds\n`);
  console.log(`${"contract".padEnd(34)} ${"dialect".padEnd(9)} ${"model".padEnd(11)} ${"median".padStart(7)} ${"p99".padStart(7)} ${"max".padStart(7)}`);
  for (const [name, contract] of contracts) {
    for (const dialect of DEFAULT_DIALECTS.names) {
      for (const [label, modelArg] of [["pre-loaded", model], ["raw JSON", rawModel]] as const) {
        const samples = time(() => compileContract(modelArg, contract, dialect), iterations).sort((a, b) => a - b);
        const at = (p: number) => samples[Math.min(samples.length - 1, Math.floor((samples.length * p) / 100))]!;
        console.log(
          `${name.padEnd(34)} ${dialect.padEnd(9)} ${label.padEnd(11)}` +
            ` ${at(50).toFixed(1).padStart(7)} ${at(99).toFixed(1).padStart(7)} ${samples.at(-1)!.toFixed(1).padStart(7)}`,
        );
      }
    }
  }
}

function time(fn: () => unknown, iterations: number): number[] {
  for (let i = 0; i < 1000; i++) fn(); // let the JIT warm up first
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    fn();
    samples.push((performance.now() - start) * 1000);
  }
  return samples;
}

process.exitCode = await main(process.argv.slice(2));
