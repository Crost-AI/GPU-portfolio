-- Proposed capital calls: a call written down for review before it is issued.
--
-- A proposal holds the total, what it is for (with amounts), the notice and due dates,
-- each LP's share computed from stored commitments, and the checks the app ran on it (what is
-- missing, which dates fall inside the LPA notice period). Nothing in it is in the books and no
-- LP can see it. An admin approving it issues the call through the same path the Capital page
-- uses and publishes each LP's own notice to their portal; until then it is only a proposal.
--
-- SERVICE ROLE ONLY. The only reader is /api/accounting/proposed-calls, gated on lp_capital and
-- holding the service-role key. A grant to `authenticated` would let
-- any fund member (or an LP with a portal login) read every partner's proposed call from the
-- browser console, past the domain gate, so there is none and no policy: RLS denies by default.
-- Pinned in tests/proposed-calls-grants.test.ts.
--
-- Safe to re-run: it was applied by hand before it was pushed, so every statement is idempotent.

create table if not exists public.proposed_capital_calls (
  id                  uuid primary key default gen_random_uuid(),
  fund_id             uuid not null references funds(id) on delete cascade,
  vehicle_id          uuid not null references fund_vehicles(id) on delete cascade,
  status              text not null default 'proposed' check (status in ('proposed', 'approved', 'discarded')),
  total               numeric not null,
  -- [{ category, amount, description, basis, date }], as the request gave them.
  purposes            jsonb not null default '[]'::jsonb,
  description         text,
  notice_date         date,
  due_date            date,
  -- The notice period as the REQUEST stated it. The vehicle's stored LPA term is re-read on every
  -- check, so changing it re-checks every open proposal.
  notice_period_days  int check (notice_period_days between 0 and 365),
  notice_period_basis text check (notice_period_basis in ('calendar', 'business')),
  -- LP figures the request stated ([{ lp, commitment, sharePct }]). Never used for the split; each
  -- is checked against the register and a difference is flagged.
  stated_partners     jsonb not null default '[]'::jsonb,
  -- The last check: per-LP lines, missing items and flags. Recomputed from live commitments on
  -- approval, so a stale proposal can never issue stale amounts.
  checked             jsonb not null default '{}'::jsonb,
  capital_call_id     uuid references public.capital_calls(id) on delete set null,
  created_by          uuid,
  created_source      text,
  approved_by         uuid,
  approved_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists proposed_capital_calls_fund_idx on public.proposed_capital_calls (fund_id, vehicle_id, created_at desc);

-- 1. Grants: service_role alone (see above). The revoke undoes the default privileges a project
--    created before 2026-10-30 still hands every new table.
revoke all on public.proposed_capital_calls from anon, authenticated;
grant select, insert, update, delete on public.proposed_capital_calls to service_role;

-- 2. RLS on, and no policies: nothing but the service role reaches a row.
alter table public.proposed_capital_calls enable row level security;

-- The LPA's notice period, recorded once per vehicle rather than typed into every call. Null =
-- nobody has recorded it, and the check says so.
alter table public.vehicle_accounting_settings
  add column if not exists call_notice_days int check (call_notice_days between 0 and 365),
  add column if not exists call_notice_basis text check (call_notice_basis in ('calendar', 'business'));

-- What an issued call was for, frozen with it, so the notice an LP receives shows the breakdown
-- the approver saw. Null on calls issued any other way.
alter table public.capital_calls
  add column if not exists purposes jsonb;
