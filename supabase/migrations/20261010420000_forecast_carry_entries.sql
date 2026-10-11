-- Forecast, phase 3 (plans/plan-unified-plan.md §1.4): capital management is the fund forecast's.
--
-- Calls and distributions are worked out monthly on the plan (its cash, a reserve, a payout lag,
-- month edits — forecast_plans.capital), and the waterfall runs on what is actually distributed. The
-- carry a distribution pays the GP is its own entry, `carry_distribution`, so a GP entity's forecast
-- can read the fund plan's carry month by month. Widening only: safe before or after the release.
alter table public.forecast_entries drop constraint if exists forecast_entries_kind_check;
alter table public.forecast_entries
  add constraint forecast_entries_kind_check check (kind in (
    'recognition', 'settlement', 'prepayment', 'release',
    'investment', 'proceeds', 'capital_call', 'distribution', 'carry_distribution'
  ));
