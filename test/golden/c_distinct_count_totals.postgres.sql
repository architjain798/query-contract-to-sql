WITH "aggregated" AS (
  SELECT
    "dim_store"."region" AS "region",
    GROUPING("dim_store"."region") <> 0 AS "is_total",
    COUNT(DISTINCT "fact_sales"."order_id") AS "order_count"
  FROM "fact_sales"
  LEFT JOIN "dim_store" ON "fact_sales"."store_id" = "dim_store"."store_id"
  GROUP BY GROUPING SETS (("dim_store"."region"), ())
)
SELECT
  "region",
  "is_total",
  "order_count"
FROM "aggregated"
ORDER BY "is_total" ASC NULLS LAST, "region" ASC NULLS LAST
