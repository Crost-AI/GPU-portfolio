-- Forecast, phase 2 (plans/plan-unified-plan.md §1.3): fees and expenses are the plan's.
--
-- A fund's management fee becomes a rule on the plan — `management_fee`: rate, basis (committed,
-- invested, NAV), term, step-down — evaluated on the fee-paying share of commitments (the GP's own
-- stake exempt). Portfolio construction reads it rather than holding fee inputs of its own.
-- Widening only: safe to apply before the release that writes it.
alter table public.forecast_rules drop constraint if exists forecast_rules_method_check;
alter table public.forecast_rules
  add constraint forecast_rules_method_check check (method in (
    'manual', 'fixed', 'recurring', 'run_rate', 'growth', 'seasonal', 'linked_fee', 'linked_construction', 'management_fee'
  ));
