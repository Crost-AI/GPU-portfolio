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

-- Backfill: give an existing entry a fund only where its owner is unambiguous. A row is never
-- copied to a second fund, and a fund is never inferred from its members' own addresses: a member's
-- personal or former-employer domain would otherwise put one fund's wildcard on another fund's list
-- (Crost #130).
--   1. An exact address that is a member of exactly one fund: that fund.
--   2. A '*@domain' pattern that exactly one fund claims as its email_domain, unless the domain is a
--      consumer mailbox (the list is lib/onboarding/wizard.ts PUBLIC_EMAIL_DOMAINS and
--      PUBLIC_EMAIL_FAMILIES; tests/signup-allowlist-per-fund.test.ts keeps the two in step).
--   3. With only one fund in the deployment, every remaining row is that fund's.
-- Anything else keeps a NULL fund: it still lets that address sign up, but no fund's settings show it.

with exact_owner as (
  select s.id, min(fm.fund_id::text)::uuid as fund_id
  from public.allowed_signups s
  join auth.users u on lower(u.email) = s.email_pattern
  join public.fund_members fm on fm.user_id = u.id
  where s.fund_id is null and s.email_pattern not like '*@%'
  group by s.id
  having count(distinct fm.fund_id) = 1
),
domain_owner as (
  select s.id, min(f.id::text)::uuid as fund_id
  from public.allowed_signups s
  join public.funds f on lower(btrim(f.email_domain)) = substr(s.email_pattern, 3)
  where s.fund_id is null and s.email_pattern like '*@%'
    and substr(s.email_pattern, 3) <> all (array[
    'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'passport.com', 'yahoo.com',
    'ymail.com', 'rocketmail.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'aim.com', 'proton.me',
    'protonmail.com', 'protonmail.ch', 'pm.me', 'gmx.com', 'gmx.net', 'gmx.de', 'web.de', 'zoho.com',
    'zohomail.com', 'yandex.com', 'yandex.ru', 'mail.ru', 'mail.com', 'fastmail.com', 'fastmail.fm', 'hey.com',
    'tutanota.com', 'tuta.io', 'qq.com', '163.com', '126.com', 'naver.com', 'hanmail.net', 'comcast.net',
    'verizon.net', 'att.net', 'sbcglobal.net', 'btinternet.com'
    ])
    and substr(s.email_pattern, 3) !~ '^(gmx|yahoo|hotmail|outlook|live|googlemail|aol|yandex)\.[a-z.]{2,6}$'
  group by s.id
  having count(distinct f.id) = 1
),
owners as (
  select id, fund_id from exact_owner
  union all
  select id, fund_id from domain_owner
)
update public.allowed_signups s
set fund_id = o.fund_id
from owners o
where o.id = s.id;

update public.allowed_signups
set fund_id = (select id from public.funds limit 1)
where fund_id is null and (select count(*) from public.funds) = 1;

comment on column public.allowed_signups.fund_id is
  'The fund whose admins manage this entry. Null for an entry no fund could be matched to: it still passes the signup gate, and no fund''s settings show it.';
