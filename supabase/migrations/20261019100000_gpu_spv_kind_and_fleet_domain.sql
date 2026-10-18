-- GPU SPVs: the `gpu_spv` vehicle kind, the `gpu_fleet` feature switch and the `fleet` access area.
--
-- A GPU SPV owns GPU servers and rents them out: an operating partnership with a fleet register,
-- depreciation and a distributable-cash waterfall. Its partner-equity side is a fund's, so it closes
-- to partners like one. The chart it seeds is GPU_SPV_CHART in lib/accounting/chart.ts.
--
-- `fleet` is its own area for the same reason `tax` is (20261012150000): an operations member can
-- record downtime and stage an earnings import without being handed the journal. Every dollar figure
-- on a fleet page is the ledger restated, so `fleet` requires reading the books
-- (DOMAIN_META.fleet.requires), which the TypeScript resolver enforces.
--
-- Nothing changes for anyone on the day this lands. `gpu_fleet` ships 'off', which denies `fleet`
-- to everyone, admins included; existing rows keep their kind. Every fund's default and every
-- member's grant for `fleet` is copied from what they hold for `accounting`, so when a fund turns
-- GPU Operations on each person starts with the books access they already have.
--
-- Deploy order does not matter. Until this is pushed, the app falls back to a member's accounting
-- level for `fleet` (DOMAIN_META.fleet.defaultFrom), which is the same answer this migration writes;
-- and nothing can create a `gpu_spv` vehicle before the code that offers it ships.
--
-- The GPU tables (a later migration) are service-role only, so no RLS policy reads this domain and
-- `domain_access()` needs no change.

-- 1. The kind. Additive: every existing row keeps its kind, and 'gpu_spv' becomes sayable.
alter table public.fund_vehicles
  drop constraint if exists fund_vehicles_kind_check;
alter table public.fund_vehicles
  add constraint fund_vehicles_kind_check
  check (kind in ('fund', 'spv', 'direct', 'associate', 'individual', 'manco', 'gpu_spv', 'other'));

comment on column public.fund_vehicles.kind is
  'fund | spv | direct | associate (a GP entity) | individual (an angel or their single-member LLC) '
  '| manco (the management company) | gpu_spv (an SPV that owns and rents out GPU servers) | other. '
  'Decides the chart it seeds, the pages it shows, and whether the close allocates to partners '
  '(fund, spv, direct, associate, gpu_spv, other) or rolls into owner''s equity (manco, individual).';

-- 2. The feature switch's default. Restated in full (rls-domain-policies.test.ts compares the last
--    definition's CASE arms with DEFAULT_FEATURE_VISIBILITY).
create or replace function public.feature_default(p_feature text)
returns text
language sql
immutable
parallel safe
as $$
  select case p_feature
    when 'interactions'       then 'off'
    when 'investments'        then 'everyone'
    when 'notes'              then 'off'
    when 'lp_letters'         then 'off'
    when 'imports'            then 'everyone'
    when 'asks'               then 'admin'
    when 'lps'                then 'off'
    when 'lp_tracking'        then 'off'
    when 'lp_portal'          then 'off'
    when 'lp_activity'        then 'off'
    when 'compliance'         then 'off'
    when 'deals'              then 'off'
    when 'diligence'          then 'off'
    when 'accounting'         then 'off'
    when 'gp_economics'       then 'off'
    when 'tax_reporting'      then 'off'
    when 'management_company' then 'off'
    when 'gpu_fleet'          then 'off'
    -- An unknown key is not a reason to open a door.
    else 'off'
  end;
$$;

-- 3. The domain's fund-level switch. Restated in full (rls-domain-policies.test.ts compares the
--    last definition's CASE arms with DOMAIN_META.primaryFeature).
create or replace function public.domain_primary_feature(p_domain text)
returns text
language sql
immutable
parallel safe
as $$
  select case p_domain
    when 'dealflow'           then 'deals'
    when 'diligence'          then 'diligence'
    when 'accounting'         then 'accounting'
    when 'management_company' then 'management_company'
    when 'lp_capital'         then 'lps'
    when 'gp_economics'       then 'gp_economics'
    when 'compliance'         then 'compliance'
    when 'tax'                then 'tax_reporting'
    when 'fleet'              then 'gpu_fleet'
    else null
  end;
$$;

-- 4. Every existing fund's default for `fleet` is its default for `accounting`.
insert into public.fund_domain_defaults (fund_id, domain, level)
select f.id, 'fleet', coalesce(d.level, 'write')
from funds f
left join public.fund_domain_defaults d on d.fund_id = f.id and d.domain = 'accounting'
on conflict (fund_id, domain) do nothing;

-- 5. Every member's explicit accounting grant becomes their fleet grant, so nobody gains or loses.
insert into public.fund_member_access (fund_id, user_id, domain, level, updated_by)
select a.fund_id, a.user_id, 'fleet', a.level, a.updated_by
from public.fund_member_access a
where a.domain = 'accounting'
on conflict (fund_id, user_id, domain) do nothing;

-- 6. New funds. Restated in full (it is a `create or replace`); `fleet` seeds at 'write' like
--    `accounting`, because a new fund's members get the books at 'write' too.
create or replace function public.seed_fund_domain_defaults()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.fund_domain_defaults (fund_id, domain, level)
  select new.id, d.domain, d.level
  from (values
    ('portfolio', 'write'), ('relationships', 'write'), ('dealflow', 'write'),
    ('diligence', 'write'), ('accounting', 'write'), ('lp_capital', 'write'),
    ('gp_economics', 'write'), ('lp_relations', 'write'), ('compliance', 'write'),
    ('tax', 'write'), ('fleet', 'write'),
    -- The firm's own books, including payroll. Granted per person, never by default.
    ('management_company', 'none')
  ) as d(domain, level)
  on conflict (fund_id, domain) do nothing;
  return new;
end;
$$;

-- `create or replace` keeps the function's privileges, so the execute revoke in
-- 20261011200000_security_definer_execute_lockdown.sql still holds. Restated anyway, so this file
-- is safe to read on its own.
revoke execute on function public.seed_fund_domain_defaults() from public, anon, authenticated;
