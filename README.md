# query-contract-to-sql

Turns a query contract into SQL for DuckDB or Postgres, in TypeScript.

```ts
import { compileContract } from "./src/index";

const sql = compileContract(semanticModel, contract, "duckdb"); // or "postgres"
```

`compileContract` is synchronous and pure: no I/O, no clock, no randomness. The compiler has no runtime dependencies. DuckDB and Postgres are dev dependencies only, used by the CLI and the tests to actually run the SQL.

## Running it

With Node 22.12 or newer:

```sh
npm install
npm run demo        # compile A, B and C, run them on DuckDB, print SQL and results
npm test            # type-check, then all tests on DuckDB and Postgres
```

Or with Docker, where the Postgres tests run against a real Postgres 16 server:

```sh
docker compose run --rm test
docker compose run --rm demo
docker compose run --rm demo-postgres
docker compose down
```

Other commands:

```sh
npm run demo -- --dialect postgres     # same as demo, on Postgres
npm run demo -- --raw                  # rows exactly as the database returns them
npm run sql -- contracts/b_compare_with_totals.json --dialect postgres
npm run explain -- contracts/b_compare_with_totals.json   # the query plan, before any SQL
npm run bench
```

Outside Docker nothing needs setting up. DuckDB runs in-process through [`@duckdb/node-api`](https://www.npmjs.com/package/@duckdb/node-api), and Postgres is [PGlite](https://pglite.dev), which is Postgres itself (currently 18) compiled to WebAssembly. Set `POSTGRES_URL` and the same tests use that server instead. CI runs them both ways, so the Postgres output is executed by two real Postgres versions, not just compared as text.

`npm run demo` prints:

```
online_rev  total_revenue
       420            710

region  total_revenue_2025  total_revenue_2026  total_revenue_delta  total_revenue_pct_change
 North                 100                 250                  150                    150.0%
 South                 200                 370                  170                     85.0%
  West                 150                  90                  -60                    -40.0%
 Total                 450                 710                  260                     57.8%

region  order_count
 North            4
 South            3
  West            2
 Total            8
```

The "Total" label and the percentages are formatting done by the CLI. The SQL itself returns `region = NULL, is_total = true` for the total row and `pct_change` as a ratio (0.5778). More on why below.

## How it's put together

```
contract JSON -> parse -> bind -> plan -> render -> SQL
                           ^
                     semantic model
```

- **Parse** (`contract.ts`) checks the shape of the JSON: types, required fields, allowed values. It knows nothing about the customer's data.
- **Bind** (`binder.ts`, `model/`) looks every name up in the semantic model, checks the rules that involve more than one field, and works out the joins.
- **Plan** (`plan/`) decides what to compute and produces a query plan. The plan is plain data with no SQL text in it.
- **Render** (`render/`) turns the plan into SQL for one dialect. It never sees the contract.

I split it this way so each piece has one question to answer. An unknown name is the binder's problem, wrong numbers are a planning problem, and a syntax error on one engine is that dialect's problem. It also means a dialect can't change what a query means: it only gets the finished plan, and it's only asked how to spell things.

Every query comes out with the same two-stage shape. This is contract B:

```sql
WITH "aggregated" AS (
  SELECT
    "dim_store"."region" AS "region",
    GROUPING("dim_store"."region") <> 0 AS "is_total",
    SUM(CASE WHEN "dim_calendar"."fiscal_year" = '2025' THEN "fact_sales"."revenue" END) AS "total_revenue_2025",
    SUM(CASE WHEN "dim_calendar"."fiscal_year" = '2026' THEN "fact_sales"."revenue" END) AS "total_revenue_2026"
  FROM "fact_sales"
  LEFT JOIN "dim_store" ON "fact_sales"."store_id" = "dim_store"."store_id"
  LEFT JOIN "dim_calendar" ON "fact_sales"."order_date" = "dim_calendar"."date"
  WHERE "dim_calendar"."fiscal_year" IN ('2025', '2026')
  GROUP BY GROUPING SETS (("dim_store"."region"), ())
)
SELECT
  "region",
  "is_total",
  "total_revenue_2025",
  "total_revenue_2026",
  "total_revenue_2026" - "total_revenue_2025" AS "total_revenue_delta",
  ("total_revenue_2026" - "total_revenue_2025") / NULLIF("total_revenue_2025", 0) AS "total_revenue_pct_change"
FROM "aggregated"
ORDER BY "is_total" ASC NULLS LAST, "region" ASC NULLS LAST
```

The inner query aggregates. The grand total is the empty grouping set `()`, so the database computes it from the base rows, the same way it computes every other group. That's why contract C's total is 8 and not 9: order O-203 has lines in North and South, and the total recounts distinct orders instead of adding up the region counts.

The outer query only does arithmetic within a row. So the total row's `pct_change` is built from the total row's own cells, 260 / 450 = 57.8%, and not from the percentage column (which would add up to 195%). Because both traps are handled by the shape of the query, the planner never looks at `measure_class` to decide how to total something. Recomputing from the base rows is right for SUM, COUNT DISTINCT, AVG, MIN and MAX alike. There's a test for AVG, where the right total is 128.9 and the average of the region averages would be 132.5.

Inside `plan/`, each contract feature is its own small step (`GroupByStep`, `QueryFilterStep`, `GrandTotalStep`, `MetricColumnsStep`, `DefaultOrderStep`). The steps don't call each other. They tell a `PlanBuilder` what they need and the builder assembles the two stages. `compare` changes how every metric becomes columns (one per period, plus delta and pct_change), so that part is a swappable layout (`SingleValueLayout` or `PeriodComparisonLayout`) instead of `if (compare)` scattered through the planner. Before handing the plan over, the builder checks it. Duplicate column names are reported to the caller. Anything else that doesn't add up, like a column from a table that was never joined, throws `InternalCompilerError`, because that's a bug in the compiler and not in the contract.

On the render side there's one `SqlRenderer` that owns the layout, and it's given a `Dialect` that answers spelling questions. `safeDivide` is abstract, so a new dialect doesn't compile until someone decides how division works on that engine (see below for why that matters).

TypeScript helps in a few places. The plan is a discriminated union, and the functions that walk it end in a `never` check, so adding a node type without handling it is a compile error. A filter is either `{ kind: "comparison", value }` or `{ kind: "list", values }`, so "`in` with one value" can't exist after parsing. And the compiler takes `unknown` for the contract and the model, which forces everything to be validated before it's used.

**Why no SQL library.** The SQL I need is small, about a dozen kinds of node, and the output has to be identical byte for byte, so I wanted to own every character of it. If this had to support many dialects or parse SQL written by people, I'd look at a library like sqlglot, which works the same way underneath: an AST plus a generator per dialect. I didn't use a schema library for parsing either, because I wanted exact error paths for the LLM and the parser is small enough to write by hand. The section on 10x growth says when I'd change that.

**Determinism.** The main risk in JavaScript is iterating a plain object: keys that look like integers (`"2025"`) come out first, in numeric order, no matter the order they were added in. So everything that gets iterated is an array or a `Map`, which both keep insertion order. Nothing reads the clock or `Math.random`, and numbers are rendered with `String(n)`. The tests compile each contract 100 times, reverse the key order of the JSON, check that the inputs aren't mutated, and compare against golden files byte for byte.

## Decisions about correctness

**Joins.** Every join is a `LEFT JOIN` from the fact table. A sale whose store isn't in `dim_store` is still revenue: with a test row like that, total revenue is 2160 with the left join and 1160 with an inner join. Filters go in `WHERE`, so a filter on a dimension column does restrict rows, and drops the orphan sale when you filter to `region = 'North'`. The join attaches and `WHERE` restricts, and I kept those two things separate on purpose.

The contract never says how to join, so `joinGraph.ts` does a breadth-first search from the fact table to every table the query uses. It only walks relationships in the many → one direction. Going one → many would repeat each fact row once per match and inflate every sum, so that direction isn't an edge at all. If a table can't be reached safely you get `NoJoinPathError`. If it can be reached two equally short ways (for instance if `ship_date` were also related to `dim_calendar`) you get `AmbiguousJoinPathError`, because picking one would be a guess. Only the joins the query needs are emitted.

One consequence: `region != 'North'` also drops the orphan sale, because `NULL <> 'North'` isn't true in SQL. I think "not North" meaning "known to be some other region" is the right default, and a test pins it.

**Per-metric filters** become conditional aggregation: `SUM(CASE WHEN channel = 'Online' THEN revenue END)`. Putting the filter in `WHERE` would also remove the Retail rows that `total_revenue` needs, and both columns would say 420. I used `CASE` rather than `FILTER (WHERE ...)` because every engine supports it, and the result is the same since aggregates skip NULLs.

**Totals** use `GROUPING SETS ((region), ())` rather than `ROLLUP`. With two group columns `ROLLUP(a, b)` also produces a subtotal per `a`, and "grand" doesn't ask for that. The total row is found with `GROUPING()`, not `region IS NULL`, since a sale from an unknown store also has a NULL region and that row isn't the total. I return the total row as `region = NULL, is_total = true` instead of writing `'Total'` into the region column: a label could collide with a real region called "Total", and it wouldn't fit a non-text column like `fiscal_year`. The CLI adds the label, which is where I think it belongs.

**Compare.** Each period is its own conditional aggregate, and `WHERE fiscal_year IN (...)` limits the scan to those periods. `delta` is primary minus baseline, and `pct_change` is `delta / NULLIF(baseline, 0)`, returned as a ratio. A period with no rows for a group comes back as NULL rather than 0: the compiler can't tell "no sales" from "not loaded yet", so it doesn't pretend. A baseline of 0 gives a NULL `pct_change` and a normal `delta`.

**Period types.** The contract sends periods as strings (`"2025"`) but `fiscal_year` is an integer, and the semantic model doesn't declare column types. I'm not allowed to read the warehouse or guess, so the value goes into the SQL exactly as the contract typed it, as `'2025'`. Both engines handle that by design: DuckDB [lets a string literal be cast to any type](https://duckdb.org/docs/current/sql/data_types/literal_types.html), and Postgres [gives an untyped literal the type of the other operand](https://www.postgresql.org/docs/current/typeconv-oper.html). If the value couldn't be converted, the query would fail loudly instead of returning wrong numbers. With column types in the model I'd validate and convert at compile time instead; that's first on the list at the end.

**Refusing.** Anything the compiler doesn't understand is refused with a named error pointing at the field:

```
UnsupportedOperatorError: filters[0].op: unsupported operator 'LIKE' (supported: =, !=, <, <=, >, >=, in, not_in)
UnknownMetricError: metrics[0].name: unknown metric 'total_revnue' (known: total_revenue, order_count)
```

In production the caller is an LLM, and the path lets it fix one field instead of regenerating the whole contract. Unknown fields are refused too, not ignored. If the LLM sends `"limit": 10` and the compiler drops it, the user gets an answer that looks right and isn't.

| Error | When |
|---|---|
| `UnknownMetricError`, `UnknownDimensionError` | a name the model doesn't declare, including filtering on a column that isn't a dimension |
| `UnsupportedFeatureError` | unknown fields (`having`, `limit`, ...), `totals: "subtotal"`, delta across three periods, metrics from two fact tables |
| `UnsupportedOperatorError` | e.g. `LIKE` |
| `InvalidContractError` | malformed input, a filter on the dimension being compared, the compare dimension also in `group_by`, a `model` hint that disagrees with the model, `null` values (`x = NULL` never matches), integers too big for JSON to hold exactly |
| `DuplicateOutputError` | two result columns with the same name, e.g. the same metric twice without `as` |
| `NoJoinPathError`, `AmbiguousJoinPathError` | see Joins |
| `InvalidSemanticModelError` | when the model is loaded: `many_to_many`, an unknown agg, an expression like `revenue * 2` |
| `UnsupportedDialectError` | a dialect with no renderer |

## Dialects

The planner decides what a query means and the dialect decides how it's spelled. Sometimes a dialect has to rewrite something just to keep the meaning the same, and that's allowed too.

In practice DuckDB and Postgres differ in exactly one place, division. In DuckDB [`/` is always floating-point division](https://duckdb.org/docs/current/sql/functions/numeric.html), but in Postgres [integer division truncates](https://www.postgresql.org/docs/current/functions-math.html) (`5 / 2` is `2`). Revenue is a double, so contract B looks fine either way. The pct_change of `order_count` wouldn't: counts are integers, and going from 3 to 5 orders would show as 0% instead of 66.7%. So the Postgres dialect casts to `DOUBLE PRECISION` before dividing, and a test runs exactly that case on Postgres. Another test checks that contracts A and C compile to identical SQL for both dialects, and that B differs by that one line.

A Snowflake dialect would mostly be about identifier case (Snowflake upper-cases unquoted names, so quoting `"fact_sales"` wouldn't match a table created as `fact_sales`) and checking how it divides. Adding one doesn't touch the package:

```ts
new QueryCompiler(model, DEFAULT_DIALECTS.with(new SnowflakeDialect()));
```

## Adding a feature

A new contract field goes through the same places every time: parse it in `contract.ts` (until then it's rejected as an unknown field), resolve and check it in `binder.ts`, add a step in `plan/steps.ts`, and only touch the renderer if it needs a new kind of plan node. The existing steps don't change.

**`having`**, e.g. `"having": [{ "metric": "total_revenue", "op": ">", "value": 100 }]`. Stage 1 already has every aggregate by name, so this is a filter on stage 2: a `HavingStep` that adds `WHERE "total_revenue" > 100` to the outer query, plus one line in the renderer. The real question is the total row. `GROUPING SETS` computes it over every group, including the ones `having` hides, so it wouldn't match the visible rows. If the answer should be "total of what's shown", I'd recompute it from the base rows restricted to the groups that survived. Summing the visible rows would be wrong for distinct counts. Until that's decided I'd refuse `having` together with `totals`.

**Month-by-month trend**, e.g. `"group_by": [{ "dimension": "order_date", "grain": "month" }]`. This needs `order_date` declared as a time dimension, a new `dateTrunc` plan node that `GroupByStep` emits, and a dialect hook for it (`DATE_TRUNC('month', x)` in DuckDB and Postgres; BigQuery takes the arguments the other way round). Two things to get right. Months with no sales produce no row, so a chart would quietly skip them unless the query goes through a date spine like `dim_calendar`. And month-over-month change is a `LAG()` in stage 2, which has to leave the total row out.

## What breaks first at 10x the vocabulary

Each feature is one step, so adding a feature doesn't break the others. The interactions are what break: compare with having with totals with trends. Right now the step order is an unwritten rule (`GrandTotalStep` needs the group columns `GroupByStep` added). With ten times the features I'd have each step declare what it depends on and check the order. I'd also add property tests on random small datasets, comparing against a brute-force evaluator for the invariants that matter: an additive total equals the sum of its rows, a distinct total equals a recount, a ratio comes from its own row.

The fixed two-stage shape would go next. Windows, multi-fact queries (aggregate each fact on the shared dimensions, then join the results so nothing fans out), totals that respect `having`, and date spines all want another stage. At that point the plan should be a small tree of relational operators (scan, join, filter, aggregate, project, window), and today's two stages become one particular tree.

The hand-written parser would start drifting from the schema the LLM fills in. I'd generate the parser, the TypeScript types and the LLM's form from one schema. I'd also collect every error in a pass instead of stopping at the first, so the LLM can fix them in one round trip.

Generation time wouldn't be the problem. A BFS over a few hundred tables is still microseconds, and the model is indexed once when it's loaded.

## Generation times

From contract in to SQL string out, on an Apple M4 with Node 22.16: 10,000 calls per row after 1,000 warm-up calls (`npm run bench`). Times are in microseconds; the budget is 10,000.

| Contract | Dialect | Model | Median | p99 | Max |
|---|---|---|---:|---:|---:|
| A | duckdb | pre-loaded | 4.6 | 23.7 | 317.9 |
| A | duckdb | raw JSON | 6.0 | 29.0 | 394.1 |
| A | postgres | pre-loaded | 3.5 | 4.9 | 96.6 |
| A | postgres | raw JSON | 5.4 | 11.6 | 100.6 |
| B | duckdb | pre-loaded | 8.6 | 42.5 | 387.2 |
| B | duckdb | raw JSON | 9.0 | 12.0 | 97.9 |
| B | postgres | pre-loaded | 7.0 | 9.1 | 110.2 |
| B | postgres | raw JSON | 9.0 | 11.5 | 108.2 |
| C | duckdb | pre-loaded | 3.1 | 4.5 | 87.6 |
| C | duckdb | raw JSON | 5.0 | 6.6 | 91.7 |
| C | postgres | pre-loaded | 3.1 | 4.0 | 98.2 |
| C | postgres | raw JSON | 5.0 | 6.7 | 94.3 |

The median is 3 to 9 µs. The occasional slow call, up to about 0.4 ms, is garbage collection or the JIT, and p99 moves around between runs. The first call in a fresh process takes about 1.1 ms because V8 hasn't optimised anything yet, and loading the module takes about 8 ms, once per process. Passing the raw model JSON costs up to 2 µs more per call than a pre-loaded `SemanticModel`. The plan checks in `PlanBuilder.build()` cost about 1 µs; I measured that by switching them off, and kept them. `test/performance.test.ts` asserts p99 under 10 ms with plenty of headroom so it doesn't flake on slow machines.

## What I cut, and what I'd do next

Not supported, and refused with a named error rather than half done: `having`, `order_by` / `limit`, subtotals, time grains, `OR` filters, null checks, metric expressions other than a bare column, metrics from more than one fact table, role-playing dimensions (order date and ship date on the same calendar), and a Snowflake dialect.

Next, in this order:

1. Column types in the semantic model, so literals are typed and values are checked at compile time.
2. Multi-fact queries: aggregate each fact on the shared dimensions, then join the aggregates.
3. The reference evaluator and property tests described above.
4. Role-playing dimensions: let the model or the contract name the path (`"via": "ship_date"`) and alias the table for each role.
5. Report every error in one pass.

## Layout

```
semantic_model.json, contracts/   from the brief, unchanged
data/seed.sql                     schema and data (DOUBLE -> DOUBLE PRECISION so Postgres accepts it)
src/
  compiler.ts                     QueryCompiler and compileContract
  contract.ts                     parse
  binder.ts                       bind
  model/                          semantic model and join graph
  plan/                           plan: IR, steps, layouts, builder
  render/                         SqlRenderer, Dialect, DuckDB, Postgres, registry
  json.ts, errors.ts              reading untrusted JSON; the named errors
  cli.ts, databases.ts            the command line, and connections for running SQL (not used by the compiler)
test/                             one file per concern; result tests run on DuckDB and Postgres
Dockerfile, compose.yaml          the same, in containers, with a real Postgres server
```
