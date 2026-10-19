-- ── GPU fleet (P3) ── A GPU SPV's fleet as a portfolio holding, so its operating KPIs (utilization,
-- realized rate, uptime, revenue) are published as metrics on a company page the way a portfolio
-- company's are (lib/gpu/fleet-company.ts, lib/gpu/metrics-publish.ts).
--
-- Both changes are additive and safe before the code that uses them: every existing company keeps
-- its holding type, and every existing default metric defaults to 'company'.

-- 1. The discriminator gains 'gpu_fleet'. Re-declared rather than edited: 20260822000000 has
--    shipped, and historical migrations are never modified (CLAUDE.md).
alter table public.companies
  drop constraint if exists companies_holding_type_check;

alter table public.companies
  add constraint companies_holding_type_check
  check (holding_type in ('company', 'fund', 'crypto', 'gpu_fleet'));

-- 2. Which kind of holding a default metric is a template for. The fund-wide apply and the company
--    seed copy only the templates of the company's own kind, so a VC company never receives a
--    gpu-* metric and a fleet company receives nothing else.
alter table public.default_metrics
  add column if not exists holding_type text not null default 'company'
  check (holding_type in ('company', 'gpu_fleet'));

-- 3. Whether the bank auto-match may BOOK a GPU SPV's payout match (Dr 1000 / Cr 1150) by itself.
--    Off by default: the run proposes the match and the accountant confirms it (issue #92).
alter table public.gpu_fleet_settings
  add column if not exists auto_post_payout_matches boolean not null default false;

-- 4. A fleet company and everything hanging off it are the GPU SPV's revenue restated, so reading
--    them needs `fleet` as well as `portfolio` (issue #91). Added as RESTRICTIVE policies, which
--    Postgres ANDs with the existing permissive domain policies (20260902174637) — the mechanism the
--    entity rule uses (20261007100200) — so no existing policy is restated and every other company's
--    rows pass exactly as before. `fleet` resolves to none while `gpu_fleet` is off, admins included.
--    The metric_values_latest views are security_invoker (20261014180000), so they inherit this.
--
--    The helpers return the EXCLUSION set: the fleet companies of the caller's funds that the caller
--    may NOT read (or write). Called directly through the Data API, they reveal only ids the policies
--    already hide. Security definer so the policies can read companies without recursing through its
--    RLS (a subquery would see "no such company" for a hidden one, and pass its rows).
create or replace function public.gpu_fleet_company_ids_unreadable()
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(c.id), '{}'::uuid[]) from companies c
   where c.holding_type = 'gpu_fleet'
     and c.fund_id = any(public.member_fund_ids())
     and not (c.fund_id = any(public.fund_ids_readable('fleet')));
$$;

create or replace function public.gpu_fleet_company_ids_unwritable()
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(c.id), '{}'::uuid[]) from companies c
   where c.holding_type = 'gpu_fleet'
     and c.fund_id = any(public.member_fund_ids())
     and not (c.fund_id = any(public.fund_ids_writable('fleet')));
$$;

revoke execute on function public.gpu_fleet_company_ids_unreadable() from public, anon;
revoke execute on function public.gpu_fleet_company_ids_unwritable() from public, anon;
grant execute on function public.gpu_fleet_company_ids_unreadable() to authenticated, service_role;
grant execute on function public.gpu_fleet_company_ids_unwritable() to authenticated, service_role;

-- The fleet company itself, by its own holding_type.
drop policy if exists "gpu_fleet companies read needs fleet" on public.companies;
drop policy if exists "gpu_fleet companies insert needs fleet write" on public.companies;
drop policy if exists "gpu_fleet companies update needs fleet write" on public.companies;
drop policy if exists "gpu_fleet companies delete needs fleet write" on public.companies;

create policy "gpu_fleet companies read needs fleet"
  on public.companies as restrictive for select to authenticated
  using (holding_type is distinct from 'gpu_fleet' or fund_id = any((select public.fund_ids_readable('fleet'))));
create policy "gpu_fleet companies insert needs fleet write"
  on public.companies as restrictive for insert to authenticated
  with check (holding_type is distinct from 'gpu_fleet' or fund_id = any((select public.fund_ids_writable('fleet'))));
create policy "gpu_fleet companies update needs fleet write"
  on public.companies as restrictive for update to authenticated
  using (holding_type is distinct from 'gpu_fleet' or fund_id = any((select public.fund_ids_writable('fleet'))))
  with check (holding_type is distinct from 'gpu_fleet' or fund_id = any((select public.fund_ids_writable('fleet'))));
create policy "gpu_fleet companies delete needs fleet write"
  on public.companies as restrictive for delete to authenticated
  using (holding_type is distinct from 'gpu_fleet' or fund_id = any((select public.fund_ids_writable('fleet'))));

-- Every browser-reachable table keyed by company_id. A row about no company (company_id null)
-- passes. tests/gpu-fleet-company-rls.test.ts fails when a table with a company_id column and a
-- Data API grant is missing from this list, so a new one cannot slip past.
do $$
declare
  t text;
  r text := 'company_id is null or not (company_id = any((select public.gpu_fleet_company_ids_unreadable())))';
  w text := 'company_id is null or not (company_id = any((select public.gpu_fleet_company_ids_unwritable())))';
  tables text[] := array[
    'analyst_conversations', 'ask_response_overrides', 'chart_of_accounts', 'company_documents', 'company_notes',
    'company_summaries', 'company_update_artifacts', 'company_update_chunks', 'company_updates', 'crypto_wallets',
    'default_metric_exclusions', 'fund_capital_events', 'fund_holding_terms', 'fund_nav_statements', 'inbound_emails',
    'interactions', 'investment_transactions', 'metric_values', 'metrics', 'note_company_subscriptions',
    'parsing_reviews', 'price_feeds'
  ];
begin
  foreach t in array tables loop
    if to_regclass('public.' || t) is null then
      continue;
    end if;
    if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = t and column_name = 'company_id') then
      raise exception 'gpu_fleet RLS: listed table % has no company_id column', t;
    end if;
    execute format('drop policy if exists "gpu_fleet %s read needs fleet" on public.%I', t, t);
    execute format('drop policy if exists "gpu_fleet %s insert needs fleet write" on public.%I', t, t);
    execute format('drop policy if exists "gpu_fleet %s update needs fleet write" on public.%I', t, t);
    execute format('drop policy if exists "gpu_fleet %s delete needs fleet write" on public.%I', t, t);
    execute format('create policy "gpu_fleet %s read needs fleet" on public.%I as restrictive for select to authenticated using (%s)', t, t, r);
    execute format('create policy "gpu_fleet %s insert needs fleet write" on public.%I as restrictive for insert to authenticated with check (%s)', t, t, w);
    execute format('create policy "gpu_fleet %s update needs fleet write" on public.%I as restrictive for update to authenticated using (%s) with check (%s)', t, t, w, w);
    execute format('create policy "gpu_fleet %s delete needs fleet write" on public.%I as restrictive for delete to authenticated using (%s)', t, t, w);
  end loop;
end $$;
