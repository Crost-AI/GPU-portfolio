-- The distributable-cash waterfall for GPU SPVs: its terms, what a declaration freezes, the
-- distribution cadence, and the gross-revenue management fee.
--
-- Additive. Safe before the code ships. Do not set kind = 'distributable_cash' on any row until the
-- release containing the waterfall wiring is deployed: an older release maps it to 'none'.
--
-- The engine is lib/gpu/waterfall.ts: preferred return on UNRETURNED capital (simple, a shortfall
-- carried forward without compounding), then return of capital, then the split. No catch-up.

-- 1. Terms. The kind becomes sayable, and three columns describe this kind's tiers. Defaults leave
--    every existing row's behaviour unchanged (the fund waterfalls ignore all three).
alter table public.vehicle_waterfall_terms
  drop constraint if exists vehicle_waterfall_terms_kind_check;

alter table public.vehicle_waterfall_terms
  add constraint vehicle_waterfall_terms_kind_check
  check (kind in ('none', 'straight', 'american', 'european', 'distributable_cash'));

alter table public.vehicle_waterfall_terms
  add column if not exists pref_basis text not null default 'contributed'
    check (pref_basis in ('contributed', 'unreturned')),
  add column if not exists pref_day_count text not null default '30_360'
    check (pref_day_count in ('act_365', '30_360', 'periodic')),
  add column if not exists roc_lp_share numeric not null default 1
    check (roc_lp_share > 0 and roc_lp_share <= 1);

comment on column public.vehicle_waterfall_terms.pref_day_count is
  'distributable_cash only. 30_360 is 30E/360 (European): additive across any split of a period.';

-- 2. What a declaration freezes, for the register and the notice. Null on every row that is not a
--    distributable-cash waterfall.
alter table public.distributions
  -- Unspent capex contingency returned ahead of the tiers (R8): investors only, no carry.
  add column if not exists wf_contingency_return numeric,
  add column if not exists wf_profit_lp numeric,
  add column if not exists wf_pref_carried_forward numeric,
  add column if not exists wf_unreturned_after numeric,
  add column if not exists reserve_amount numeric,
  -- The profit share REALISED at declaration (Dr each investor's capital, Cr the recipients'):
  -- a GPU SPV accrues no carry at the close (Karl, R4), so without it the carry_distribution
  -- would leave the recipient's capital negative and the investors' overstated.
  add column if not exists carry_realized_journal_entry_id uuid references public.journal_entries(id) on delete set null;

-- 3. How often the vehicle distributes. The reserve default is not stored: it is the newest
--    declared row's reserve_amount.
alter table public.vehicle_accounting_settings
  add column if not exists distribution_cadence text not null default 'quarterly'
    check (distribution_cadence in ('monthly', 'quarterly', 'annual', 'ad_hoc'));

-- 4. Fee terms. A GPU SPV's fee is a share of gross rental revenue, accrued at the close; the other
--    bases are here so a fund can move its fee onto the same table later.
create table if not exists public.vehicle_fee_terms (
  id               uuid primary key default gen_random_uuid(),
  fund_id          uuid not null references public.funds(id) on delete cascade,
  vehicle_id       uuid not null unique references public.fund_vehicles(id) on delete cascade,
  basis            text not null check (basis in ('committed', 'invested', 'nav', 'gross_revenue')),
  annual_rate      numeric(6,4) not null check (annual_rate >= 0 and annual_rate < 1),
  revenue_subtypes text[] not null default '{rental_revenue}',
  frequency        text not null default 'monthly' check (frequency in ('monthly', 'quarterly')),
  -- The management company, when the fee is booked intercompany; null books it to 2100.
  payee_vehicle_id uuid references public.fund_vehicles(id) on delete set null,
  effective_from   date not null,
  effective_to     date,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (payee_vehicle_id is null or payee_vehicle_id <> vehicle_id),
  check (effective_to is null or effective_to >= effective_from)
);

create index if not exists vehicle_fee_terms_fund_idx on public.vehicle_fee_terms (fund_id);

-- Grants: service_role ONLY. The only readers are the gated fee-terms route and the close, both
-- holding the service-role key; a grant to authenticated would hand fee terms to members the
-- `accounting` gate refuses. Projects created before the 2026 Data API change still grant new
-- tables to anon/authenticated by default, so take those back explicitly.
revoke all on public.vehicle_fee_terms from anon, authenticated;
grant select, insert, update, delete on public.vehicle_fee_terms to service_role;

-- RLS on with no authenticated policies: denied by default if a grant ever creeps back.
alter table public.vehicle_fee_terms enable row level security;
create policy "vehicle_fee_terms service role"
  on public.vehicle_fee_terms for all to service_role
  using (true) with check (true);

-- 4b. A management fee rebate: the management company handing back part of a fee already charged
--     (a GPU SPV's fee true-up after revenue is reversed). Additive; an older release never writes it.
alter table public.intercompany_transactions
  drop constraint if exists intercompany_transactions_kind_check;
alter table public.intercompany_transactions
  add constraint intercompany_transactions_kind_check
  check (kind in ('management_fee', 'expense_reimbursement', 'allocated_cost', 'loan_advance', 'loan_repayment', 'other', 'management_fee_rebate'));

-- Which system process raised a charge, e.g. gpu-fee:<vehicle>:<YYYY-MM> for a GPU SPV's monthly
-- fee. The fee true-up finds its own charges by this, never by the memo, which a person can edit.
-- Null on every charge raised by hand.
alter table public.intercompany_transactions
  add column if not exists source_ref text;
create index if not exists intercompany_transactions_source_ref
  on public.intercompany_transactions (fund_id, source_ref) where source_ref is not null;

-- 5. A distribution's third entry: the profit share realised at declaration (see column above).
--    The register functions link, publish and clean up all three entries together. Restated in
--    full from 20261006174407 / 20261006164431; the only changes are the third id in each linked
--    set, the cleanup's source types, and the recipient check reading the distribution and carry
--    entries only (the realised entry moves capital between partners; it pays nobody). With the
--    column null, as on every row an older release writes, each behaves exactly as before.
create or replace function public.finalize_capital_operation(p_fund_id uuid, p_vehicle_id uuid, p_kind text, p_register_id uuid, p_entry_ids uuid[])
returns void language plpgsql set search_path = public as $$
declare
  linked_ids uuid[];
begin
  if cardinality(p_entry_ids) = 0 then raise exception 'At least one entry is required'; end if;
  perform 1 from public.journal_entries where id = any(p_entry_ids) order by id for update;
  if (select count(*) from public.journal_entries where id = any(p_entry_ids) and fund_id = p_fund_id and vehicle_id = p_vehicle_id and book = 'actual' and status = 'draft') <> cardinality(p_entry_ids) then
    raise exception 'Every entry must be a draft on this entity';
  end if;
  if p_kind = 'call' then
    select array[journal_entry_id] into linked_ids from public.capital_calls where id = p_register_id and fund_id = p_fund_id and vehicle_id = p_vehicle_id and status = 'draft' for update;
    if not exists (select 1 from public.capital_call_lines where call_id = p_register_id and fund_id = p_fund_id) then raise exception 'Call has no recipients'; end if;
    if linked_ids is null or not (linked_ids @> p_entry_ids and p_entry_ids @> linked_ids) then raise exception 'Call entries do not match'; end if;
    update public.capital_calls set status = 'issued' where id = p_register_id;
  elsif p_kind = 'distribution' then
    select array_remove(array[journal_entry_id, carry_journal_entry_id, carry_realized_journal_entry_id], null) into linked_ids from public.distributions where id = p_register_id and fund_id = p_fund_id and vehicle_id = p_vehicle_id and status = 'draft' for update;
    if not exists (select 1 from public.distribution_lines where distribution_id = p_register_id and fund_id = p_fund_id) then raise exception 'Distribution has no recipients'; end if;
    if linked_ids is null or not (linked_ids @> p_entry_ids and p_entry_ids @> linked_ids) then raise exception 'Distribution entries do not match'; end if;
    update public.distributions set status = 'declared' where id = p_register_id;
  else raise exception 'Unknown capital operation'; end if;
  -- Existing ledger triggers enforce balancing and period locks on this transition.
  update public.journal_entries set status = 'posted', posted_at = now() where id = any(p_entry_ids);
end;
$$;
revoke all on function public.finalize_capital_operation(uuid, uuid, text, uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.finalize_capital_operation(uuid, uuid, text, uuid, uuid[]) to service_role;

create or replace function public.complete_capital_operation(
  p_fund_id uuid, p_vehicle_id uuid, p_kind text, p_register_id uuid, p_entry_ids uuid[], p_lines jsonb
) returns void language plpgsql set search_path = public as $$
declare
  register_state text;
  linked_ids uuid[];
  existing_count integer;
  expected_count integer;
  capital_sign integer;
begin
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'Recipients are required'; end if;
  expected_count := jsonb_array_length(p_lines);
  if exists (select 1 from jsonb_to_recordset(p_lines) x("lpEntityId" uuid, amount numeric, role text)
    where x.amount is null or x.amount <= 0 or x.amount::text in ('NaN', 'Infinity', '-Infinity') or x.amount <> round(x.amount, 2)
      or not exists (select 1 from public.lp_entities e where e.id = x."lpEntityId" and e.fund_id = p_fund_id)) then
    raise exception 'Recipients and amounts must be valid for this fund';
  end if;
  if (select count(distinct x->>'lpEntityId') from jsonb_array_elements(p_lines) x) <> expected_count then raise exception 'Duplicate recipient'; end if;
  if p_kind = 'call' then
    select status, array[journal_entry_id] into register_state, linked_ids from public.capital_calls
      where id = p_register_id and fund_id = p_fund_id and vehicle_id = p_vehicle_id for update;
    capital_sign := -1;
  elsif p_kind = 'distribution' then
    select status, array_remove(array[journal_entry_id, carry_journal_entry_id, carry_realized_journal_entry_id], null) into register_state, linked_ids from public.distributions
      where id = p_register_id and fund_id = p_fund_id and vehicle_id = p_vehicle_id for update;
    capital_sign := 1;
    if exists (select 1 from jsonb_array_elements(p_lines) x where x->>'role' not in ('lp','carry') or x->>'role' is null) then raise exception 'Invalid recipient role'; end if;
  else raise exception 'Unknown capital operation'; end if;
  if register_state is null or linked_ids is null or cardinality(p_entry_ids) = 0 or not (linked_ids @> p_entry_ids and p_entry_ids @> linked_ids) then raise exception 'Capital operation scope or entries do not match'; end if;

  -- Freeze entry contents while checking the full partner totals, then use existing lock/balance triggers.
  perform 1 from public.journal_entries where id = any(p_entry_ids) order by id for update;
  if exists (
    with expected as (select "lpEntityId" id, amount from jsonb_to_recordset(p_lines) x("lpEntityId" uuid, amount numeric)),
    booked as (
      select a.lp_entity_id id, sum(p.amount) * capital_sign amount
      from public.journal_postings p join public.chart_of_accounts a on a.id = p.account_id
      join public.journal_entries je on je.id = p.journal_entry_id
      where p.journal_entry_id = any(p_entry_ids) and je.source_type is distinct from 'carried_interest' and p.fund_id = p_fund_id and p.vehicle_id = p_vehicle_id and p.book = 'actual'
        and a.fund_id = p_fund_id and a.vehicle_id = p_vehicle_id and a.type = 'equity' and a.subtype = 'lp_capital'
      group by a.lp_entity_id
    ) select 1 from expected full join booked using(id) where expected.amount is distinct from booked.amount
  ) then raise exception 'Recipient amounts do not match journal capital'; end if;

  if p_kind = 'call' then
    select count(*) into existing_count from public.capital_call_lines where call_id = p_register_id;
    if existing_count = 0 and register_state = 'draft' then
      insert into public.capital_call_lines(call_id, fund_id, vehicle_id, lp_entity_id, amount)
        select p_register_id, p_fund_id, p_vehicle_id, x."lpEntityId", x.amount from jsonb_to_recordset(p_lines) x("lpEntityId" uuid, amount numeric);
    elsif existing_count <> expected_count or exists (
      select 1 from jsonb_to_recordset(p_lines) x("lpEntityId" uuid, amount numeric)
      where not exists (select 1 from public.capital_call_lines l where l.call_id = p_register_id and l.fund_id = p_fund_id and l.vehicle_id = p_vehicle_id and l.lp_entity_id = x."lpEntityId" and l.amount = x.amount)
    ) then raise exception 'Recorded call recipients differ from this request'; end if;
  else
    select count(*) into existing_count from public.distribution_lines where distribution_id = p_register_id;
    if existing_count = 0 and register_state = 'draft' then
      insert into public.distribution_lines(distribution_id, fund_id, vehicle_id, lp_entity_id, amount, role)
        select p_register_id, p_fund_id, p_vehicle_id, x."lpEntityId", x.amount, x.role from jsonb_to_recordset(p_lines) x("lpEntityId" uuid, amount numeric, role text);
    elsif existing_count <> expected_count or exists (
      select 1 from jsonb_to_recordset(p_lines) x("lpEntityId" uuid, amount numeric, role text)
      where not exists (select 1 from public.distribution_lines l where l.distribution_id = p_register_id and l.fund_id = p_fund_id and l.vehicle_id = p_vehicle_id and l.lp_entity_id = x."lpEntityId" and l.amount = x.amount and l.role = x.role)
    ) then raise exception 'Recorded distribution recipients differ from this request'; end if;
  end if;
  if register_state = 'draft' then
    perform public.finalize_capital_operation(p_fund_id, p_vehicle_id, p_kind, p_register_id, p_entry_ids);
  elsif (p_kind = 'call' and register_state <> 'issued') or (p_kind = 'distribution' and register_state <> 'declared') then
    raise exception 'Capital operation cannot be published in this state';
  end if;
end;
$$;
revoke all on function public.complete_capital_operation(uuid, uuid, text, uuid, uuid[], jsonb) from public, anon, authenticated;
grant execute on function public.complete_capital_operation(uuid, uuid, text, uuid, uuid[], jsonb) to service_role;

create or replace function public.discard_unregistered_capital_drafts(p_fund_id uuid, p_vehicle_id uuid, p_entry_ids uuid[])
returns void language sql set search_path = public as $$
  delete from public.journal_entries e where e.fund_id = p_fund_id and e.vehicle_id = p_vehicle_id and e.book = 'actual'
    and e.id = any(p_entry_ids) and e.status = 'draft' and e.source_type in ('capital_call','distribution','carry_distribution','carried_interest')
    and not exists (select 1 from public.capital_calls c where c.journal_entry_id = e.id)
    and not exists (select 1 from public.distributions d where d.journal_entry_id = e.id or d.carry_journal_entry_id = e.id or d.carry_realized_journal_entry_id = e.id);
$$;
revoke all on function public.discard_unregistered_capital_drafts(uuid, uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.discard_unregistered_capital_drafts(uuid, uuid, uuid[]) to service_role;
