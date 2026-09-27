// Every refusal is a QueryContractError with a path to the field that caused
// it ("metrics[0].filters[1].op"), so whoever wrote the contract (usually an
// LLM) can fix that one field.

export class QueryContractError extends Error {
  readonly detail: string;
  readonly path: string | undefined;

  constructor(detail: string, path?: string) {
    super(path ? `${path}: ${detail}` : detail);
    this.name = new.target.name;
    this.detail = detail;
    this.path = path;
  }
}

export type ErrorClass = new (detail: string, path?: string) => QueryContractError;

export class InvalidSemanticModelError extends QueryContractError {}

/** Malformed or self-contradictory contract. */
export class InvalidContractError extends QueryContractError {}
export class UnknownMetricError extends InvalidContractError {}
export class UnknownDimensionError extends InvalidContractError {}
export class DuplicateOutputError extends InvalidContractError {}

/** Well-formed, but asks for something this compiler doesn't do. */
export class UnsupportedFeatureError extends InvalidContractError {}
export class UnsupportedOperatorError extends UnsupportedFeatureError {}

export class NoJoinPathError extends QueryContractError {}
export class AmbiguousJoinPathError extends QueryContractError {}
export class UnsupportedDialectError extends QueryContractError {}

/**
 * A bug in the compiler, e.g. a plan that uses a table it never joined.
 * Deliberately not a QueryContractError: it must never be reported back to
 * the caller as "fix your contract".
 */
export class InternalCompilerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InternalCompilerError";
  }
}
