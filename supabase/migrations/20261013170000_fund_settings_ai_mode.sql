-- How AI runs for a fund: with a server key ('server_key'), or with no key, through the admin's
-- own assistant over MCP ('assistant'). Null until an admin chooses; the getting-started checklist
-- keeps asking until then. A saved provider key always wins when the app decides what can run
-- (lib/ai/capabilities.ts, effectiveAIMode), so this column records a choice, not a capability.
--
-- A nullable column on an existing table: no new grants, and the release before this one never
-- reads it, so it is safe to push ahead of the deploy.

alter table public.fund_settings
  add column if not exists ai_mode text
    check (ai_mode is null or ai_mode in ('server_key', 'assistant'));
