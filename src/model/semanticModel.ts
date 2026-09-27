// The semantic model is everything the compiler is allowed to know about the
// customer's data; it never looks at the warehouse. It's validated once on
// load, and lookups go through metric() / dimension() so the "unknown name"
// errors live in one place.
//
// Indexes are Maps rather than plain objects, so a metric called
// "constructor" isn't found on Object.prototype.

import { InvalidSemanticModelError, UnknownDimensionError, UnknownMetricError } from "../errors";
import { JsonNode, show } from "../json";
import { CARDINALITIES, JoinGraph, type Relationship } from "./joinGraph";

// Metric expressions must be a bare column for now. Pasting arbitrary text
// into SQL is how injection and silent mistakes happen.
const COLUMN_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const SUPPORTED_AGGS = ["sum", "count", "count_distinct", "avg", "min", "max"] as const;
export type Agg = (typeof SUPPORTED_AGGS)[number];

interface Dataset {
  readonly name: string;
  readonly grain: string | undefined;
}

export interface Metric {
  readonly name: string;
  readonly agg: Agg;
  readonly column: string;
  /** The dataset (fact table) this metric aggregates. */
  readonly model: string;
  readonly measureClass: string | undefined;
}

export interface Dimension {
  readonly name: string;
  readonly model: string;
  readonly column: string;
}

export class SemanticModel {
  private constructor(
    readonly datasets: ReadonlyMap<string, Dataset>,
    readonly metrics: ReadonlyMap<string, Metric>,
    readonly dimensions: ReadonlyMap<string, Dimension>,
    readonly joinGraph: JoinGraph,
  ) {}

  static fromJSON(raw: unknown): SemanticModel {
    const root = JsonNode.root(raw, "semantic_model", InvalidSemanticModelError).object([
      "datasets",
      "relationships",
      "metrics",
      "dimensions",
    ]);
    const datasets = indexByName(root.field("datasets").optionalList(), parseDataset);
    const relationships = root.field("relationships").optionalList().map((n) => parseRelationship(n, datasets));
    const metrics = indexByName(root.field("metrics").optionalList(), (n) => parseMetric(n, datasets));
    const dimensions = indexByName(root.field("dimensions").optionalList(), (n) => parseDimension(n, datasets));
    return new SemanticModel(datasets, metrics, dimensions, JoinGraph.build(datasets.keys(), relationships));
  }

  metric(name: string, path: string): Metric {
    const metric = this.metrics.get(name);
    if (!metric) throw new UnknownMetricError(`unknown metric ${show(name)} (known: ${known(this.metrics)})`, path);
    return metric;
  }

  dimension(name: string, path: string): Dimension {
    const dim = this.dimensions.get(name);
    if (!dim) throw new UnknownDimensionError(`unknown dimension ${show(name)} (known: ${known(this.dimensions)})`, path);
    return dim;
  }
}

function known(index: ReadonlyMap<string, unknown>): string {
  return [...index.keys()].join(", ");
}

function indexByName<T extends { readonly name: string }>(nodes: readonly JsonNode[], parse: (n: JsonNode) => T): Map<string, T> {
  const byName = new Map<string, T>();
  for (const node of nodes) {
    const item = parse(node);
    if (byName.has(item.name)) throw node.error(`duplicate name ${show(item.name)}`);
    byName.set(item.name, item);
  }
  return byName;
}

function parseDataset(node: JsonNode): Dataset {
  node.object(["name", "grain"]);
  return { name: node.field("name").string(), grain: node.field("grain").optionalString() };
}

function parseRelationship(node: JsonNode, datasets: ReadonlyMap<string, Dataset>): Relationship {
  node.object(["from", "from_column", "to", "to_column", "cardinality"]);
  return {
    fromDataset: datasetName(node.field("from"), datasets),
    fromColumn: columnName(node.field("from_column")),
    toDataset: datasetName(node.field("to"), datasets),
    toColumn: columnName(node.field("to_column")),
    cardinality: node.field("cardinality").oneOf(CARDINALITIES, "cardinality"),
  };
}

function parseMetric(node: JsonNode, datasets: ReadonlyMap<string, Dataset>): Metric {
  node.object(["name", "agg", "expression", "model", "measure_class"]);
  return {
    name: node.field("name").string(),
    column: columnName(node.field("expression")),
    agg: node.field("agg").oneOf(SUPPORTED_AGGS, "agg"),
    model: datasetName(node.field("model"), datasets),
    measureClass: node.field("measure_class").optionalString(),
  };
}

function parseDimension(node: JsonNode, datasets: ReadonlyMap<string, Dataset>): Dimension {
  node.object(["name", "model", "column"]);
  const nameNode = node.field("name");
  // Dimensions are named after their column unless `column` says otherwise.
  const columnNode = node.field("column");
  return {
    name: nameNode.string(),
    model: datasetName(node.field("model"), datasets),
    column: columnName(columnNode.isAbsent ? nameNode : columnNode),
  };
}

function datasetName(node: JsonNode, datasets: ReadonlyMap<string, Dataset>): string {
  const name = node.string();
  if (!datasets.has(name)) throw node.error(`unknown dataset ${show(name)}`);
  return name;
}

function columnName(node: JsonNode): string {
  const value = node.string();
  if (!COLUMN_NAME.test(value)) {
    throw node.error(`${show(value)} is not a plain column name (only single-column expressions are supported)`);
  }
  return value;
}
