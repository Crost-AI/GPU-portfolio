-- Entries whose P&L posting deliberately did NOT allocate to partners, and why.
--
-- Posting allocates an entry's income and expense to partners' capital at once
-- (lib/accounting/continuous-allocation.ts) and records each allocation in
-- journal_entry_allocations. The period close then catches up any posted P&L with no such row.
-- Two kinds of entry are left unallocated on purpose, and without a record the close's catch-up
-- could not tell them from P&L that was simply never allocated — so it allocated them anyway:
--
--   allocation_off   posted with `allocate: false` — an import (QuickBooks, Carta) whose source
--                    books already carry each partner's capital lines, or never split income
--                    by partner.
--   self_allocated   the entry posts its own allocation: lines on 3200 Undistributed earnings
--                    and the partners' capital accounts (the compound form in ACCOUNTING.md).
--
-- One row per source entry. Written when the entry posts; deleted when it is unposted or voided,
-- so the next post decides again. Service-role only, like journal_entry_allocations.

create table public.journal_entry_allocation_skips (
  source_entry_id  uuid primary key references public.journal_entries(id) on delete cascade,
  fund_id          uuid not null references public.funds(id) on delete cascade,
  vehicle_id       uuid not null references public.fund_vehicles(id) on delete cascade,
  reason           text not null check (reason in ('allocation_off', 'self_allocated')),
  created_at       timestamptz not null default now()
);

create index journal_entry_allocation_skips_vehicle_idx
  on public.journal_entry_allocation_skips (fund_id, vehicle_id);

-- Service-role only: written by posting, read by the close.
alter table public.journal_entry_allocation_skips enable row level security;
revoke all on public.journal_entry_allocation_skips from anon, authenticated;
grant select, insert, update, delete on public.journal_entry_allocation_skips to service_role;

comment on table public.journal_entry_allocation_skips is
  'Posted entries whose P&L was deliberately not allocated on posting (allocation turned off, or the entry carries its own allocation lines); the close does not catch them up.';

-- Backfill what can be known. A bulk post with allocation off (journal Post all, or the agent's
-- post_drafts with allocate: false) has been audited since 20261010200000 as `entries.bulk_post`
-- with details.allocate = false and the posted ids in details.entryIds. An entry from such a post
-- that is still posted and has no allocation row was posted with allocation off and never
-- re-posted with it on. Earlier posts left no record and cannot be told apart here; the close
-- reports imported entries among them instead of allocating them (lib/accounting/close.ts).
insert into public.journal_entry_allocation_skips (source_entry_id, fund_id, vehicle_id, reason)
select distinct je.id, je.fund_id, je.vehicle_id, 'allocation_off'
from public.accounting_audit_events a
cross join lateral jsonb_array_elements_text(
  case when jsonb_typeof(a.details -> 'entryIds') = 'array' then a.details -> 'entryIds' else '[]'::jsonb end
) as posted(entry_id)
-- Compared as text: a cast would fail the whole migration on one malformed id.
join public.journal_entries je
  on je.id::text = lower(posted.entry_id)
 and je.fund_id = a.fund_id
where a.action = 'entries.bulk_post'
  and a.details ->> 'allocate' = 'false'
  and je.status = 'posted'
  and je.book = 'actual'
  and je.vehicle_id is not null
  and not exists (select 1 from public.journal_entry_allocations x where x.source_entry_id = je.id)
on conflict (source_entry_id) do nothing;
