// Somewhere to run the generated SQL, for the CLI and the tests. The compiler
// itself never imports this file.
//
// Postgres is a real server when POSTGRES_URL is set (docker compose does
// this), otherwise PGlite, which is Postgres compiled to WebAssembly and
// running in-process.

export interface Database {
  readonly label: string;
  exec(sql: string): Promise<void>;
  query(sql: string): Promise<{ columns: string[]; rows: unknown[][] }>;
  close(): Promise<void>;
}

export async function openDuckDB(seed: string): Promise<Database> {
  const { DuckDBInstance } = await import("@duckdb/node-api");
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  await connection.run(seed);
  return {
    label: "DuckDB",
    exec: async (sql) => void (await connection.run(sql)),
    query: async (sql) => {
      const reader = await connection.runAndReadAll(sql);
      return { columns: reader.columnNames(), rows: reader.getRows() };
    },
    close: async () => {
      connection.closeSync();
      instance.closeSync();
    },
  };
}

export async function openPostgres(seed: string): Promise<Database> {
  const url = process.env.POSTGRES_URL;
  return url ? openPostgresServer(url, seed) : openPGlite(seed);
}

async function openPGlite(seed: string): Promise<Database> {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite();
  await db.exec(seed);
  const version = (await db.query<{ server_version: string }>("SHOW server_version")).rows[0]!.server_version;
  return {
    label: `PGlite (Postgres ${version})`,
    exec: async (sql) => void (await db.exec(sql)),
    query: async (sql) => {
      const result = await db.query<unknown[]>(sql, [], { rowMode: "array" });
      return { columns: result.fields.map((f) => f.name), rows: result.rows };
    },
    close: () => db.close(),
  };
}

async function openPostgresServer(url: string, seed: string): Promise<Database> {
  const { default: pg } = await import("pg");
  // COUNT returns bigint (oid 20), which pg gives back as a string by default.
  pg.types.setTypeParser(20, BigInt);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  // Each connection gets its own schema, so test files running in parallel
  // against the same server don't trip over each other's tables.
  const schema = `qc_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  await client.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}`);
  await client.query(seed);
  const version = (await client.query("SHOW server_version")).rows[0].server_version as string;
  return {
    label: `Postgres ${version}`,
    exec: async (sql) => void (await client.query(sql)),
    query: async (sql) => {
      const result = await client.query({ text: sql, rowMode: "array" });
      return { columns: result.fields.map((f) => f.name), rows: result.rows as unknown[][] };
    },
    close: async () => {
      await client.query(`DROP SCHEMA ${schema} CASCADE`);
      await client.end();
    },
  };
}
