-- A rolling forecast may run up to 240 months (20 years): a fund's life is 12–15 years with
-- extensions, and the 120-month cap stopped a plan from covering it. The app caps the plan window and
-- horizonMonths at the same 240 (lib/forecast/service.ts MAX_PLAN_MONTHS), the same as the series view.
--
-- Widening a check is safe to apply before the release that uses it: the deployed code still refuses
-- anything over 120 itself, and every existing row satisfies the wider bound.

alter table public.forecast_plans drop constraint if exists forecast_plans_horizon_months_check;
alter table public.forecast_plans
  add constraint forecast_plans_horizon_months_check check (horizon_months between 1 and 240);
