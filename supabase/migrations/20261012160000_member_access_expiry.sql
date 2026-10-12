-- Access that ends on a date, for the people a fund lets in for one engagement: an auditor for the
-- year-end audit, a tax preparer for the filing season.
--
-- `fund_members.access_expires_at`: null means no end date (everyone today). Once it passes:
--   * `access_context` stops returning the membership, so every surface the app gates — /api via
--     the middleware, server pages, MCP and API keys — treats them as belonging to no fund, at once;
--   * the access-expiry cron (app/api/cron/access-expiry) then removes the membership, the same way
--     an admin removing them would, which also closes the browser-side Data API paths that read
--     `fund_members` directly.
--
-- Admins never expire: a fund whose last admin timed out would have nobody able to let anyone back
-- in. The settings route refuses to set a date on an admin, and both checks below ignore one.
--
-- Deploy order: the app reads this column through `select('*')` and treats it as absent until the
-- push, and the settings route says to run migrations if an admin tries to set a date before then.

alter table public.fund_members
  add column if not exists access_expires_at timestamptz;

comment on column public.fund_members.access_expires_at is
  'When this member''s access ends; null for no end date. Ignored for admins. After it passes, '
  'access_context stops resolving the membership and the access-expiry cron removes it.';

-- Restated in full from 20261007100000_entity_access_grants.sql; the only change is the expiry
-- clause in the final WHERE.
create or replace function public.access_context(p_user_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_target uuid;
  v_result jsonb;
begin
  -- Own context always; someone else's only for the service role (no JWT identity). See
  -- 20260716000009_access_context_rpc.sql.
  v_target := coalesce(p_user_id, auth.uid());
  if auth.uid() is not null and v_target <> auth.uid() then
    raise exception 'access_context: you may only resolve your own access';
  end if;
  if v_target is null then
    return null;
  end if;

  select jsonb_build_object(
    'fund_id', m.fund_id,
    'role', m.role,
    'features', coalesce(fs.feature_visibility, '{}'::jsonb),
    'grants', coalesce(
      (select jsonb_object_agg(a.domain, a.level)
         from fund_member_access a
        where a.fund_id = m.fund_id and a.user_id = m.user_id),
      '{}'::jsonb),
    'defaults', coalesce(
      (select jsonb_object_agg(d.domain, d.level)
         from fund_domain_defaults d
        where d.fund_id = m.fund_id),
      '{}'::jsonb),
    'vehicles', coalesce(
      (select jsonb_agg(v.id order by v.id)
         from fund_vehicles v
        where v.fund_id = m.fund_id
          and (m.role in ('admin', 'viewer') or m.all_entities
               or exists (select 1 from fund_member_vehicles g
                           where g.fund_id = m.fund_id and g.user_id = m.user_id and g.vehicle_id = v.id))),
      '[]'::jsonb),
    -- Unscoped: an admin, the read-only demo viewer, or a member holding the "All entities" grant.
    -- They see everything — unassigned companies, rows with no entity, and entities created later.
    'vehicles_all', m.role in ('admin', 'viewer') or m.all_entities
  )
  into v_result
  from fund_members m
  left join fund_settings fs on fs.fund_id = m.fund_id
  where m.user_id = v_target
    -- Expired access resolves to no fund at all. Admins never expire.
    and (m.role = 'admin' or m.access_expires_at is null or m.access_expires_at > now());

  return v_result;
end;
$$;

revoke execute on function public.access_context(uuid) from public, anon;
grant execute on function public.access_context(uuid) to authenticated, service_role;

create index if not exists fund_members_access_expires_idx
  on public.fund_members (access_expires_at)
  where access_expires_at is not null;
