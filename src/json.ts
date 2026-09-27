// Reading untrusted JSON. A JsonNode carries the value, where it came from,
// and which error to throw, so parsers can write
//   node.field("op").oneOf(OPERATORS, "operator", UnsupportedOperatorError)
// and every failure points at the right field.

import type { ErrorClass, QueryContractError } from "./errors";

export type Scalar = string | number | boolean;

/** How a value appears in error messages. */
export function show(value: unknown): string {
  return typeof value === "string" ? `'${value}'` : JSON.stringify(value);
}

function jsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export class JsonNode {
  private constructor(
    readonly value: unknown,
    readonly path: string,
    private readonly errorType: ErrorClass,
    private readonly rootName: string,
  ) {}

  static root(value: unknown, rootName: string, errorType: ErrorClass): JsonNode {
    return new JsonNode(value, "", errorType, rootName);
  }

  get isAbsent(): boolean {
    return this.value === undefined || this.value === null;
  }

  error(detail: string, errorType: ErrorClass = this.errorType): QueryContractError {
    return new errorType(detail, this.path || this.rootName);
  }

  /** Require an object with no keys outside `allowed`. */
  object(allowed: readonly string[], unknownKeyError: ErrorClass = this.errorType): this {
    const record = this.record();
    for (const key of Object.keys(record)) {
      if (!allowed.includes(key)) {
        throw this.child(key, record[key]).error(
          `unknown field ${show(key)} (supported: ${allowed.join(", ")})`,
          unknownKeyError,
        );
      }
    }
    return this;
  }

  field(key: string): JsonNode {
    const record = this.record();
    // Own properties only: {}["constructor"] is a function, not a missing key.
    return this.child(key, Object.hasOwn(record, key) ? record[key] : undefined);
  }

  string(): string {
    const value = this.value;
    if (value === undefined || value === null) throw this.error("is required");
    if (typeof value !== "string" || value === "") {
      throw this.error(`expected a non-empty string, got ${jsonType(value)}`);
    }
    return value;
  }

  optionalString(): string | undefined {
    return this.isAbsent ? undefined : this.string();
  }

  oneOf<T extends string>(allowed: readonly T[], what: string, errorType: ErrorClass = this.errorType): T {
    const value = this.string();
    if (!(allowed as readonly string[]).includes(value)) {
      throw this.error(`unsupported ${what} ${show(value)} (supported: ${allowed.join(", ")})`, errorType);
    }
    return value as T;
  }

  list(): JsonNode[] {
    const value = this.value;
    if (value === undefined || value === null) throw this.error("is required");
    if (!Array.isArray(value)) throw this.error(`expected an array, got ${jsonType(value)}`);
    return value.map((item, i) => new JsonNode(item, `${this.path}[${i}]`, this.errorType, this.rootName));
  }

  optionalList(): JsonNode[] {
    return this.isAbsent ? [] : this.list();
  }

  /** A value we can put in SQL as a literal. */
  scalar(): Scalar {
    const value = this.value;
    if (value === undefined) throw this.error("is required");
    if (value === null) {
      // `x = NULL` is never true in SQL, so passing it through would silently match nothing.
      throw this.error("null is not a supported value (null checks would need their own operator)");
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw this.error("NaN and infinite numbers are not supported");
      // JSON.parse has already rounded these, so we can't know what was meant.
      if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
        throw this.error("integers beyond 2^53 cannot be represented exactly");
      }
      return value;
    }
    if (typeof value === "string" || typeof value === "boolean") return value;
    throw this.error(`expected a string, number or boolean, got ${jsonType(value)}`);
  }

  private record(): { readonly [key: string]: unknown } {
    const value = this.value;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw this.error(`expected an object, got ${jsonType(value)}`);
    }
    return value as { readonly [key: string]: unknown };
  }

  private child(key: string, value: unknown): JsonNode {
    return new JsonNode(value, this.path ? `${this.path}.${key}` : key, this.errorType, this.rootName);
  }
}

/** Throws at the first repeated label. */
export function assertUnique(nodes: readonly JsonNode[], labels: readonly string[], message: (label: string) => string): void {
  labels.forEach((label, i) => {
    if (labels.indexOf(label) < i) throw nodes[i]!.error(message(label));
  });
}
