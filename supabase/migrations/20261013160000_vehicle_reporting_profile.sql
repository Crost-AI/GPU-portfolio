-- What a quarter-end needs to know about an entity, as facts on the entity rather than inputs a
-- person retypes into every request: its strategy, who administers its books, and how many days
-- after a quarter-end (and after the year-end) its LP reporting is due under its LPA.
--
-- All nullable: unknown is a state the app shows as "not set", never a default it invents.
-- Columns on an existing table (fund_vehicles), so no new grants are needed.

alter table public.fund_vehicles
  add column if not exists strategy text,
  add column if not exists administrator text,
  add column if not exists lp_report_days_quarterly integer,
  add column if not exists lp_report_days_annual integer;

alter table public.fund_vehicles
  add constraint fund_vehicles_strategy check (strategy is null or strategy in ('venture', 'growth', 'buyout', 'credit', 'fund_of_funds', 'real_assets', 'other')),
  add constraint fund_vehicles_administrator_len check (administrator is null or char_length(administrator) between 1 and 200),
  add constraint fund_vehicles_lp_report_days_quarterly check (lp_report_days_quarterly is null or lp_report_days_quarterly between 1 and 365),
  add constraint fund_vehicles_lp_report_days_annual check (lp_report_days_annual is null or lp_report_days_annual between 1 and 365);

comment on column public.fund_vehicles.administrator is
  'Who keeps the books: an outside administrator''s name, or ''In-house''. Null = not set.';
comment on column public.fund_vehicles.lp_report_days_quarterly is
  'LP reporting is due this many days after a quarter-end (Q1-Q3), per the LPA. Null = not set.';
comment on column public.fund_vehicles.lp_report_days_annual is
  'LP reporting is due this many days after the fiscal year-end (Q4, usually audited), per the LPA. Null = not set.';
