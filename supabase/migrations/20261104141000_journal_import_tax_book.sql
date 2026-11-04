-- Route an outside journal's tax-basis entries to the tax book at import time.
--
-- Some funds' QuickBooks files are kept on a TAX basis by their preparer: at year end the preparer
-- books the K-1 entries — a lower-tier fund's pass-through income or loss against the investment
-- account and a K-1 income account, tax-basis write-offs. Imported into the actual (fair-value)
-- book those distort book capital, and had to be reversed by hand after every import.
--
-- `tax_book` marks a source account as tax-only. A source transaction that touches ANY such
-- account is imported, whole, into book 'tax' (lib/accounting/quickbooks/book-routing.ts). An
-- entry lives in one book and must balance there, so a transaction is never split across books.
--
-- EXPAND ONLY, safe to apply before or after the release that reads it:
--   * the column defaults to false, which is today's behaviour (everything into 'actual');
--   * the current release's upsert names its columns and never mentions tax_book, so a row it
--     rewrites keeps whatever flag it had.

alter table public.qb_account_mappings
  add column if not exists tax_book boolean not null default false;

comment on column public.qb_account_mappings.tax_book is
  'Source account kept on a tax basis only. A transaction touching it imports into the tax book (book = ''tax''), whole, instead of the actual ledger. Ignored when excluded.';

-- One QuickBooks transaction, one entry, whichever book it went to.
--
-- The duplicate guard from 20261006164431 was scoped per book. Nothing wrote a qb: ref into the
-- tax book then, so that was the same thing as "per vehicle". Now the same transaction can be
-- routed to either book, depending on a mapping flag that can change between passes, so the guard
-- has to look at both. Otherwise two overlapping imports run either side of a flag change could
-- land the transaction in both books, and the overlay would count it twice.
--
-- The current release only writes qb: refs into the actual book, so it cannot trip the wider
-- check: this is safe to apply before the deploy. A trigger only sees new rows; existing ones are
-- not re-validated.
create or replace function public.prevent_duplicate_qb_import() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.source_ref like 'qb:%' and new.status <> 'void' then
    perform pg_advisory_xact_lock(hashtextextended(new.fund_id::text || ':' || new.vehicle_id::text || ':' || new.source_ref, 0));
    if exists (select 1 from public.journal_entries e where e.fund_id = new.fund_id and e.vehicle_id = new.vehicle_id and e.source_ref = new.source_ref and e.status <> 'void' and e.id <> new.id) then
      raise exception 'This QuickBooks transaction has already been imported';
    end if;
  end if;
  return new;
end;
$$;

-- No grant or policy changes: qb_account_mappings keeps the grants and RLS from
-- 20260807000000_quickbooks_import.sql, and the trigger stays attached across `create or replace`.
