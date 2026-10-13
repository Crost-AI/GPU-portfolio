-- Document templates: a fund's own LP-letter (and other document) layouts, kept as data.
--
-- A template is HTML in the logic-less language of lib/document-templates/engine.ts, filled from a
-- JSON object at generation time. It belongs to the fund, not to the code: a fund's letter layout,
-- its wording and the shape of its quarter data are its own, and the open-source repository should
-- carry the engine, not any one fund's letter.
--
-- document_renders keeps each generated document — the data it was filled from and the HTML that
-- came out — so a download link prints exactly what was generated, and next quarter's letter can
-- start from this quarter's data.
--
-- Both are read and written only by the agent tools and the report-link route, through the service
-- role, after their own access checks (lp_relations / lp_letters). So, per CLAUDE.md, they are
-- granted to service_role alone with RLS on and no authenticated policies.

create table public.document_templates (
  id uuid primary key default gen_random_uuid(),
  fund_id uuid not null references public.funds(id) on delete cascade,
  name text not null,
  vehicle text,
  instructions text,
  body_html text not null,
  sample_data jsonb,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint document_templates_name_len check (char_length(name) between 1 and 120),
  constraint document_templates_body_len check (char_length(body_html) <= 400000)
);

create unique index document_templates_fund_name_key on public.document_templates (fund_id, lower(name));

create table public.document_renders (
  id uuid primary key default gen_random_uuid(),
  fund_id uuid not null references public.funds(id) on delete cascade,
  template_id uuid not null references public.document_templates(id) on delete cascade,
  title text not null,
  data jsonb not null,
  html text not null,
  warnings text[] not null default '{}',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index document_renders_template_idx on public.document_renders (template_id, created_at desc);
create index document_renders_fund_idx on public.document_renders (fund_id);

-- 1. Grants: service role only (see header). Revoked explicitly too: projects created before the
--    2026 Data API change grant new tables to anon/authenticated automatically.
revoke all on public.document_templates from anon, authenticated;
revoke all on public.document_renders from anon, authenticated;
grant select, insert, update, delete on public.document_templates to service_role;
grant select, insert, update, delete on public.document_renders to service_role;

-- 2. RLS on, and no policies: if a grant ever crept back, RLS would still deny.
alter table public.document_templates enable row level security;
alter table public.document_renders enable row level security;
