-- A published forecast version freezes BOTH halves of its plan: the construction it assumed (deals,
-- exits, pacing) and its capital policy (calls, distributions). forecast_versions gained those
-- columns in 20261010400000, and the service then tried to fill them with an UPDATE after
-- forecast_publish — which the forecast_versions_immutable trigger refuses, every time. The error
-- was ignored, so every version was saved with construction and capital null.
--
-- Fix: forecast_publish writes them in its INSERT. Two new parameters, both DEFAULT null, so the
-- release deployed before this one (which calls with the ten original named parameters) keeps
-- working when this migration is applied first; with them null the function freezes the plan row
-- it has locked — the same values the service would have sent, read in the same transaction.
--
-- The old ten-argument signature is dropped in the same migration: left beside the new one, a call
-- with the ten original named arguments would match both and fail as ambiguous. With only the new
-- signature, that call resolves to it (defaults fill the rest). Same privileges as before:
-- SECURITY INVOKER, service_role only.

drop function if exists public.forecast_publish(uuid, uuid, integer, text, text, text, uuid, jsonb, jsonb, jsonb);

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
  p_capital            jsonb default null
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
                                        construction, capital)
  values (p_plan_id, p_fund_id, v_plan.vehicle_id, v_version_no, p_label, p_notes, p_status,
          (p_meta ->> 'cutoff')::date, (p_meta ->> 'closed_through')::date,
          v_plan.start_month, v_plan.end_month, p_inputs, p_user_id,
          coalesce(p_construction, v_plan.construction), coalesce(p_capital, v_plan.capital, '{}'::jsonb))
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

revoke all on function public.forecast_publish(uuid, uuid, integer, text, text, text, uuid, jsonb, jsonb, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.forecast_publish(uuid, uuid, integer, text, text, text, uuid, jsonb, jsonb, jsonb, jsonb, jsonb) to service_role;
