-- Change a draft partnership invoice's expenses and adjustments in one transaction.
--
-- editPartnershipInvoice (lib/accounting/partnership-invoices.ts) used to check the invoice, then make
-- separate writes to its lines, its adjustments and its header. An issue finishing between the check
-- and the writes left an issued invoice and charge at one figure and lines at another, with the
-- removed expense free to bill again; the header's conditional update quietly changed nothing.
--
-- Here the invoice row is locked for the duration and the checks and every write happen under that
-- lock, so an edit and an issue cannot interleave: booking a charge needs a key-share lock on this row
-- for its foreign key, which waits for this function. An edit that goes first changes the amount, and
-- markIssued (conditional on the amount the charge booked) stops the issue. A charge that goes first
-- is seen here. The totals are summed here, under the lock, not trusted from the caller.
--
-- Returns { refused: 'gone' | 'status' | 'charge' }, writing nothing, when the invoice cannot be
-- edited; otherwise { amount, adjustment_total }. Raises, rolling everything back, on a line another
-- invoice holds (23505, the posting's unique index) or totals the invoice cannot have.
--
-- SECURITY INVOKER (the default): the only caller holds service_role. Not callable from the Data API
-- by anon or authenticated, as apply_bank_categorization (20261014191000).

create or replace function public.apply_partnership_invoice_edit(
  p_fund_id uuid,
  p_invoice_id uuid,
  p_add_lines jsonb,
  p_remove_posting_ids uuid[],
  p_add_adjustments jsonb,
  p_remove_adjustment_ids uuid[],
  p_user_id uuid
) returns jsonb language plpgsql set search_path = public as $$
declare
  v_status text;
  v_amount numeric(20, 2);
  v_adjustments numeric(20, 2);
begin
  select status into v_status from public.partnership_invoices
    where id = p_invoice_id and fund_id = p_fund_id
    for update;
  if v_status is null then return jsonb_build_object('refused', 'gone'); end if;
  if v_status <> 'draft' then return jsonb_build_object('refused', 'status', 'status', v_status); end if;
  if exists (
    select 1 from public.intercompany_transactions
    where fund_id = p_fund_id and partnership_invoice_id = p_invoice_id and status <> 'void'
  ) then
    return jsonb_build_object('refused', 'charge');
  end if;

  -- Add first: a line another invoice holds fails here, before anything is taken off.
  insert into public.partnership_invoice_lines (fund_id, invoice_id, journal_entry_id, journal_posting_id, amount, allocation_basis)
    select p_fund_id, p_invoice_id, l.journal_entry_id, l.journal_posting_id, l.amount, l.allocation_basis
    from jsonb_to_recordset(coalesce(p_add_lines, '[]'::jsonb))
      as l(journal_entry_id uuid, journal_posting_id uuid, amount numeric, allocation_basis text);
  delete from public.partnership_invoice_lines
    where fund_id = p_fund_id and invoice_id = p_invoice_id and journal_posting_id = any(coalesce(p_remove_posting_ids, '{}'::uuid[]));

  insert into public.partnership_invoice_adjustments (fund_id, invoice_id, description, amount, created_by)
    select p_fund_id, p_invoice_id, a.description, a.amount, p_user_id
    from jsonb_to_recordset(coalesce(p_add_adjustments, '[]'::jsonb)) as a(description text, amount numeric);
  delete from public.partnership_invoice_adjustments
    where fund_id = p_fund_id and invoice_id = p_invoice_id and id = any(coalesce(p_remove_adjustment_ids, '{}'::uuid[]));

  select coalesce(sum(amount), 0) into v_amount from public.partnership_invoice_lines
    where fund_id = p_fund_id and invoice_id = p_invoice_id and active;
  select coalesce(sum(amount), 0) into v_adjustments from public.partnership_invoice_adjustments
    where fund_id = p_fund_id and invoice_id = p_invoice_id;
  if v_amount <= 0 then raise exception 'partnership_invoice_edit: no expenses left'; end if;
  if v_amount + v_adjustments < 0 then raise exception 'partnership_invoice_edit: over-credited'; end if;

  update public.partnership_invoices
    set amount = v_amount, adjustment_total = v_adjustments, updated_at = now()
    where id = p_invoice_id and fund_id = p_fund_id;

  return jsonb_build_object('amount', v_amount, 'adjustment_total', v_adjustments);
end;
$$;

revoke all on function public.apply_partnership_invoice_edit(uuid, uuid, jsonb, uuid[], jsonb, uuid[], uuid) from public, anon, authenticated;
grant execute on function public.apply_partnership_invoice_edit(uuid, uuid, jsonb, uuid[], jsonb, uuid[], uuid) to service_role;
