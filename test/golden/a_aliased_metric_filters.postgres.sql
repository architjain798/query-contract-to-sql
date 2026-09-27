WITH "aggregated" AS (
  SELECT
    SUM(CASE WHEN "fact_sales"."channel" = 'Online' THEN "fact_sales"."revenue" END) AS "online_rev",
    SUM("fact_sales"."revenue") AS "total_revenue"
  FROM "fact_sales"
  LEFT JOIN "dim_calendar" ON "fact_sales"."order_date" = "dim_calendar"."date"
  WHERE "dim_calendar"."fiscal_year" = 2026
)
SELECT
  "online_rev",
  "total_revenue"
FROM "aggregated"
