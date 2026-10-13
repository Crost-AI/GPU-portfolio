-- An agent `allocation` posting can be live at most once.
--
-- The `allocation` agent tool posted with no source_ref, so two chat sessions asked for the same
-- carry reallocation each booked it — in production that doubled $209,207.98 of entries. The tool
-- now stamps every entry with a deterministic ref derived from its action, date and lines
-- (`agent-allocation:<action>:<hash>`, lib/accounting/allocation-actions.ts) and refuses one that
-- is already live. This index is the race-proof half: two posts in flight at once cannot both land.
--
-- WHY ONLY THIS NAMESPACE, not every source_ref. Several refs are legitimately shared by many live
-- entries in one vehicle: a close tags every entry it posts `close:<periodId>` (allocations,
-- accruals, carry), the partner opening is one per DATE (journal_entries_partner_opening_once_per_date,
-- 20261006200000), and the journal route accepts a free-text source_ref from the user. A blanket
-- (fund, vehicle, book, source_ref) unique index would fail to build on existing data and then
-- refuse the next close. `qb:` refs have their own trigger (20261006164431).
--
-- SAFE ON EXISTING DATA. No release before this one wrote the `agent-allocation:` prefix, so there
-- is nothing to collide; the check below still refuses with a readable list rather than letting
-- the index build fail with a bare 23505 if that is ever not true.
--
-- The double-bookings that motivated this carry NO source_ref and are untouched by it; review and
-- void them by hand. To list candidates (same vehicle, date, memo and total, both live):
--
--   select e.fund_id, e.vehicle_id, e.entry_date, e.memo, array_agg(e.id order by e.created_at) ids
--     from journal_entries e
--     join lateral (select sum(abs(p.amount)) t from journal_postings p where p.journal_entry_id = e.id) s on true
--    where e.book = 'actual' and e.status <> 'void'
--    group by e.fund_id, e.vehicle_id, e.entry_date, e.memo, s.t
--   having count(*) > 1;

do $$
declare
  dupes text;
begin
  select string_agg(format('%s (vehicle %s, entries %s)', source_ref, vehicle_id, ids), '; ')
    into dupes
    from (
      select vehicle_id, source_ref, string_agg(id::text, ', ' order by created_at) ids
        from public.journal_entries
       where source_ref like 'agent-allocation:%' and status <> 'void'
       group by fund_id, vehicle_id, book, source_ref
      having count(*) > 1
    ) d;
  if dupes is not null then
    raise exception 'Duplicate live agent allocation entries must be voided before this index can be built: %', dupes;
  end if;
end;
$$;

create unique index if not exists journal_entries_agent_allocation_once
  on public.journal_entries (fund_id, vehicle_id, book, source_ref)
  where source_ref like 'agent-allocation:%' and status <> 'void';
