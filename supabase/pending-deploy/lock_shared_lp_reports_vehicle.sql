-- PENDING DEPLOY — do not move into supabase/migrations/ until this release is live:
--
--   The release in which lib/vehicles.ts `retagPortfolioGroup` rewrites `lp_investments` through
--   `admin.rpc('lp_retag_portfolio_group', { p_fund_id, p_from, p_to })` (added by
--   20261011200001_lock_shared_lp_reports_insert_and_identity.sql) instead of a plain
--   `.from('lp_investments').update({ portfolio_group })`, and checks that call's error.
--
-- Why it must wait: the deployed retagPortfolioGroup relabels lp_investments with a plain UPDATE
-- and ignores the error. Applied before that change ships, this lock would make every vehicle
-- rename or merge in a fund with a shared report silently skip ALL of that vehicle's LP rows
-- (one statement, so one shared row fails the lot) while the vehicle itself is renamed.
--
-- When moving it: rename to a current timestamp, e.g. supabase/migrations/<now>_lock_shared_lp_reports_vehicle.sql.
--
-- What it does: on a row in a shared report, portfolio_group may change only inside
-- lp_retag_portfolio_group() (transaction-local `app.lp_vehicle_retag = on`). A one-off edit that
-- re-files a single shared position under another vehicle is refused. Otherwise identical to the
-- function in 20261011200001.

create or replace function public.lp_investments_locked_when_shared()
returns trigger language plpgsql set search_path = '' as $$
begin
  if pg_trigger_depth() > 1 then
    return coalesce(new, old);
  end if;
  if tg_op = 'INSERT' then
    if public.lp_report_is_shared(new.snapshot_id) then
      raise exception 'This report is shared with investors. Unshare it before adding positions to it.';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    if public.lp_report_is_shared(old.snapshot_id) then
      raise exception 'This position is in a report shared with investors. Unshare the report before deleting it.';
    end if;
    return old;
  end if;
  if not (public.lp_report_is_shared(old.snapshot_id) or public.lp_report_is_shared(new.snapshot_id)) then
    return new;
  end if;
  if new.snapshot_id is distinct from old.snapshot_id
    or new.fund_id is distinct from old.fund_id then
    raise exception 'This position is in a report shared with investors. Positions cannot be moved into or out of a shared report.';
  end if;
  if new.entity_id is distinct from old.entity_id then
    raise exception 'This position is in a report shared with investors. Unshare the report before changing whose position it is.';
  end if;
  if new.portfolio_group is distinct from old.portfolio_group
    and coalesce(current_setting('app.lp_vehicle_retag', true), '') <> 'on' then
    raise exception 'This position is in a report shared with investors. Its vehicle changes only with a vehicle rename or merge.';
  end if;
  if new.commitment is distinct from old.commitment
    or new.paid_in_capital is distinct from old.paid_in_capital
    or new.distributions is distinct from old.distributions
    or new.nav is distinct from old.nav
    or new.called_capital is distinct from old.called_capital
    or new.total_value is distinct from old.total_value
    or new.outstanding_balance is distinct from old.outstanding_balance
    or new.dpi is distinct from old.dpi
    or new.rvpi is distinct from old.rvpi
    or new.tvpi is distinct from old.tvpi
    or new.irr is distinct from old.irr then
    raise exception 'This position is in a report shared with investors. Unshare the report before changing its figures.';
  end if;
  return new;
end $$;
revoke execute on function public.lp_investments_locked_when_shared() from public, anon, authenticated;
