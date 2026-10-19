-- Fleet scenarios in the forecast (GPU SPV, gpu-P4 B1). A scenario is a forecast plan on a gpu_spv
-- vehicle; its fleet assumptions (lib/gpu/scenario.ts FleetAssumptions) live on the plan, and a
-- published version freezes them with the rest of the plan.
--
--   forecast_plans.fleet     the plan's fleet assumptions; null on every plan that is not a fleet scenario
--   forecast_versions.fleet  the fleet a version was published with
--   linked_fleet             a rule method whose monthly amounts come from the fleet scenario engine
--
-- ADDITIVE, AND SAFE TO APPLY BEFORE THE RELEASE THAT WRITES IT. Two nullable columns no current code
-- reads; a method check that only widens; forecast_save restated with the same signature and one
-- more patch key ('fleet'), which the deployed release never sends, so its saves are unchanged;
-- forecast_publish with one more trailing parameter, DEFAULT null, so the deployed release's call
-- with the twelve named parameters it sends today resolves to the new signature and freezes
-- v_plan.fleet (null for all its plans). The twelve-argument signature is dropped first, as
-- 20261011100000 dropped the ten-argument one: left beside the new one, that call would match both
-- and fail as ambiguous. Same privileges as before: SECURITY INVOKER, service_role only.
--
-- No table is created, so no Data API grants are needed: the existing grants on forecast_plans and
-- forecast_versions cover the new columns.

alter table public.forecast_plans
  add column if not exists fleet jsonb;

alter table public.forecast_versions
  add column if not exists fleet jsonb;

alter table public.forecast_rules drop constraint if exists forecast_rules_method_check;
alter table public.forecast_rules
  add constraint forecast_rules_method_check check (method in (
    'manual', 'fixed', 'recurring', 'run_rate', 'growth', 'seasonal', 'linked_fee', 'linked_construction', 'management_fee',
    'linked_fleet'
  ));

-- forecast_save: as 20261010400000, plus the plan's fleet in the patch.
create or replace function public.forecast_save(
  p_plan_id            uuid,
  p_fund_id            uuid,
  p_expected_revision  integer,
  p_plan_patch         jsonb,
  p_rule_upserts       jsonb,
  p_rule_deletes       uuid[],
  p_override_upserts   jsonb,
  p_override_deletes   uuid[],
  p_entries            jsonb,
  p_compiled           jsonb
)
returns integer
language plpgsql
set search_path = public
as $$
declare
  v_plan public.forecast_plans%rowtype;
  v_entry jsonb;
  v_entry_id uuid;
begin
  select * into v_plan from public.forecast_plans
   where id = p_plan_id and fund_id = p_fund_id
   for update;
  if not found then
    raise exception 'Plan not found' using errcode = 'PT404';
  end if;
  if v_plan.revision <> p_expected_revision then
    raise exception 'The plan changed since you loaded it (revision % is now %). Reload and try again.',
      p_expected_revision, v_plan.revision using errcode = 'PT409';
  end if;

  if p_plan_patch is not null and p_plan_patch <> '{}'::jsonb then
    update public.forecast_plans set
      name           = case when p_plan_patch ? 'name' then p_plan_patch ->> 'name' else name end,
      scenario       = case when p_plan_patch ? 'scenario' then p_plan_patch ->> 'scenario' else scenario end,
      start_month    = case when p_plan_patch ? 'start_month' then (p_plan_patch ->> 'start_month')::date else start_month end,
      end_month      = case when p_plan_patch ? 'end_month' then (p_plan_patch ->> 'end_month')::date else end_month end,
      horizon_months = case when p_plan_patch ? 'horizon_months' then (p_plan_patch ->> 'horizon_months')::integer else horizon_months end,
      actuals_cutoff = case when p_plan_patch ? 'actuals_cutoff' then (p_plan_patch ->> 'actuals_cutoff')::date else actuals_cutoff end,
      status         = case when p_plan_patch ? 'status' then p_plan_patch ->> 'status' else status end,
      include_construction = case when p_plan_patch ? 'include_construction'
                                  then (p_plan_patch ->> 'include_construction')::boolean
                                  else include_construction end,
      opening_settlement_months = case when p_plan_patch ? 'opening_settlement_months'
                                       then (p_plan_patch ->> 'opening_settlement_months')::integer
                                       else opening_settlement_months end,
      adjustments    = case when p_plan_patch ? 'adjustments' then p_plan_patch -> 'adjustments' else adjustments end,
      construction   = case when p_plan_patch ? 'construction' then p_plan_patch -> 'construction' else construction end,
      capital        = case when p_plan_patch ? 'capital' then p_plan_patch -> 'capital' else capital end,
      fleet          = case when p_plan_patch ? 'fleet' then p_plan_patch -> 'fleet' else fleet end
    where id = p_plan_id;
  end if;

  if p_rule_deletes is not null and array_length(p_rule_deletes, 1) > 0 then
    delete from public.forecast_rules where plan_id = p_plan_id and id = any(p_rule_deletes);
  end if;
  if p_rule_upserts is not null and jsonb_array_length(p_rule_upserts) > 0 then
    insert into public.forecast_rules (id, plan_id, fund_id, vehicle_id, account_id, method, params, cash_timing, source, note)
    select r.id, p_plan_id, p_fund_id, v_plan.vehicle_id, r.account_id, r.method, r.params,
           coalesce(r.cash_timing, '{"mode":"same"}'::jsonb), coalesce(r.source, 'user'), r.note
      from jsonb_to_recordset(p_rule_upserts)
        as r(id uuid, account_id uuid, method text, params jsonb, cash_timing jsonb, source text, note text)
    on conflict (plan_id, account_id) do update set
      method = excluded.method, params = excluded.params, cash_timing = excluded.cash_timing,
      source = excluded.source, note = excluded.note, updated_at = now();
  end if;

  if p_override_deletes is not null and array_length(p_override_deletes, 1) > 0 then
    delete from public.forecast_overrides where plan_id = p_plan_id and id = any(p_override_deletes);
  end if;
  if p_override_upserts is not null and jsonb_array_length(p_override_upserts) > 0 then
    insert into public.forecast_overrides (id, plan_id, fund_id, vehicle_id, account_id, month, amount, note)
    select o.id, p_plan_id, p_fund_id, v_plan.vehicle_id, o.account_id, o.month, o.amount, o.note
      from jsonb_to_recordset(p_override_upserts)
        as o(id uuid, account_id uuid, month date, amount numeric, note text)
    on conflict (plan_id, account_id, month) do update set amount = excluded.amount, note = excluded.note;
  end if;

  -- The draft is rebuilt whole: it is a function of the inputs, never edited in place.
  delete from public.forecast_entries where plan_id = p_plan_id and version_id is null;
  for v_entry in select * from jsonb_array_elements(coalesce(p_entries, '[]'::jsonb)) loop
    insert into public.forecast_entries (plan_id, version_id, fund_id, vehicle_id, entry_date, kind, memo, account_id, rule_id, override_id, source)
    values (p_plan_id, null, p_fund_id, v_plan.vehicle_id, (v_entry ->> 'entry_date')::date, v_entry ->> 'kind',
            v_entry ->> 'memo', (v_entry ->> 'account_id')::uuid, (v_entry ->> 'rule_id')::uuid,
            (v_entry ->> 'override_id')::uuid, v_entry ->> 'source')
    returning id into v_entry_id;
    insert into public.forecast_postings (entry_id, fund_id, account_id, amount, currency)
    select v_entry_id, p_fund_id, p.account_id, p.amount, p.currency
      from jsonb_to_recordset(v_entry -> 'postings') as p(account_id uuid, amount numeric, currency text);
  end loop;

  update public.forecast_plans set
    revision = revision + 1,
    compiled_at = now(),
    compiled_cutoff = (p_compiled ->> 'cutoff')::date,
    compiled_closed_through = (p_compiled ->> 'closed_through')::date,
    updated_at = now()
  where id = p_plan_id;

  return v_plan.revision + 1;
end;
$$;

revoke all on function public.forecast_save(uuid, uuid, integer, jsonb, jsonb, uuid[], jsonb, uuid[], jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.forecast_save(uuid, uuid, integer, jsonb, jsonb, uuid[], jsonb, uuid[], jsonb, jsonb) to service_role;

-- forecast_publish: as 20261011100000, plus p_fleet (default: the locked plan row's fleet).
drop function if exists public.forecast_publish(uuid, uuid, integer, text, text, text, uuid, jsonb, jsonb, jsonb, jsonb, jsonb);

create or replace function public.forecast_publish(
  p_plan_id            uuid,
  p_fund_id            uuid,
  p_expected_revision  integer,
  p_status             text,
  p_label              text,
  p_notes              text,
  p_user_id            uuid,
  p_meta               jsonb,
  p_inputs             jsonb,
  p_entries            jsonb,
  p_construction       jsonb default null,
  p_capital            jsonb default null,
  p_fleet              jsonb default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_plan public.forecast_plans%rowtype;
  v_version_id uuid;
  v_version_no integer;
  v_entry jsonb;
  v_entry_id uuid;
begin
  select * into v_plan from public.forecast_plans
   where id = p_plan_id and fund_id = p_fund_id
   for update;
  if not found then
    raise exception 'Plan not found' using errcode = 'PT404';
  end if;
  if v_plan.revision <> p_expected_revision then
    raise exception 'The plan changed since you loaded it (revision % is now %). Reload and try again.',
      p_expected_revision, v_plan.revision using errcode = 'PT409';
  end if;
  if p_status = 'approved' and exists (
    select 1 from public.forecast_versions where plan_id = p_plan_id and status = 'approved'
  ) then
    raise exception 'This plan already has an approved baseline. Publish a revision instead.' using errcode = 'PT409';
  end if;

  select coalesce(max(version_no), 0) + 1 into v_version_no from public.forecast_versions where plan_id = p_plan_id;

  insert into public.forecast_versions (plan_id, fund_id, vehicle_id, version_no, label, notes, status,
                                        actuals_cutoff, closed_through, start_month, end_month, inputs, published_by,
                                        construction, capital, fleet)
  values (p_plan_id, p_fund_id, v_plan.vehicle_id, v_version_no, p_label, p_notes, p_status,
          (p_meta ->> 'cutoff')::date, (p_meta ->> 'closed_through')::date,
          v_plan.start_month, v_plan.end_month, p_inputs, p_user_id,
          coalesce(p_construction, v_plan.construction), coalesce(p_capital, v_plan.capital, '{}'::jsonb),
          coalesce(p_fleet, v_plan.fleet))
  returning id into v_version_id;

  for v_entry in select * from jsonb_array_elements(coalesce(p_entries, '[]'::jsonb)) loop
    insert into public.forecast_entries (plan_id, version_id, fund_id, vehicle_id, entry_date, kind, memo, account_id, rule_id, override_id, source)
    values (p_plan_id, v_version_id, p_fund_id, v_plan.vehicle_id, (v_entry ->> 'entry_date')::date, v_entry ->> 'kind',
            v_entry ->> 'memo', (v_entry ->> 'account_id')::uuid, (v_entry ->> 'rule_id')::uuid,
            (v_entry ->> 'override_id')::uuid, v_entry ->> 'source')
    returning id into v_entry_id;
    insert into public.forecast_postings (entry_id, fund_id, account_id, amount, currency)
    select v_entry_id, p_fund_id, p.account_id, p.amount, p.currency
      from jsonb_to_recordset(v_entry -> 'postings') as p(account_id uuid, amount numeric, currency text);
  end loop;

  return jsonb_build_object('id', v_version_id, 'versionNo', v_version_no);
end;
$$;

revoke all on function public.forecast_publish(uuid, uuid, integer, text, text, text, uuid, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.forecast_publish(uuid, uuid, integer, text, text, text, uuid, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb) to service_role;
