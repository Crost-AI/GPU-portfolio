-- SECURITY DEFINER functions that were only revoked FROM PUBLIC.
--
-- `revoke execute ... from public` is not enough on Supabase: the platform's default privileges
-- grant EXECUTE on every new function in `public` DIRECTLY to anon and authenticated (and
-- service_role), and a revoke from PUBLIC does not touch a direct grant. So these stayed callable
-- through PostgREST (`/rest/v1/rpc/<name>`) with the anon key that ships to the browser.
--
-- hook_before_user_created is the one that matters: it is a yes/no oracle over the GP signup
-- whitelist (allowed_signups) and the LP invite list (lp_accounts) — POST any email to
-- /rest/v1/rpc/hook_before_user_created and the answer says whether it is an invited LP or an
-- allowed GP domain. Only Supabase Auth (supabase_auth_admin) should call it.
--
-- Scanned: every SECURITY DEFINER function in supabase/migrations, latest definition of each.
-- Included here (revoked from public, anon AND authenticated):
--   hook_before_user_created(jsonb)      auth hook; caller is supabase_auth_admin only.
--   add_fund_creator_as_member()         trigger functions. A trigger fires without the
--   company_updates_follow_inbound_email() caller needing EXECUTE (it is checked only at
--   seed_fund_domain_defaults()          CREATE TRIGGER, by the owner), so revoking cannot break
--                                        them; it only removes them from the RPC surface.
-- Deliberately NOT included (authenticated must keep EXECUTE):
--   get_my_fund_ids(), is_fund_admin(uuid), is_fund_writer(uuid) — RLS helpers called from
--   policies. A policy expression runs as the querying role, so revoking EXECUTE from
--   authenticated would make every policy that calls them error, i.e. break RLS. All three are
--   self-scoped on auth.uid() and reveal nothing about anyone but the caller.
--   access_context, domain_access, can_read_domain/can_write_domain, fund_ids_readable/writable,
--   *_ids_readable(), member_fund_ids(), unscoped_fund_ids(), is_fund_member() — already revoked
--   from anon and granted to authenticated on purpose (self-scoped RLS/access helpers).
-- Every other SECURITY DEFINER function already revokes from anon and authenticated explicitly.

revoke execute on function public.hook_before_user_created(jsonb) from public, anon, authenticated;
grant execute on function public.hook_before_user_created(jsonb) to supabase_auth_admin;

revoke execute on function public.add_fund_creator_as_member() from public, anon, authenticated;
revoke execute on function public.company_updates_follow_inbound_email() from public, anon, authenticated;
revoke execute on function public.seed_fund_domain_defaults() from public, anon, authenticated;
