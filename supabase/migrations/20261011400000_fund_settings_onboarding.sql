-- First-run wizard progress (app/onboarding, lib/onboarding/wizard.ts).
--
-- Most of where a returning admin resumes is DERIVED from what is configured — a fund exists,
-- inbound email has a provider, there is at least one authorized sender. This column holds only what
-- cannot be derived:
--   products      the answer to "What will you run here?" (so that step isn't asked again)
--   skipped       optional steps the admin chose to set up later ('inbound' | 'senders' | 'drive')
--   completed_at  the admin pressed Finish
--
-- Additive and nullable-by-default: the release that writes it tolerates the column being absent
-- (it reads fund_settings with select('*') and retries its writes without the key), and no earlier
-- release reads it, so this can be pushed before or after that release ships.
--
-- A new column on an existing table inherits the table's grants and RLS; nothing to add here.

alter table public.fund_settings
  add column if not exists onboarding jsonb not null default '{}'::jsonb;

comment on column public.fund_settings.onboarding is
  'First-run wizard state that cannot be derived from other columns: {products, skipped, completed_at}. See lib/onboarding/wizard.ts.';
