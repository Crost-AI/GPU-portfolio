-- supabase/migrations/20261012054253_vehicle_groups.sql
--
-- Entity groups: an admin-defined way to section the entity lists. A firm with a flagship fund
-- family, a run of SPVs, the GP entities and a few direct deals had them all in one flat list,
-- ordered only by size. A group is a label and a position; each entity belongs to at most one
-- (fund_vehicles.group_id), and the lists render one section per group, in `position` order,
-- with an "Other" section for the entities in none.
--
-- Additive, and the code that reads it tolerates its absence (lib/vehicle-groups.ts): until this
-- is applied the lists stay flat and the settings section says a migration is pending. Nothing
-- needs to ship first.

create table public.vehicle_groups (
  id uuid primary key default gen_random_uuid(),
  fund_id uuid not null references funds(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One group per name per fund, case-insensitively — two "SPVs" sections would be a typo.
create unique index vehicle_groups_fund_name_key
  on public.vehicle_groups (fund_id, lower(btrim(name)));

-- 1. Grants. SERVICE ROLE ONLY, reads included.
--
--    The readers are api/vehicle-groups (every list) and api/settings/vehicle-groups (the admin
--    section), both with the service-role key, both filtering the entity assignments by what the
--    caller may see (canSeeVehicle). A fund-membership policy would hand a scoped member the
--    grouping of entities the application refuses to list for them.
revoke all on public.vehicle_groups from anon, authenticated;
grant select, insert, update, delete on public.vehicle_groups to service_role;

-- 2. RLS on, and no policy: if a grant ever creeps back, the default is deny.
alter table public.vehicle_groups enable row level security;

-- The assignment. One group per entity; deleting a group returns its entities to "Other".
alter table public.fund_vehicles
  add column group_id uuid references public.vehicle_groups(id) on delete set null;

create index fund_vehicles_group_idx on public.fund_vehicles (group_id) where group_id is not null;
