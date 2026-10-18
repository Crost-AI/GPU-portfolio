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

-- 3. A fleet company and its metrics are the GPU SPV's revenue restated, so reading them needs
--    `fleet` as well as `portfolio` (issue #91). RESTRICTIVE policies, which Postgres ANDs with the
--    permissive "<table> read needs portfolio" ones (20260902174637) — the same mechanism as the
--    entity rule (20261007100200) — so every other company's rows pass exactly as before and the
--    domain policies are not restated. `fleet` resolves to none while `gpu_fleet` is off, admins
--    included. The metric_values_latest views are security_invoker (20261014180000), so they inherit
--    this.
--
--    The fleet companies' ids come from a security definer helper rather than a subquery on
--    companies: under RLS a caller who cannot see the fleet company would see "no such company"
--    and the metric would pass.
create or replace function public.gpu_fleet_company_ids()
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(c.id), '{}'::uuid[]) from companies c
   where c.holding_type = 'gpu_fleet' and c.fund_id = any(public.member_fund_ids());
$$;

revoke execute on function public.gpu_fleet_company_ids() from public, anon;
grant execute on function public.gpu_fleet_company_ids() to authenticated, service_role;

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

do $$
declare
  t text;
  r text := 'not (company_id = any((select public.gpu_fleet_company_ids()))) or fund_id = any((select public.fund_ids_readable(''fleet'')))';
  w text := 'not (company_id = any((select public.gpu_fleet_company_ids()))) or fund_id = any((select public.fund_ids_writable(''fleet'')))';
begin
  foreach t in array array['metrics', 'metric_values'] loop
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
