-- Master admin pool: any member counts, not only admins (lib/agent/master-admin.ts).
--
-- master_admin_pool(emails) used to return only the funds where a listed address is an admin, so
-- a listed address that was only a member of its fund got no fund switching. The pool is chosen by
-- the deployment owner through MASTER_ADMIN_EMAILS, so that list is where the strictness lives: a
-- listed address now joins the pool from any membership. It still acts in each fund as that
-- fund's listed member, with that member's own role and grants, re-read on every call.
--
-- The function now also returns the role, so when two listed addresses share a fund the admin is
-- the one the connection acts as. A changed return type cannot be replaced in place, hence the drop.

drop function if exists public.master_admin_pool(text[]);

create function public.master_admin_pool(p_emails text[])
returns table (user_id uuid, email text, fund_id uuid, fund_name text, role text)
language sql
stable
security definer
set search_path = public
as $$
  select u.id, lower(u.email)::text, m.fund_id, f.name, m.role::text
    from auth.users u
    join fund_members m on m.user_id = u.id
    join funds f on f.id = m.fund_id
   where lower(u.email) = any (select lower(e) from unnest(p_emails) e)
   order by f.name
$$;

revoke execute on function public.master_admin_pool(text[]) from public, anon, authenticated;
grant execute on function public.master_admin_pool(text[]) to service_role;
