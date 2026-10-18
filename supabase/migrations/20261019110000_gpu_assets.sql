-- ── GPU fleet (P1b) ── The fleet register: server types, servers, their downtime/maintenance log,
-- datacenter contracts, and per-vehicle fleet settings (design §2.3, decisions R8/Q7/Q9).
--
-- Safe to apply before the code that uses it: new tables only, nothing reads them yet, and every
-- one is service-role only. Their sole reader is a /api/fleet route gated on the `fleet` domain and
-- the `gpu_fleet` feature, using createAdminClient(), so (CLAUDE.md) a Data API grant to
-- `authenticated` would hand the register to members that gate refuses. Pattern:
-- 20260920122643_accounting_schedules.sql. tests/gpu-data-api-grants.test.ts pins it.

create table public.gpu_asset_types (
  id               uuid primary key default gen_random_uuid(),
  fund_id          uuid not null references public.funds(id) on delete cascade,
  code             text not null,
  label            text not null,
  gpu_model        text,
  gpus_per_server  integer not null default 8 check (gpus_per_server > 0),
  anchor_rate      numeric(12, 4),
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (fund_id, code)
);

-- The payer is the vehicle (an SPV). Shared contracts on a manco are deferred (decision Q10).
create table public.datacenter_contracts (
  id                     uuid primary key default gen_random_uuid(),
  fund_id                uuid not null references public.funds(id) on delete cascade,
  vehicle_id             uuid not null references public.fund_vehicles(id) on delete cascade,
  vendor_id              uuid references public.vendors(id) on delete set null,
  facility               text not null,
  start_date             date not null,
  end_date               date,
  monthly_fee            numeric(20, 2) not null check (monthly_fee >= 0),
  escalator_pct          numeric(6, 4) not null default 0 check (escalator_pct >= 0),
  escalates_on           text not null default 'anniversary' check (escalates_on in ('anniversary', 'calendar_year')),
  first_escalation_date  date,
  power_kw               numeric,
  includes_connectivity  boolean not null default false,
  deposit                numeric(20, 2),
  -- The accrual schedule for the current escalation period; lib/gpu/opex.ts rolls it forward.
  schedule_id            uuid references public.accounting_schedules(id) on delete set null,
  allocation             text not null default 'none' check (allocation in ('none', 'gpu_count')),
  status                 text not null default 'active' check (status in ('active', 'ended')),
  created_by             uuid,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  check (end_date is null or end_date >= start_date)
);

-- One row per server. vehicle_id must be a gpu_spv; checked in the app (assertVehicleKind).
create table public.gpu_assets (
  id                       uuid primary key default gen_random_uuid(),
  fund_id                  uuid not null references public.funds(id) on delete cascade,
  vehicle_id               uuid not null references public.fund_vehicles(id) on delete cascade,
  asset_type_id            uuid references public.gpu_asset_types(id) on delete restrict,
  name                     text not null,
  serials                  text[] not null default '{}',
  vendor_id                uuid references public.vendors(id) on delete set null,
  status                   text not null default 'planned'
                             check (status in ('planned', 'ordered', 'in_service', 'offline', 'disposed')),
  gpu_count                integer not null check (gpu_count > 0),
  hardware_cost            numeric(20, 2) not null check (hardware_cost >= 0),
  -- Shipping, installation and spares actually spent (decision R8/Q6); unspent contingency is ROC.
  capitalized_costs        numeric(20, 2) not null default 0 check (capitalized_costs >= 0),
  purchase_date            date,
  in_service_date          date,
  useful_life_months       integer not null default 60 check (useful_life_months > 0),
  -- Defaulted to 10% of hardware_cost by the app when not given.
  salvage_value            numeric(20, 2) not null default 0 check (salvage_value >= 0),
  depreciation_convention  text not null default 'full_month' check (depreciation_convention in ('full_month', 'mid_month')),
  -- Tax depreciation, separate from book (decision Q7). 'book' = the same schedule as book.
  tax_method               text not null default 'book'
                             check (tax_method in ('book', 'straight_line', 'macrs_5', 'macrs_7', 'bonus')),
  tax_bonus_pct            numeric not null default 0 check (tax_bonus_pct >= 0 and tax_bonus_pct <= 1),
  tax_life_years           integer check (tax_life_years is null or tax_life_years > 0),
  insurance_basis          numeric(20, 2),
  datacenter_contract_id   uuid references public.datacenter_contracts(id) on delete set null,
  purchase_entry_id        uuid references public.journal_entries(id) on delete set null,
  disposed_on              date,
  disposal_proceeds        numeric(20, 2),
  disposal_entry_id        uuid references public.journal_entries(id) on delete set null,
  notes                    text,
  created_by               uuid,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

-- The manual per-asset downtime/maintenance record (decision Q9: no monitoring, no claim tracking).
create table public.gpu_asset_events (
  id             uuid primary key default gen_random_uuid(),
  fund_id        uuid not null references public.funds(id) on delete cascade,
  vehicle_id     uuid not null references public.fund_vehicles(id) on delete cascade,
  asset_id       uuid not null references public.gpu_assets(id) on delete cascade,
  kind           text not null check (kind in ('downtime', 'maintenance', 'rma', 'relocation', 'note')),
  starts_at      timestamptz not null,
  ends_at        timestamptz,
  -- Null = every GPU in the server.
  gpus_affected  integer check (gpus_affected is null or gpus_affected > 0),
  cause          text,
  created_by     uuid,
  created_at     timestamptz not null default now(),
  check (ends_at is null or ends_at >= starts_at)
);

-- Fleet-only knobs per vehicle. The distribution reserve, cadence and pref day-count are P2's.
create table public.gpu_fleet_settings (
  id                        uuid primary key default gen_random_uuid(),
  fund_id                   uuid not null references public.funds(id) on delete cascade,
  vehicle_id                uuid not null unique references public.fund_vehicles(id) on delete cascade,
  capex_contingency_budget  numeric(20, 2) not null default 0 check (capex_contingency_budget >= 0),
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

create index gpu_assets_vehicle_idx on public.gpu_assets (fund_id, vehicle_id, status);
create index gpu_asset_events_asset_idx on public.gpu_asset_events (asset_id, starts_at);
create index gpu_asset_events_vehicle_idx on public.gpu_asset_events (fund_id, vehicle_id, starts_at);
create index datacenter_contracts_vehicle_idx on public.datacenter_contracts (fund_id, vehicle_id, status);

alter table public.gpu_asset_types enable row level security;
alter table public.datacenter_contracts enable row level security;
alter table public.gpu_assets enable row level security;
alter table public.gpu_asset_events enable row level security;
alter table public.gpu_fleet_settings enable row level security;

revoke all on public.gpu_asset_types from anon, authenticated;
revoke all on public.datacenter_contracts from anon, authenticated;
revoke all on public.gpu_assets from anon, authenticated;
revoke all on public.gpu_asset_events from anon, authenticated;
revoke all on public.gpu_fleet_settings from anon, authenticated;

grant select, insert, update, delete on public.gpu_asset_types to service_role;
grant select, insert, update, delete on public.datacenter_contracts to service_role;
grant select, insert, update, delete on public.gpu_assets to service_role;
grant select, insert, update, delete on public.gpu_asset_events to service_role;
grant select, insert, update, delete on public.gpu_fleet_settings to service_role;

create policy "gpu_asset_types service role" on public.gpu_asset_types for all to service_role using (true) with check (true);
create policy "datacenter_contracts service role" on public.datacenter_contracts for all to service_role using (true) with check (true);
create policy "gpu_assets service role" on public.gpu_assets for all to service_role using (true) with check (true);
create policy "gpu_asset_events service role" on public.gpu_asset_events for all to service_role using (true) with check (true);
create policy "gpu_fleet_settings service role" on public.gpu_fleet_settings for all to service_role using (true) with check (true);

comment on table public.gpu_assets is
  'GPU SPV fleet register: one row per server. Cost and accumulated depreciation live on per-asset ledger accounts 1600-<a>/1650-<a>.';
comment on table public.gpu_asset_events is
  'Manual per-server downtime, maintenance, RMA and relocation log; the source of uptime.';
comment on table public.gpu_fleet_settings is
  'Per-vehicle fleet settings; capex_contingency_budget is the unspent-contingency (ROC) baseline.';
