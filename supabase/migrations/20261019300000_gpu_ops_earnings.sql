-- ── GPU fleet (P3) ── Manual operations entry: per-asset, per-period revenue, rented hours or
-- utilization, marketplace fee, net payout and downtime, typed into a form or pasted as CSV
-- (decisions Q1: no marketplace integration; Q9: downtime is a manual per-period field), and the
-- payouts the marketplace sends against them.
--
-- Safe to apply before the code that uses it: three new tables and one partial index on
-- journal_entries over prefixes nothing writes yet. Every new table is service-role only. Their sole
-- reader is an /api/fleet route gated on the `fleet` domain and the `gpu_fleet` feature, using
-- createAdminClient(), so (CLAUDE.md) a Data API grant to `authenticated` would hand revenue to
-- members that gate refuses. Pattern: 20261019110000_gpu_assets.sql. tests/gpu-data-api-grants.test.ts
-- pins it.

-- One paste or one form submission. `source` keeps room for an API adapter later; only these two ship.
create table public.gpu_import_runs (
  id              uuid primary key default gen_random_uuid(),
  fund_id         uuid not null references public.funds(id) on delete cascade,
  vehicle_id      uuid not null references public.fund_vehicles(id) on delete cascade,
  source          text not null check (source in ('manual', 'csv')),
  file_name       text,
  rows_total      integer not null default 0,
  rows_imported   integer not null default 0,
  rows_skipped    integer not null default 0,
  rows_unmatched  integer not null default 0,
  created_by      uuid,
  created_at      timestamptz not null default now()
);

-- One row per asset per period. asset_id null = the typed asset name matched no server (unmatched).
-- gross - marketplace_fee = net within a cent is checked by the parser, not here.
create table public.gpu_earnings (
  id                uuid primary key default gen_random_uuid(),
  fund_id           uuid not null references public.funds(id) on delete cascade,
  vehicle_id        uuid not null references public.fund_vehicles(id) on delete cascade,
  run_id            uuid references public.gpu_import_runs(id) on delete set null,
  asset_id          uuid references public.gpu_assets(id) on delete restrict,
  asset_ref         text not null,
  -- For a later marketplace adapter; null for manual and CSV rows.
  machine_ref       text,
  period_start      date not null,
  period_end        date not null,
  -- Exactly one is entered; match.ts derives the other from the asset's GPU count. The other stays
  -- null on an unmatched row, which has no GPU count to derive from.
  gpu_hours_rented  numeric(14, 4) check (gpu_hours_rented >= 0),
  utilization_pct   numeric(7, 4) check (utilization_pct >= 0 and utilization_pct <= 100),
  gross             numeric(20, 2) not null check (gross >= 0),
  marketplace_fee   numeric(20, 2) not null default 0 check (marketplace_fee >= 0),
  net               numeric(20, 2) not null,
  downtime_hours    numeric(14, 4) not null default 0 check (downtime_hours >= 0),
  note              text,
  currency          text not null default 'USD',
  dedup_hash        text not null,
  raw               jsonb,
  status            text not null default 'staged'
                      check (status in ('staged', 'unmatched', 'posted', 'ignored', 'reversed')),
  -- A correction to a posted row: posting it reverses the superseded row's entry first.
  supersedes_id     uuid references public.gpu_earnings(id) on delete set null,
  journal_entry_id  uuid references public.journal_entries(id) on delete set null,
  created_by        uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check (period_end >= period_start),
  unique (fund_id, vehicle_id, dedup_hash)
);

-- One OPEN row per asset-period: a second paste of the same asset-period with different figures
-- updates the staged row instead of staging a second one (lib/gpu/ops/import.ts).
create unique index gpu_earnings_one_staged
  on public.gpu_earnings (fund_id, vehicle_id, asset_id, period_start, period_end)
  where status = 'staged';

create index gpu_earnings_vehicle_idx on public.gpu_earnings (fund_id, vehicle_id, period_end);

-- A payout the marketplace sent (or will send), matched to a bank inflow: Dr 1000 / Cr 1150.
create table public.gpu_payouts (
  id                   uuid primary key default gen_random_uuid(),
  fund_id              uuid not null references public.funds(id) on delete cascade,
  vehicle_id           uuid not null references public.fund_vehicles(id) on delete cascade,
  payout_date          date not null,
  amount               numeric(20, 2) not null check (amount > 0),
  reference            text,
  note                 text,
  bank_transaction_id  uuid references public.bank_transactions(id) on delete set null,
  journal_entry_id     uuid references public.journal_entries(id) on delete set null,
  status               text not null default 'expected' check (status in ('expected', 'matched')),
  created_by           uuid,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index gpu_payouts_vehicle_idx on public.gpu_payouts (fund_id, vehicle_id, status, payout_date);

alter table public.gpu_import_runs enable row level security;
alter table public.gpu_earnings enable row level security;
alter table public.gpu_payouts enable row level security;

revoke all on public.gpu_import_runs from anon, authenticated;
revoke all on public.gpu_earnings from anon, authenticated;
revoke all on public.gpu_payouts from anon, authenticated;

grant select, insert, update, delete on public.gpu_import_runs to service_role;
grant select, insert, update, delete on public.gpu_earnings to service_role;
grant select, insert, update, delete on public.gpu_payouts to service_role;

create policy "gpu_import_runs service role" on public.gpu_import_runs for all to service_role using (true) with check (true);
create policy "gpu_earnings service role" on public.gpu_earnings for all to service_role using (true) with check (true);
create policy "gpu_payouts service role" on public.gpu_payouts for all to service_role using (true) with check (true);

-- Each earnings row and each payout is booked once: persistEntry turns the 23505 into "already in
-- the books", so a double click cannot book revenue twice. A second index alongside
-- journal_entries_gpu_fleet_once (20261019110000), not a change to it. Safe on existing data: no
-- release before this one writes either prefix.
create unique index if not exists journal_entries_gpu_ops_once
  on public.journal_entries (fund_id, vehicle_id, book, source_ref)
  where (source_ref like 'marketplace:%' or source_ref like 'marketplace-payout:%') and status <> 'void';

comment on table public.gpu_earnings is
  'GPU SPV operations entered by hand or CSV paste: per asset per period rented hours, utilization, gross, fee, net and downtime.';
comment on table public.gpu_payouts is
  'Marketplace payouts against posted GPU earnings; matching one to a bank inflow books Dr 1000 / Cr 1150.';
