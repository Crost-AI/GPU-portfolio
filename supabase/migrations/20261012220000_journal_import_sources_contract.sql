-- Contract half of 20261012210000_journal_import_sources.sql. Mappings are now unique per
-- (fund, entity, source, account), so a Carta account may share a name with a QuickBooks one.
--
-- Apply only once the release that upserts qb_account_mappings with onConflict
-- 'fund_id,vehicle_id,source,qb_account' is live (lib/accounting/quickbooks/import-journal.ts).
-- The release before it needs this constraint as its upsert arbiter.

alter table public.qb_account_mappings
  drop constraint if exists qb_account_mappings_fund_id_vehicle_id_qb_account_key;
