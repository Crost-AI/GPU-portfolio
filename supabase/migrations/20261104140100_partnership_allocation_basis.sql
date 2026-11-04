-- The allocation basis on a partnership-expense invoice: one line per expense saying why the fund
-- bears it ("100%: fund formation", "pro rata by commitments"), printed on the invoice in place of
-- the reference and receipt columns (lib/accounting/partnership-invoices.ts, allocationBasisFor).
--
--   receipts.allocation_basis                    typed when the receipt is processed
--   partnership_allocation_rules                 the basis to use for a vendor's expenses billed
--                                                by one entity to one fund, saved for next time
--   partnership_invoice_lines.allocation_basis   frozen with the invoice, like its amount
--
-- ADDITIVE AND SAFE BEFORE DEPLOY. Two nullable columns and a table the live release never reads.

alter table public.receipts add column if not exists allocation_basis text;
alter table public.partnership_invoice_lines add column if not exists allocation_basis text;

create table if not exists public.partnership_allocation_rules (
  id               uuid primary key default gen_random_uuid(),
  fund_id          uuid not null references funds(id) on delete cascade,
  -- The entity that pays and bills (the management company), and the fund it bills.
  from_vehicle_id  uuid not null references fund_vehicles(id) on delete cascade,
  to_vehicle_id    uuid not null references fund_vehicles(id) on delete cascade,
  -- The vendor as the books name it, lower-cased and squeezed (receipts carry a name, entries a
  -- vendor id; both reduce to this), and as it was typed, for display.
  vendor_key       text not null check (vendor_key <> ''),
  vendor_name      text not null,
  allocation_basis text not null check (btrim(allocation_basis) <> ''),
  updated_by       uuid references auth.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (fund_id, from_vehicle_id, to_vehicle_id, vendor_key)
);

-- Read and written only by the accounting routes and agent tools, with the service-role key, behind
-- the same gate as the receipts and invoices it annotates. So, like them, service_role alone, RLS on
-- and no authenticated policies.
revoke all on public.partnership_allocation_rules from anon, authenticated;
grant select, insert, update, delete on public.partnership_allocation_rules to service_role;
alter table public.partnership_allocation_rules enable row level security;
