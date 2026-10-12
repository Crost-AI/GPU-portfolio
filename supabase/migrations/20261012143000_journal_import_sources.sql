-- Outside journals from more than one book of record: QuickBooks, and now Carta's fund-admin GL.
--
-- Both feed the same mapping → draft-import pipeline (lib/accounting/quickbooks/import-journal.ts),
-- usually from a connector running outside this repo and calling the import_journal agent tool.
-- `source` keeps them apart: each source has its own account mapping, so a Carta account that
-- shares a name with a QuickBooks one cannot silently inherit its mapping.
--
-- EXPAND ONLY. Safe to apply before or after the release that reads `source`:
--   * existing rows, and anything the current release inserts, default to 'quickbooks';
--   * the old unique (fund_id, vehicle_id, qb_account) stays, so the current release's upsert
--     (onConflict on those three columns) keeps working.
-- Dropping the old constraint, which is what finally lets two sources share an account name in one
-- vehicle, waits for that release: supabase/pending-deploy/journal_import_sources_contract.sql.

alter table public.qb_account_mappings
  add column if not exists source text not null default 'quickbooks'
  check (source in ('quickbooks', 'carta'));

-- The arbiter the new upsert names (onConflict: 'fund_id,vehicle_id,source,qb_account').
-- vehicle_id is nullable; a NULL never conflicts, exactly as under the original constraint.
create unique index if not exists qb_account_mappings_source_key
  on public.qb_account_mappings (fund_id, vehicle_id, source, qb_account);

alter table public.qb_import_runs
  add column if not exists source text not null default 'quickbooks'
  check (source in ('quickbooks', 'carta'));

-- No grant or policy changes: both tables keep the grants and RLS from
-- 20260807000000_quickbooks_import.sql. Adding a column does not touch either.
