-- The investor connector: an LP's own portal over MCP, so an investor can ask Claude or ChatGPT
-- about their position, statements, letters, documents and capital calls, acknowledge a wire and
-- message the fund (app/api/portal/mcp).
--
-- 1. A per-fund switch, OFF by default. It needs the LP portal on as well: the connector shows an
--    investor nothing the portal would not. Additive: the current release never reads it, so this
--    is safe to apply before the deploy that does.
alter table public.fund_settings
  add column if not exists lp_agent_enabled boolean not null default false;

comment on column public.fund_settings.lp_agent_enabled is
  'Investor connector (Claude, ChatGPT) for the LP portal. Off by default; needs lp_portal_enabled too.';

-- 2. The LP access log records two more things an investor does: acknowledging a capital call
--    wire, and messaging the fund. Which way they came in (the web portal or the connector) is in
--    metadata.source, so no column is needed for it. Widening a check is safe before the deploy.
alter table public.lp_access_events drop constraint if exists lp_access_events_event_type_check;
alter table public.lp_access_events add constraint lp_access_events_event_type_check
  check (event_type in ('login', 'view', 'download', 'upload', 'acknowledge', 'message'));

alter table public.lp_access_events drop constraint if exists lp_access_events_target_type_check;
alter table public.lp_access_events add constraint lp_access_events_target_type_check
  check (target_type in ('portal', 'snapshot', 'letter', 'document', 'capital_call'));
