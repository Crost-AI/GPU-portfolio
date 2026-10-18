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
