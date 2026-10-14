-- Presence flags for diligence memo drafts, for the analytics funnel.
--
-- /api/diligence/analytics only needs to know WHETHER each draft has ingestion, research, Q&A and
-- a memo — but reading those off diligence_memo_drafts means shipping every draft's full
-- ingestion/research/memo JSON to the route on every page load. This view computes the flags in
-- Postgres so only booleans and a count cross the wire.
--
-- security_invoker so the view never runs with its owner's rights: a caller sees through it only
-- what they could read from diligence_memo_drafts directly.

create view public.diligence_memo_draft_flags
with (security_invoker = true) as
select
  id,
  deal_id,
  fund_id,
  (ingestion_output is not null)                                       as has_ingestion,
  (research_output is not null)                                        as has_research,
  (case when jsonb_typeof(qa_answers) = 'array'
        then jsonb_array_length(qa_answers) else 0 end)                as qa_count,
  (memo_draft_output is not null)                                      as has_memo_draft,
  is_draft,
  finalized_at,
  created_at
from public.diligence_memo_drafts;

-- Grants. The only reader is the admin-only analytics route, which holds the service-role key, so
-- service_role alone gets SELECT (see CLAUDE.md: a table whose only reader is a gated route is not
-- an ordinary table). The revoke undoes the schema's default privileges, which would otherwise
-- hand the new view to anon/authenticated on projects created before the explicit-grants rollout.
revoke all on public.diligence_memo_draft_flags from anon, authenticated;
grant select on public.diligence_memo_draft_flags to service_role;
