-- Which credential staged a pending action: `oauth:<clientId>` for a connected chat, a
-- fund_api_keys id for a script, null for the in-app Analyst and for every row staged before this
-- column existed.
--
-- The approval service refuses an approval from the SAME credential (and the same person) that
-- staged the change, so a chat cannot approve its own proposal by calling approve_action: a person
-- approves it in the app, or from a different credential. Rows with no credential fall back to
-- `created_via` (lib/pending-actions/service.ts), so older rows staged from MCP keep that rule.
--
-- Nullable with no default, and safe in either order with the deploy: until this is pushed the
-- app inserts without the column (lib/agent/dispatch.ts retries on Postgres' undefined-column
-- error) and the fallback above applies.
--
-- Adding a column changes no grant or policy; pending_actions keeps its RLS from
-- 20260902174637_enforce_domain_access_rls.sql.

alter table public.pending_actions
  add column if not exists created_credential text;
