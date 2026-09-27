// Bind step: resolve every name in the contract against the semantic model,
// check the rules that span several fields, and work out the joins. After
// this the planner can't run into an unknown name. (Duplicate output column
// names are the one thing checked later, by the plan builder, because the
// names only exist once the columns are generated.)

import type { Compare, CompareOutput, Contract, Filter, MetricRequest, Period } from "./contract";
import { InvalidContractError, UnsupportedFeatureError } from "./errors";
import { show } from "./json";
import type { JoinEdge, JoinNeed } from "./model/joinGraph";
import type { Dimension, Metric, SemanticModel } from "./model/semanticModel";

export interface BoundFilter {
  readonly filter: Filter;
  readonly dimension: Dimension;
}

export interface BoundMetric {
  readonly request: MetricRequest;
  readonly metric: Metric;
  readonly filters: readonly BoundFilter[];
}

export interface BoundCompare {
  readonly dimension: Dimension;
  readonly periods: readonly Period[];
  readonly outputs: readonly CompareOutput[];
  readonly change: Compare["change"];
}

export interface BoundQuery {
  /** The fact table every row comes from. */
  readonly base: string;
  /** LEFT JOINs to every table the query uses, parents first. */
  readonly joins: readonly JoinEdge[];
  readonly groupBy: readonly Dimension[];
  /** Query-level filters; they restrict the rows every metric sees. */
  readonly filters: readonly BoundFilter[];
  readonly metrics: readonly BoundMetric[];
  readonly compare: BoundCompare | undefined;
  readonly grandTotal: boolean;
}

export class Binder {
  constructor(private readonly model: SemanticModel) {}

  bind(contract: Contract): BoundQuery {
    const metrics = contract.metrics.map((request) => this.bindMetric(request));
    const base = this.factTable(metrics);
    const groupBy = contract.groupBy.map((name, i) => this.model.dimension(name, `group_by[${i}]`));
    const filters = contract.filters.map((f) => this.bindFilter(f));
    const compare = contract.compare && this.bindCompare(contract.compare);
    if (compare) this.checkCompare(compare, groupBy, [...filters, ...metrics.flatMap((m) => m.filters)]);

    const needs: JoinNeed[] = [
      ...groupBy.map((d, i) => ({ dataset: d.model, path: `group_by[${i}]` })),
      ...filters.map((b) => ({ dataset: b.dimension.model, path: b.filter.path })),
      ...metrics.flatMap((m) => m.filters.map((b) => ({ dataset: b.dimension.model, path: b.filter.path }))),
      ...(compare ? [{ dataset: compare.dimension.model, path: "compare.dimension" }] : []),
    ];
    const joins = this.model.joinGraph.resolve(base, needs);

    return { base, joins, groupBy, filters, metrics, compare, grandTotal: contract.totals === "grand" };
  }

  private bindMetric(request: MetricRequest): BoundMetric {
    return {
      request,
      metric: this.model.metric(request.name, `${request.path}.name`),
      filters: request.filters.map((f) => this.bindFilter(f)),
    };
  }

  private bindFilter(filter: Filter): BoundFilter {
    const dimension = this.model.dimension(filter.field, `${filter.path}.field`);
    if (filter.model !== undefined && filter.model !== dimension.model) {
      throw new InvalidContractError(
        `${show(filter.field)} lives on ${show(dimension.model)}, not ${show(filter.model)}`,
        `${filter.path}.model`,
      );
    }
    return { filter, dimension };
  }

  private bindCompare(compare: Compare): BoundCompare {
    const { periods, outputs, change } = compare;
    return { dimension: this.model.dimension(compare.dimension, "compare.dimension"), periods, outputs, change };
  }

  private factTable(metrics: readonly BoundMetric[]): string {
    const base = metrics[0]!.metric.model;
    for (const m of metrics.slice(1)) {
      if (m.metric.model !== base) {
        // Joining two fact tables row to row multiplies rows. Doing this
        // properly means aggregating each fact separately first.
        throw new UnsupportedFeatureError(
          `metrics from more than one fact table (${show(base)} and ${show(m.metric.model)}) are not supported yet`,
          `${m.request.path}.name`,
        );
      }
    }
    return base;
  }

  private checkCompare(compare: BoundCompare, groupBy: readonly Dimension[], filters: readonly BoundFilter[]): void {
    const name = compare.dimension.name;
    if (groupBy.some((d) => d.name === name)) {
      throw new InvalidContractError(`${show(name)} cannot be both the compare dimension and a group_by`, "compare.dimension");
    }
    // A filter on the compared dimension would empty some of the period
    // columns, and the result would read as "no sales" rather than "filtered out".
    const clash = filters.find((b) => b.dimension.name === name);
    if (clash) {
      throw new InvalidContractError(
        `cannot filter on ${show(name)} while comparing its periods; list the periods in compare instead`,
        clash.filter.path,
      );
    }
  }
}
