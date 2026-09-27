// Dialects by name. Immutable, so the shared default can't be changed by
// one caller under another. To add one without touching this package:
//   new QueryCompiler(model, DEFAULT_DIALECTS.with(new SnowflakeDialect()))

import { UnsupportedDialectError } from "../errors";
import { show } from "../json";
import type { Dialect } from "./dialect";
import { DuckDBDialect } from "./duckdb";
import { PostgresDialect } from "./postgres";

export class DialectRegistry {
  private constructor(private readonly byName: ReadonlyMap<string, Dialect>) {}

  static of(...dialects: Dialect[]): DialectRegistry {
    return new DialectRegistry(new Map(dialects.map((d) => [d.name, d])));
  }

  with(dialect: Dialect): DialectRegistry {
    return new DialectRegistry(new Map([...this.byName, [dialect.name, dialect]]));
  }

  get names(): string[] {
    return [...this.byName.keys()];
  }

  get(name: string): Dialect {
    const dialect = this.byName.get(name);
    if (!dialect) {
      throw new UnsupportedDialectError(
        `unsupported dialect ${show(name)} (supported: ${this.names.join(", ")})`,
        "dialect",
      );
    }
    return dialect;
  }
}

export const DEFAULT_DIALECTS = DialectRegistry.of(new DuckDBDialect(), new PostgresDialect());
