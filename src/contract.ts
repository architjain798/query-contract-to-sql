// Parse step: contract JSON -> typed Contract. Only checks shape; whether the
// names exist in the semantic model is the binder's job.
//
// Unknown fields are rejected. If the LLM sends "limit": 10 and we quietly
// ignore it, the user gets a wrong answer that looks right.

import { InvalidContractError, UnsupportedFeatureError, UnsupportedOperatorError } from "./errors";
import { assertUnique, JsonNode, show, type Scalar } from "./json";

const COMPARISON_OPERATORS = ["=", "!=", "<", "<=", ">", ">="] as const;
const LIST_OPERATORS = ["in", "not_in"] as const;
const OPERATORS = [...COMPARISON_OPERATORS, ...LIST_OPERATORS] as const;
export type ComparisonOp = (typeof COMPARISON_OPERATORS)[number];
type ListOp = (typeof LIST_OPERATORS)[number];

export const COMPARE_OUTPUTS = ["values", "delta", "pct_change"] as const;
export type CompareOutput = (typeof COMPARE_OUTPUTS)[number];

const TOTALS = ["grand"] as const;
type Totals = (typeof TOTALS)[number];

export type Period = string | number;

interface FilterBase {
  readonly field: string;
  /** Optional hint from the contract; if given it has to match the dimension's model. */
  readonly model: string | undefined;
  readonly path: string;
}

export interface ComparisonFilter extends FilterBase {
  readonly kind: "comparison";
  readonly op: ComparisonOp;
  readonly value: Scalar;
}

export interface ListFilter extends FilterBase {
  readonly kind: "list";
  readonly op: ListOp;
  readonly values: readonly Scalar[];
}

export type Filter = ComparisonFilter | ListFilter;

export interface MetricRequest {
  readonly name: string;
  readonly alias: string | undefined;
  /** Column name in the result: the alias if there is one. */
  readonly outputName: string;
  /** Applies to this metric only (conditional aggregation), not the whole query. */
  readonly filters: readonly Filter[];
  readonly path: string;
}

export interface Compare {
  readonly dimension: string;
  readonly periods: readonly Period[];
  readonly outputs: readonly CompareOutput[];
  /** Always set when delta or pct_change is requested. */
  readonly change: { readonly primary: Period; readonly baseline: Period } | undefined;
}

export interface Contract {
  readonly metrics: readonly MetricRequest[];
  readonly groupBy: readonly string[];
  readonly filters: readonly Filter[];
  readonly compare: Compare | undefined;
  readonly totals: Totals | undefined;
}

export function parseContract(raw: unknown): Contract {
  const root = JsonNode.root(raw, "contract", InvalidContractError).object(
    ["metrics", "group_by", "filters", "compare", "totals"],
    UnsupportedFeatureError,
  );

  const metricsNode = root.field("metrics");
  const metrics = metricsNode.optionalList().map(parseMetric);
  if (metrics.length === 0) throw metricsNode.error("at least one metric is required");

  const groupByNodes = root.field("group_by").optionalList();
  const groupBy = groupByNodes.map((node) => node.string());
  assertUnique(groupByNodes, groupBy, (name) => `${show(name)} is listed twice`);

  const compare = root.field("compare");
  const totals = root.field("totals");
  return {
    metrics,
    groupBy,
    filters: parseFilters(root),
    compare: compare.isAbsent ? undefined : parseCompare(compare),
    totals: totals.isAbsent ? undefined : totals.oneOf(TOTALS, "totals", UnsupportedFeatureError),
  };
}

function parseMetric(node: JsonNode): MetricRequest {
  node.object(["name", "as", "filters"], UnsupportedFeatureError);
  const name = node.field("name").string();
  const alias = node.field("as").optionalString();
  return { name, alias, outputName: alias ?? name, filters: parseFilters(node), path: node.path };
}

function parseFilters(parent: JsonNode): Filter[] {
  return parent.field("filters").optionalList().map(parseFilter);
}

function parseFilter(node: JsonNode): Filter {
  node.object(["field", "op", "value", "model"], UnsupportedFeatureError);
  const op = node.field("op").oneOf(OPERATORS, "operator", UnsupportedOperatorError);
  const base: FilterBase = {
    field: node.field("field").string(),
    model: node.field("model").optionalString(),
    path: node.path,
  };
  const valueNode = node.field("value");
  if (op === "in" || op === "not_in") {
    const items = valueNode.list();
    if (items.length === 0) throw valueNode.error(`${show(op)} needs at least one value`);
    return { kind: "list", op, values: items.map((item) => item.scalar()), ...base };
  }
  return { kind: "comparison", op, value: valueNode.scalar(), ...base };
}

function parseCompare(node: JsonNode): Compare {
  node.object(["dimension", "periods", "primary", "outputs"], UnsupportedFeatureError);

  const periodsNode = node.field("periods");
  const periodNodes = periodsNode.list();
  if (periodNodes.length === 0) throw periodsNode.error("at least one period is required");
  const periods = periodNodes.map(parsePeriod);
  // "2025" and 2025 are different JSON values but would both become the
  // column total_revenue_2025, so compare them as strings.
  const labels = periods.map(String);
  assertUnique(periodNodes, labels, (label) => `period ${show(label)} is listed twice`);

  const outputNodes = node.field("outputs").optionalList();
  const outputs: CompareOutput[] =
    outputNodes.length > 0
      ? outputNodes.map((n) => n.oneOf(COMPARE_OUTPUTS, "compare output", UnsupportedFeatureError))
      : ["values"];
  assertUnique(outputNodes, outputs, (output) => `${show(output)} is listed twice`);

  const primaryNode = node.field("primary");
  let primary: Period | undefined;
  if (!primaryNode.isAbsent) {
    const wanted = parsePeriod(primaryNode);
    const at = labels.indexOf(String(wanted));
    if (at < 0) throw primaryNode.error(`primary ${show(wanted)} is not one of the periods`);
    primary = periods[at];
  }

  let change: Compare["change"];
  if (outputs.includes("delta") || outputs.includes("pct_change")) {
    if (periods.length !== 2) {
      throw periodsNode.error(
        `delta and pct_change need exactly 2 periods, got ${periods.length} ` +
          "(with more it is ambiguous what to compare against)",
        UnsupportedFeatureError,
      );
    }
    if (primary === undefined) throw primaryNode.error("is required when delta or pct_change is requested");
    const chosen = primary;
    change = { primary: chosen, baseline: periods.find((p) => p !== chosen)! };
  }

  return { dimension: node.field("dimension").string(), periods, outputs, change };
}

function parsePeriod(node: JsonNode): Period {
  const value = node.value;
  if (typeof value === "string" && value !== "") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  throw node.error("a period must be a non-empty string or an integer");
}
