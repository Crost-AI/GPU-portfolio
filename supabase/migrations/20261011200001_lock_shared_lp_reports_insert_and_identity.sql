-- Close the gaps in the shared-report lock (20261010200002_lock_shared_lp_reports.sql).
--
-- That trigger fired `before update or delete` and looked only at OLD.snapshot_id, so:
--   * an INSERT could add a position to a report investors had already been shown;
--   * an UPDATE could move a row INTO a shared report (old snapshot unshared, new one shared);
--   * a row in a shared report could be re-pointed at a different LP entity, which hands the
--     figures one investor was shown to another.
-- Now: no insert into a shared report; a row in, or moving into, a shared report cannot change
-- report, fund, entity or figures; deletes as before.
--
-- Still allowed, deliberately, for now: a change to portfolio_group. A vehicle rename or merge
-- relabels every row (lib/vehicles.ts retagPortfolioGroup, via app/api/vehicles PATCH), and the
-- deployed release does that with a plain UPDATE whose error it ignores — refusing it here would
-- not fail visibly, it would leave shared rows under the old name. This migration adds
-- lp_retag_portfolio_group(), which marks the relabel with a transaction-local setting; once the
-- release that calls it is live, supabase/pending-deploy/lock_shared_lp_reports_vehicle.sql locks
-- portfolio_group on shared rows to that path only.
--
-- Nothing in the app updates lp_investments.entity_id (no LP-entity merge re-points rows; the
-- investor merge moves lp_entities.investor_id), and the investments PUT route now refuses it on a
-- shared row with a 409 before it gets here. Cascades (deleting an LP entity, the fund) are one
-- trigger level down and pass, as before.

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

drop trigger if exists lp_investments_locked_when_shared on public.lp_investments;
create trigger lp_investments_locked_when_shared
  before insert or update or delete on public.lp_investments
  for each row execute function public.lp_investments_locked_when_shared();

-- The one sanctioned way to relabel a vehicle's LP rows, shared reports included. The setting is
-- transaction-local (set_config(..., true)), so it covers this function's UPDATE and nothing after
-- the RPC's transaction ends. SECURITY INVOKER and service_role only: it runs with the caller's own
-- rights and the browser roles cannot reach it.
create or replace function public.lp_retag_portfolio_group(p_fund_id uuid, p_from text, p_to text)
returns integer language plpgsql security invoker set search_path = '' as $$
declare
  n integer;
begin
  if p_fund_id is null or p_from is null or p_to is null or p_from = p_to then
    return 0;
  end if;
  perform set_config('app.lp_vehicle_retag', 'on', true);
  update public.lp_investments set portfolio_group = p_to
   where fund_id = p_fund_id and portfolio_group = p_from;
  get diagnostics n = row_count;
  perform set_config('app.lp_vehicle_retag', 'off', true);
  return n;
end $$;
revoke execute on function public.lp_retag_portfolio_group(uuid, text, text) from public, anon, authenticated;
grant execute on function public.lp_retag_portfolio_group(uuid, text, text) to service_role;
