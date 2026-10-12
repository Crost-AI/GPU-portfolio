-- supabase/migrations/20261012120000_vehicle_logo.sql
--
-- A logo per vehicle. Until now the only logo was funds.logo_url, so every LP-facing PDF carried
-- the firm's mark, including those for a vehicle with its own brand (3SE Holdings). When set, a
-- vehicle's logo replaces the fund's on that vehicle's statements, notices and receipts, and on an
-- investor report whose vehicles all share it (lib/vehicle-logo.ts). A data:image/ URI, like the
-- fund logo, capped at 200KB by the API.
--
-- Additive, and the readers tolerate its absence (they fall back to the fund logo). No new table,
-- so no grants: fund_vehicles keeps the ones it already has.

alter table public.fund_vehicles add column if not exists logo_url text;
