// Fixtures, plus an engine per dialect. DuckDB gets a fresh in-memory database per test.
// Postgres is PGlite, or a real server if POSTGRES_URL is set (docker compose does that).
// Either way there's one database per test file and each test runs in a transaction that
// gets rolled back, so tests can insert rows freely.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";
import { openDuckDB, openPostgres, type Database } from "../src/databases";
import { compileContract, QueryContractError, SemanticModel } from "../src/index";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SEED = readFileSync(join(ROOT, "data", "seed.sql"), "utf8");

export const CONTRACT_FILES = {
  a: "a_aliased_metric_filters",
  b: "b_compare_with_totals",
  c: "c_distinct_count_totals",
} as const;
export type ContractName = keyof typeof CONTRACT_FILES;
export const CONTRACT_NAMES = Object.keys(CONTRACT_FILES) as ContractName[];
export const DIALECT_NAMES = ["duckdb", "postgres"] as const;

// Tests build and mutate contracts freely, so they are loosely typed here.
// The compiler takes `unknown` and validates everything itself.
export type Json = any;

export function loadJson(relativePath: string): Json {
  return JSON.parse(readFileSync(join(ROOT, relativePath), "utf8"));
}

export const RAW_MODEL: Json = loadJson("semantic_model.json");
export const MODEL = SemanticModel.fromJSON(RAW_MODEL);

/** A fresh copy of the semantic model JSON, safe to modify in a test. */
export function rawModel(): Json {
  return structuredClone(RAW_MODEL);
}

/** A fresh copy of contract "a", "b" or "c", safe to modify. */
export function contract(name: ContractName): Json {
  return loadJson(join("contracts", `${CONTRACT_FILES[name]}.json`));
}

/** Run `fn` and return the QueryContractError it throws (fails if it does not). */
export function refusal(fn: () => unknown): QueryContractError {
  try {
    fn();
  } catch (error) {
    if (error instanceof QueryContractError) return error;
    throw error;
  }
  throw new Error("expected a QueryContractError, but compilation succeeded");
}

export type Row = Record<string, unknown>;

export interface Engine {
  readonly dialect: (typeof DIALECT_NAMES)[number];
  exec(sql: string): Promise<void>;
  /** Column names in result order, and rows keyed by column name. */
  query(sql: string): Promise<{ columns: string[]; rows: Row[] }>;
  /** Compile a contract for this engine's dialect and run it. */
  run(contractJson: unknown, model?: unknown): Promise<Row[]>;
}

/** COUNT comes back as a bigint; the tests compare plain numbers. */
function normalise(value: unknown): unknown {
  return typeof value === "bigint" ? Number(value) : value;
}

function toRows(columns: string[], rows: unknown[][]): Row[] {
  return rows.map((row) => Object.fromEntries(columns.map((c, i) => [c, normalise(row[i])])));
}

/** Registers hooks on the current describe block and returns a getter for the engine. */
export function useEngine(dialect: Engine["dialect"]): () => Engine {
  let db: Database | undefined;

  const engine = (): Engine => {
    if (!db) throw new Error("engine used outside a test");
    const current = db;
    const query = async (sql: string) => {
      const { columns, rows } = await current.query(sql);
      return { columns, rows: toRows(columns, rows) };
    };
    return {
      dialect,
      exec: (sql) => current.exec(sql),
      query,
      run: async (contractJson, model = MODEL) => (await query(compileContract(model, contractJson, dialect))).rows,
    };
  };

  if (dialect === "duckdb") {
    beforeEach(async () => {
      db = await openDuckDB(SEED);
    });
    afterEach(() => db?.close());
  } else {
    beforeAll(async () => {
      db = await openPostgres(SEED);
    });
    afterAll(() => db?.close());
    beforeEach(() => db!.exec("BEGIN"));
    afterEach(() => db!.exec("ROLLBACK"));
  }

  return engine;
}
