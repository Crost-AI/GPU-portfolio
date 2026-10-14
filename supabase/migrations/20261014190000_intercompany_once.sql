-- An invoice books its fund side once, and a charge is settled once per vehicle.
--
-- ISSUING. `issuePartnershipInvoice` read the invoice, checked it was a draft, posted the fund's
-- side as a new intercompany charge, then marked the invoice issued. Two requests in flight (a
-- double click, the agent and a person) both saw a draft and both posted: two charges, two fund
-- entries, one invoice. The charge now carries the invoice it books, and this index lets only one
-- live charge per invoice exist; the second insert fails with 23505 before anything is posted.
--
-- SETTLING. `settleIntercompanyCharge` checked `status = 'accrued'` in a separate read, then posted
-- the cash on both sides tagged `intercompany:<chargeId>`, the same ref as the accrual, which no
-- index could constrain without also refusing the accrual. Settlement entries now carry their own
-- ref, `intercompany-settlement:<chargeId>`, and this index allows one live one per vehicle. Same
-- shape as journal_entries_agent_allocation_once (20261013141500), for the same reason: only this
-- namespace, because other refs are legitimately shared by many live entries.
--
-- SAFE ON EXISTING DATA. The column is new, so every existing row is null and outside the first
-- index. No release before this one wrote the `intercompany-settlement:` prefix; the check below
-- still refuses with a readable list rather than a bare 23505 if that is ever not true.
--
-- LEGACY SETTLEMENTS ARE NOT BACKFILLED. Settlement entries written before this release carry
-- `intercompany:<chargeId>` with source_type 'intercompany_settlement'. Renaming them here would run
-- into journal_entries_period_lock (20260714000004), which refuses any update to an entry dated in
-- a closed period, whatever column changes. `settleIntercompanyCharge` recognises the old ref
-- instead, so a charge whose cash was booked under it is finished, never posted again.
--
-- Existing tables: the Data API grants on both are already in place.

alter table public.intercompany_transactions
  add column if not exists partnership_invoice_id uuid
    references public.partnership_invoices(id) on delete set null;

comment on column public.intercompany_transactions.partnership_invoice_id is
  'The partnership invoice this charge books. One live charge per invoice: the identity that makes issuing an invoice idempotent.';

create unique index if not exists intercompany_transactions_invoice_once
  on public.intercompany_transactions (partnership_invoice_id)
  where partnership_invoice_id is not null and status <> 'void';

do $$
declare
  dupes text;
begin
  select string_agg(format('%s (vehicle %s, entries %s)', source_ref, vehicle_id, ids), '; ')
    into dupes
    from (
      select vehicle_id, source_ref, string_agg(id::text, ', ' order by created_at) ids
        from public.journal_entries
       where source_ref like 'intercompany-settlement:%' and status <> 'void'
       group by fund_id, vehicle_id, book, source_ref
      having count(*) > 1
    ) d;
  if dupes is not null then
    raise exception 'Duplicate live intercompany settlement entries must be voided before this index can be built: %', dupes;
  end if;
end;
$$;

create unique index if not exists journal_entries_intercompany_settlement_once
  on public.journal_entries (fund_id, vehicle_id, book, source_ref)
  where source_ref like 'intercompany-settlement:%' and status <> 'void';
