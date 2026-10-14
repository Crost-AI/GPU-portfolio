-- The latest reported value per metric, and the latest reporting period per company.
--
-- "Latest" means the latest PERIOD, not the latest import. The readers these views replace ordered
-- by `period_year desc, created_at desc`, so within a year the row imported last won: import
-- September's cash, backfill February's, and February became "latest cash" while the dashboard's
-- last-period label still said September. They also pulled a metric's whole history to keep one row,
-- which the 1,000-row PostgREST cap could truncate before the latest row arrived.
--
-- A row's period is normalised to the day it ends: a monthly row at month end, a quarterly row at
-- quarter end, an annual row at 31 December — so Q3 (30 Sep) beats August (31 Aug), and a monthly
-- row that also carries its quarter is still read as the month. created_at only breaks a tie
-- between rows ending the same day (a re-import of the same period). lib/metrics/period-end.ts
-- mirrors the expression; keep the two in step.
--
-- security_invoker: the views read metric_values as the CALLER, so its RLS policies ("metric_values
-- read needs portfolio") still decide which rows anyone sees. Without it a view runs as its owner
-- and would bypass them. The dashboard reads these with the user's client.

create or replace view public.metric_values_latest
with (security_invoker = true) as
select distinct on (metric_id)
  id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month,
  value_number, value_text, created_at,
  (make_date(period_year, coalesce(period_month, period_quarter * 3, 12), 1)
    + interval '1 month' - interval '1 day')::date as period_end
from public.metric_values
where value_number is not null
order by metric_id,
  (make_date(period_year, coalesce(period_month, period_quarter * 3, 12), 1)
    + interval '1 month' - interval '1 day')::date desc,
  created_at desc;

-- Any metric, numeric or text: the period a company last reported anything for.
create or replace view public.metric_values_latest_by_company
with (security_invoker = true) as
select distinct on (company_id)
  company_id, fund_id, period_year, period_quarter, period_month,
  (make_date(period_year, coalesce(period_month, period_quarter * 3, 12), 1)
    + interval '1 month' - interval '1 day')::date as period_end
from public.metric_values
order by company_id,
  (make_date(period_year, coalesce(period_month, period_quarter * 3, 12), 1)
    + interval '1 month' - interval '1 day')::date desc,
  created_at desc;

-- Grants — required from 2026-05-30 onward for the Data API to see a relation. Read-only views;
-- the base table's RLS (via security_invoker) scopes the rows each role gets back.
grant select on public.metric_values_latest to anon, authenticated, service_role;
grant select on public.metric_values_latest_by_company to anon, authenticated, service_role;
