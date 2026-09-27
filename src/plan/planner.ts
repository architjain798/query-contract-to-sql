import type { BoundQuery } from "../binder";
import { PlanBuilder } from "./builder";
import type { QueryPlan } from "./ir";
import { DEFAULT_STEPS, type PlanStep } from "./steps";

export function planQuery(query: BoundQuery, steps: readonly PlanStep[] = DEFAULT_STEPS): QueryPlan {
  const plan = new PlanBuilder(query.base, query.joins);
  for (const step of steps) step.apply(query, plan);
  return plan.build();
}
