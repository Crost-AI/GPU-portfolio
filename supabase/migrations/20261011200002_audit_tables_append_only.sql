-- Make the two audit tables append-only for real.
--
-- accounting_audit_events (20261010200000) blocks UPDATE and DELETE with a row trigger, but a row
-- trigger never sees TRUNCATE, and service_role still held whatever the platform's default
-- privileges gave it. tax_year_close_events (20261010100001) is marked appendOnly in
-- lib/access/table-domains.ts but nothing enforced it at all.
--
-- App code (lib/, app/, scripts/) only ever INSERTs and SELECTs these tables (lib/audit/events.ts,
-- lib/audit/read.ts, lib/tax/year-close.ts). The one legitimate delete is the FK cascade:
--   accounting_audit_events.fund_id      -> funds         on delete cascade
--   tax_year_close_events.fund_id        -> funds         on delete cascade
--   tax_year_close_events.vehicle_id     -> fund_vehicles on delete cascade (vehicle delete/merge)
-- A cascade runs from the referential-integrity trigger, so it reaches the row trigger at
-- pg_trigger_depth() > 1 and passes; and it runs with the table owner's rights, so revoking DELETE
-- from service_role does not stop it.

-- 1. Privileges: nobody but the owner may update, delete or truncate.
revoke update, delete, truncate on public.accounting_audit_events from service_role, anon, authenticated;
revoke update, delete, truncate on public.tax_year_close_events from service_role, anon, authenticated;

-- 2. Row trigger on tax_year_close_events, same shape as accounting_audit_events_immutable.
create or replace function public.tax_year_close_events_immutable()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;
  raise exception 'tax_year_close_events is append-only';
end $$;
revoke execute on function public.tax_year_close_events_immutable() from public, anon, authenticated;

drop trigger if exists tax_year_close_events_no_change on public.tax_year_close_events;
create trigger tax_year_close_events_no_change
  before update or delete on public.tax_year_close_events
  for each row execute function public.tax_year_close_events_immutable();

-- 3. TRUNCATE skips row triggers, so refuse it at statement level on both — owner included.
--    (A `truncate funds cascade` is refused too; delete funds row by row instead.)
create or replace function public.refuse_truncate_append_only()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception '% is append-only; truncate is not allowed', tg_table_name;
end $$;
revoke execute on function public.refuse_truncate_append_only() from public, anon, authenticated;

drop trigger if exists accounting_audit_events_no_truncate on public.accounting_audit_events;
create trigger accounting_audit_events_no_truncate
  before truncate on public.accounting_audit_events
  for each statement execute function public.refuse_truncate_append_only();

drop trigger if exists tax_year_close_events_no_truncate on public.tax_year_close_events;
create trigger tax_year_close_events_no_truncate
  before truncate on public.tax_year_close_events
  for each statement execute function public.refuse_truncate_append_only();
