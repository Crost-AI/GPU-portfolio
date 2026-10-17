-- The signup allow-list, per fund.
--
-- allowed_signups had no fund_id, so every fund's admins listed, added to and deleted from one
-- shared list: each saw the others' addresses and domains, and could remove them. Each entry now
-- belongs to the fund that added it, and the settings page scopes to the caller's fund.
--
-- The signup gate itself (hook_before_user_created, /api/auth/signup) is unchanged: an address on
-- ANY fund's list may create an account, because an account has to exist before it can join a fund.
--
-- Safe to apply before the release that uses it: the column is nullable, and the current release
-- inserts without it and reads without filtering on it. Apply it BEFORE deploying that release,
-- which writes fund_id.

alter table public.allowed_signups
  add column if not exists fund_id uuid references public.funds(id) on delete cascade;

create index if not exists allowed_signups_fund_idx on public.allowed_signups (fund_id);

-- One pattern per fund, not one per deployment: two funds may each allow the same domain. NULLS
-- NOT DISTINCT keeps unassigned rows unique too.
do $$
declare c text;
begin
  for c in
    select con.conname from pg_constraint con
    where con.conrelid = 'public.allowed_signups'::regclass and con.contype = 'u'
      and pg_get_constraintdef(con.oid) = 'UNIQUE (email_pattern)'
  loop
    execute format('alter table public.allowed_signups drop constraint %I', c);
  end loop;
end $$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'allowed_signups_fund_pattern_key') then
    alter table public.allowed_signups
      add constraint allowed_signups_fund_pattern_key unique nulls not distinct (fund_id, email_pattern);
  end if;
end $$;

-- Backfill: give each existing entry the fund (or funds) it evidently belongs to.
--   1. An exact address that is a fund member's: that member's fund.
--   2. A '*@domain' pattern: every fund whose email_domain is that domain, or that has a member
--      at that domain. The first such fund takes the row; each further one gets a copy.
--   3. With only one fund in the deployment, every remaining row is that fund's.
-- Anything left has no fund: it still lets that address sign up, but no fund's settings show it.

with matches as (
  select s.id, fm.fund_id
  from public.allowed_signups s
  join auth.users u on lower(u.email) = s.email_pattern
  join public.fund_members fm on fm.user_id = u.id
  where s.fund_id is null and s.email_pattern not like '*@%'
  union
  select s.id, f.id
  from public.allowed_signups s
  join public.funds f on lower(f.email_domain) = substr(s.email_pattern, 3)
  where s.fund_id is null and s.email_pattern like '*@%'
  union
  select s.id, fm.fund_id
  from public.allowed_signups s
  join auth.users u on split_part(lower(u.email), '@', 2) = substr(s.email_pattern, 3)
  join public.fund_members fm on fm.user_id = u.id
  where s.fund_id is null and s.email_pattern like '*@%'
),
ranked as (
  select id, fund_id, row_number() over (partition by id order by fund_id) as n from matches
),
copies as (
  insert into public.allowed_signups (email_pattern, fund_id, created_at)
  select s.email_pattern, r.fund_id, s.created_at
  from ranked r join public.allowed_signups s on s.id = r.id
  where r.n > 1
  on conflict do nothing
  returning id
)
update public.allowed_signups s
set fund_id = r.fund_id
from ranked r
where r.id = s.id and r.n = 1;

update public.allowed_signups
set fund_id = (select id from public.funds limit 1)
where fund_id is null and (select count(*) from public.funds) = 1;

comment on column public.allowed_signups.fund_id is
  'The fund whose admins manage this entry. Null for an entry no fund could be matched to: it still passes the signup gate, and no fund''s settings show it.';
