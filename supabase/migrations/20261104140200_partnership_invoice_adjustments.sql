-- Adjustments on a partnership-expense invoice: lines typed by hand that change what the fund is
-- asked to pay without billing an expense. The case they exist for: a quarter's invoice asked for
-- more than the books said, the fund paid it, and the next quarter's invoice gives the difference
-- back as a credit (a negative amount). An amount owed from earlier is a positive one.
--
-- An adjustment is NOT booked. The expenses already are, on both sides, at what the books say; the
-- overpayment sits in the intercompany accounts (a credit on the biller's Due from, a debit on the
-- fund's Due to). So issuing still books the expenses only (partnership_invoices.amount), and
-- settling the charge moves the amount due, amount + adjustment_total, which clears both.
--
-- ADDITIVE AND SAFE BEFORE DEPLOY, and safe to paste twice. A not-null column with a default
-- of 0 and a table the live release never reads.

alter table public.partnership_invoices add column if not exists adjustment_total numeric(20, 2) not null default 0;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'partnership_invoice_amount_due_not_negative') then
    alter table public.partnership_invoices
      add constraint partnership_invoice_amount_due_not_negative check (amount + adjustment_total >= 0);
  end if;
end $$;

create table if not exists public.partnership_invoice_adjustments (
  id           uuid primary key default gen_random_uuid(),
  fund_id      uuid not null references funds(id) on delete cascade,
  invoice_id   uuid not null references public.partnership_invoices(id) on delete cascade,
  -- Printed on the invoice: "Credit for Q2 2026 overbilling".
  description  text not null check (btrim(description) <> ''),
  -- Negative is a credit to the fund, positive a further charge.
  amount       numeric(20, 2) not null check (amount <> 0),
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now()
);

create index if not exists partnership_invoice_adjustments_invoice_idx
  on public.partnership_invoice_adjustments (invoice_id);

-- Read and written only by the accounting routes and agent tools with the service-role key, like the
-- invoices they belong to: service_role alone, RLS on and no authenticated policies.
revoke all on public.partnership_invoice_adjustments from anon, authenticated;
grant select, insert, update, delete on public.partnership_invoice_adjustments to service_role;
alter table public.partnership_invoice_adjustments enable row level security;
