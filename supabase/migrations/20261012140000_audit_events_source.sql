-- Which door each recorded change came through: the web app, the API (the agent REST endpoint and
-- /api/v1), or MCP (Claude, ChatGPT and other assistants). See lib/audit/source.ts.
--
-- Nullable with no default: every event recorded before this column existed was written without
-- knowing its source, and stamping them all 'web' would claim something nobody recorded. The app
-- writes the column on every new event. Until this is pushed, the app writes the source into
-- `details` instead (lib/audit/events.ts), so the deploy and the push may land in either order.
--
-- Adding a column fires no row trigger, so the append-only guard on this table is untouched.

alter table public.accounting_audit_events
  add column if not exists source text;

alter table public.accounting_audit_events
  drop constraint if exists accounting_audit_events_source_chk;
alter table public.accounting_audit_events
  add constraint accounting_audit_events_source_chk
  check (source is null or source in ('web', 'api', 'mcp'));
