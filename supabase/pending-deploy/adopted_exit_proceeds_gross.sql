-- PENDING DEPLOY — do not move into supabase/migrations/ until this release is live:
--
--   The release in which lib/portfolio/proceeds.ts defines `proceeds_received` as GROSS proceeds
--   (escrow included), lib/accounting/from-portfolio.ts `exitPostings` books gross − escrow to cash,
--   and lib/accounting/adopt.ts stores an adopted exit's proceeds_received as basis + gain.
--
-- Why it must wait: the deployed release builds an exit's entry with proceeds_received as the cash
-- received. Restated as gross before the new derivation ships, an edit of one of these rows would
-- re-book the escrow on top of the gross (the very overstatement this release fixes).
--
-- OPTIONAL, and the owner's call. Review the rows first with
--   npx tsx --env-file=.env.local scripts/diagnose-escrow-exits.ts
-- (entry owner "adopted"), or the preview query below.
--
-- When moving it: rename to a current timestamp, e.g. supabase/migrations/<now>_adopted_exit_proceeds_gross.sql.
--
-- What it does: an exit ADOPTED from a journal entry (a QuickBooks import, a hand entry) was stored
-- by the old adopt.ts as proceeds_received = basis + gain − escrow — the cash, not the gross. The
-- journal entry it came from is right and is NOT touched. Only the tracker row is restated to the
-- one meaning (proceeds_received + proceeds_escrow), so the tracker's realized proceeds, MOIC and
-- DPI stop understating the exit by its escrow, and an edit of the row re-derives the same entry
-- instead of being refused as "can't be split".
--
-- Only rows still owned by a live adopted entry: an edit retracts the adoption and clears
-- adopted_entry_id, so these rows are exactly as adoption wrote them.
--
-- Preview:
--   select t.id, t.fund_id, t.portfolio_group, t.transaction_date, t.proceeds_received, t.proceeds_escrow,
--          t.proceeds_received + t.proceeds_escrow as gross
--     from public.investment_transactions t
--     join public.journal_entries e on e.id = t.adopted_entry_id and e.status <> 'void'
--    where t.transaction_type = 'proceeds' and coalesce(t.proceeds_escrow, 0) > 0;

update public.investment_transactions t
   set proceeds_received = coalesce(t.proceeds_received, 0) + t.proceeds_escrow,
       updated_at = now()
  from public.journal_entries e
 where e.id = t.adopted_entry_id
   and e.status <> 'void'
   and t.transaction_type = 'proceeds'
   and coalesce(t.proceeds_escrow, 0) > 0;
