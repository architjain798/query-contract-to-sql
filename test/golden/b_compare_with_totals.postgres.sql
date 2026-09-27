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
  CAST("total_revenue_2026" - "total_revenue_2025" AS DOUBLE PRECISION) / NULLIF("total_revenue_2025", 0) AS "total_revenue_pct_change"
FROM "aggregated"
ORDER BY "is_total" ASC NULLS LAST, "region" ASC NULLS LAST
