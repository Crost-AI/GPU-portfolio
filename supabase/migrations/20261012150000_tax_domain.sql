-- Tax becomes its own access area.
--
-- Until now the tax module (book-to-tax adjustments, the tax-year close, K-1 packages, partner tax
-- forms, K-1 delivery, received K-1s) was gated on `accounting` or `lp_capital` plus the
-- `tax_reporting` switch. That made a tax preparer an all-or-nothing grant: to post an adjustment
-- or generate a K-1 they needed Fund accounting WRITE, which is also the journal, the bank and the
-- period close. The new `tax` domain lets an admin grant "read the books, do the tax work" without
-- "change the books". See DOMAIN_META.tax in lib/access/domains.ts.
--
-- Nothing changes for anyone on the day this lands: every fund's default and every member's grant
-- for `tax` is copied from what they hold for `accounting`, so each person keeps exactly the tax
-- access they had. Admins then narrow or widen it per person.
--
-- Deploy order does not matter. Until this is pushed, the app falls back to a member's accounting
-- level for `tax` (DOMAIN_META.tax.defaultFrom), which is the same answer this migration writes.
--
-- The tax tables themselves are service-role only (20260903160000), so no RLS policy reads this
-- domain and `domain_access()` needs no change. The rule that `tax` requires reading the books
-- (DOMAIN_META.tax.requires) lives in the TypeScript resolver, which is the only one that gates tax.

-- 1. The domain's fund-level switch. Restated in full (rls-domain-policies.test.ts compares the
--    last definition's CASE arms with DOMAIN_META.primaryFeature).
create or replace function public.domain_primary_feature(p_domain text)
returns text
language sql
immutable
parallel safe
as $$
  select case p_domain
    when 'dealflow'           then 'deals'
    when 'diligence'          then 'diligence'
    when 'accounting'         then 'accounting'
    when 'management_company' then 'management_company'
    when 'lp_capital'         then 'lps'
    when 'gp_economics'       then 'gp_economics'
    when 'compliance'         then 'compliance'
    when 'tax'                then 'tax_reporting'
    else null
  end;
$$;

-- 2. Every existing fund's default for `tax` is its default for `accounting`.
insert into public.fund_domain_defaults (fund_id, domain, level)
select f.id, 'tax', coalesce(d.level, 'write')
from funds f
left join public.fund_domain_defaults d on d.fund_id = f.id and d.domain = 'accounting'
on conflict (fund_id, domain) do nothing;

-- 3. Every member's explicit accounting grant becomes their tax grant, so nobody gains or loses.
insert into public.fund_member_access (fund_id, user_id, domain, level, updated_by)
select a.fund_id, a.user_id, 'tax', a.level, a.updated_by
from public.fund_member_access a
where a.domain = 'accounting'
on conflict (fund_id, user_id, domain) do nothing;

-- 4. New funds. Restated in full (it is a `create or replace`); `tax` seeds at 'write' like
--    `accounting`, because a new fund's members get the books at 'write' too.
create or replace function public.seed_fund_domain_defaults()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.fund_domain_defaults (fund_id, domain, level)
  select new.id, d.domain, d.level
  from (values
    ('portfolio', 'write'), ('relationships', 'write'), ('dealflow', 'write'),
    ('diligence', 'write'), ('accounting', 'write'), ('lp_capital', 'write'),
    ('gp_economics', 'write'), ('lp_relations', 'write'), ('compliance', 'write'),
    ('tax', 'write'),
    -- The firm's own books, including payroll. Granted per person, never by default.
    ('management_company', 'none')
  ) as d(domain, level)
  on conflict (fund_id, domain) do nothing;
  return new;
end;
$$;

-- `create or replace` keeps the function's privileges, so the execute revoke in
-- 20261011200000_security_definer_execute_lockdown.sql still holds. Restated anyway, so this file
-- is safe to read on its own.
revoke execute on function public.seed_fund_domain_defaults() from public, anon, authenticated;
