// contract JSON -> parse -> Contract -> bind -> BoundQuery -> plan -> QueryPlan -> render -> SQL
//
// No I/O, clock or randomness anywhere in here: the same inputs always give
// the same string.

import { Binder } from "./binder";
import { parseContract } from "./contract";
import { SemanticModel } from "./model/semanticModel";
import type { QueryPlan } from "./plan/ir";
import { planQuery } from "./plan/planner";
import { DEFAULT_DIALECTS, type DialectRegistry } from "./render/registry";
import { SqlRenderer } from "./render/sqlRenderer";

/** Load a model once, then compile as many contracts against it as you like. */
export class QueryCompiler {
  private readonly binder: Binder;

  constructor(
    readonly model: SemanticModel,
    private readonly dialects: DialectRegistry = DEFAULT_DIALECTS,
  ) {
    this.binder = new Binder(model);
  }

  static fromJSON(rawModel: unknown, dialects?: DialectRegistry): QueryCompiler {
    return new QueryCompiler(SemanticModel.fromJSON(rawModel), dialects);
  }

  compile(contract: unknown, dialect: string): string {
    const renderer = new SqlRenderer(this.dialects.get(dialect));
    return renderer.render(this.plan(contract));
  }

  /** The dialect-free plan; `npm run explain` prints it. */
  plan(contract: unknown): QueryPlan {
    return planQuery(this.binder.bind(parseContract(contract)));
  }
}

/**
 * The function the brief asks for. `semanticModel` can be the raw JSON or an
 * already-loaded SemanticModel (faster if you compile many contracts).
 * Throws a QueryContractError when it refuses.
 */
export function compileContract(semanticModel: unknown, contract: unknown, dialect: string): string {
  const model = semanticModel instanceof SemanticModel ? semanticModel : SemanticModel.fromJSON(semanticModel);
  return new QueryCompiler(model).compile(contract, dialect);
}
