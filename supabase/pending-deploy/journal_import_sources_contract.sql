-- PENDING DEPLOY — do not move into supabase/migrations/ until the release that upserts
-- qb_account_mappings with onConflict 'fund_id,vehicle_id,source,qb_account' is live
-- (the "journal import sources" change: lib/accounting/quickbooks/import-journal.ts).
--
-- The release before it upserts with onConflict 'fund_id,vehicle_id,qb_account', which needs this
-- constraint as its arbiter; dropping it while that release still serves would make every mapping
-- save on the QuickBooks page fail.
--
-- When moving it, rename it to a current timestamp, e.g. supabase/migrations/<ts>_journal_import_sources_contract.sql.

alter table public.qb_account_mappings
  drop constraint if exists qb_account_mappings_fund_id_vehicle_id_qb_account_key;
