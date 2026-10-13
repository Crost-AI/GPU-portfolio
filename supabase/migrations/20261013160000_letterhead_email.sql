-- supabase/migrations/20261013160000_letterhead_email.sql
--
-- An email line on the letterhead, at both levels. Until now a fund's contact email could only be
-- typed into its address block, and a vehicle that set its own address (20261012120000) lost the
-- fund's email with it. Now the email is its own part: the fund sets a default, a vehicle may
-- override it, and each falls back on its own like the logo, name and address
-- (lib/vehicle-letterhead.ts).
--
-- Additive, and the readers tolerate its absence (they print no email line). No new table, so no
-- grants: funds and fund_vehicles keep the ones they already have.

alter table public.funds add column if not exists contact_email text;
alter table public.fund_vehicles add column if not exists letterhead_email text;
