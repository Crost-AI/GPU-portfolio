-- The firm overview's per-entity book counts in one round trip.
--
-- lib/accounting/firm-load.ts used to run six queries per vehicle (closed periods, posted and
-- draft entry counts, first and last posted entry, open bank rows) — on top of the ledger reads,
-- serially per vehicle, so twenty entities cost some two hundred requests. This answers all six
-- for every requested vehicle at once, with the same filters: journal entries on the actual book
-- only, bank rows not yet categorised or reconciled, and the latest CLOSED period end.
--
-- One row per requested vehicle (driven by unnest, left-joined), so an entity with an empty ledger
-- still comes back, with zero counts and null dates.
--
-- Locked to the service role. It is SECURITY DEFINER and reads ledger data for whatever fund and
-- vehicles it is handed, with no domain or entity check of its own; the only caller
-- (loadFirmOverview, behind /api/accounting/firm) holds the service-role key and has already
-- decided which entities the viewer may see. A revoke from PUBLIC alone would leave Supabase's
-- direct grants to anon and authenticated in place (see 20261011200000).

create or replace function public.firm_vehicle_counts(p_fund_id uuid, p_vehicle_ids uuid[])
returns table (
  vehicle_id       uuid,
  posted_entries   bigint,
  draft_entries    bigint,
  open_bank_rows   bigint,
  first_entry_date date,
  last_entry_date  date,
  closed_through   date
)
language sql
stable
security definer
set search_path = public
as $$
  select
    v.id,
    coalesce(je.posted, 0),
    coalesce(je.drafts, 0),
    coalesce(bt.open_rows, 0),
    je.first_entry,
    je.last_entry,
    fp.closed_through
  from unnest(p_vehicle_ids) as v(id)
  left join (
    select
      j.vehicle_id,
      count(*) filter (where j.status = 'posted')          as posted,
      count(*) filter (where j.status = 'draft')           as drafts,
      min(j.entry_date) filter (where j.status = 'posted') as first_entry,
      max(j.entry_date) filter (where j.status = 'posted') as last_entry
    from public.journal_entries j
    where j.fund_id = p_fund_id and j.book = 'actual' and j.vehicle_id = any(p_vehicle_ids)
    group by j.vehicle_id
  ) je on je.vehicle_id = v.id
  left join (
    select b.vehicle_id, count(*) as open_rows
    from public.bank_transactions b
    where b.fund_id = p_fund_id and b.vehicle_id = any(p_vehicle_ids) and b.status in ('unmatched', 'drafted')
    group by b.vehicle_id
  ) bt on bt.vehicle_id = v.id
  left join (
    select f.vehicle_id, max(f.period_end) as closed_through
    from public.fiscal_periods f
    where f.fund_id = p_fund_id and f.vehicle_id = any(p_vehicle_ids) and f.status = 'closed'
    group by f.vehicle_id
  ) fp on fp.vehicle_id = v.id
$$;

revoke execute on function public.firm_vehicle_counts(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.firm_vehicle_counts(uuid, uuid[]) to service_role;
