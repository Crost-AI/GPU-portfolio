-- PENDING DEPLOY — do not move into supabase/migrations/ until this release is live:
--
--   The release that reads the company page's AI-key flags with the service-role client
--   (app/(app)/companies/[id]/load.ts) instead of the signed-in member's client.
--
-- Why it must wait: the release before that one selects claude_api_key_encrypted and
-- openai_api_key_encrypted from fund_settings with the member's own client. Once this runs, that
-- select is refused, the page ignores the error, and every company page silently falls back to
-- the default currency, no AI key and no storage provider.
--
-- When moving it: rename to a current timestamp, e.g. supabase/migrations/<now>_fund_settings_member_column_grants.sql.
--
-- What it does: any fund member could read the whole fund_settings row from the browser with the
-- anon key, which includes every encrypted credential, the wrapped data key, the deal-submission
-- token hash and the legacy plaintext Postmark webhook token (a forged inbound webhook needs only
-- that). Members keep SELECT on every other column. Only the service role reads the secrets, and
-- every route that needs one already uses it.
--
-- Column grants do not follow new columns. A later migration that adds a column to fund_settings
-- must end with `select public.grant_fund_settings_member_columns();`, or members' own reads of
-- that column are refused. tests/fund-settings-column-grants.test.ts fails when one doesn't.

create or replace function public.grant_fund_settings_member_columns()
returns void
language plpgsql
set search_path = ''
as $$
declare
  readable text;
begin
  -- A secret is any *_encrypted column, plus the two values that are secrets without the suffix.
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
    into readable
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'fund_settings'
     and right(column_name, 10) <> '_encrypted'
     and column_name not in ('postmark_webhook_token', 'deal_submission_token');

  -- Revoking the table privilege also revokes every column grant, so this is safe to re-run.
  revoke select on public.fund_settings from anon, authenticated;
  execute format('grant select (%s) on public.fund_settings to authenticated', readable);
end;
$$;

revoke execute on function public.grant_fund_settings_member_columns() from public, anon, authenticated;

select public.grant_fund_settings_member_columns();
