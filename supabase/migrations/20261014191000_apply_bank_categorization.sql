-- Apply one AI categorization to a bank draft in one transaction, and only while it is a draft.
--
-- `runCategorization` (lib/accounting/categorize-run.ts) checked the entry was still a draft in one
-- read, then made three separate writes: re-point the posting, set the entry's source_type, record
-- the suggestion on the bank row. A user posting the entry between the check and the writes had
-- their posted entry re-pointed behind their back; a failure between the writes left the posting,
-- the entry and the bank row disagreeing; and none of the errors were read, so the run counted
-- every row as updated whatever happened.
--
-- Here the entry row is locked for the duration, the draft check and all three writes happen under
-- that lock, and any failure rolls the whole thing back. Returns false, writing nothing, when the
-- entry is no longer a draft; raises when the posting or bank row is not where the caller said.
--
-- SECURITY INVOKER (the default): the only caller holds service_role. Not callable from the Data
-- API by anon or authenticated, the same lockdown as publish_opening_balances (20261006200000).

create or replace function public.apply_bank_categorization(
  p_fund_id uuid,
  p_entry_id uuid,
  p_posting_id uuid,
  p_account_id uuid,
  p_source_type text,
  p_bank_txn_id uuid,
  p_account_code text,
  p_raw jsonb
) returns boolean language plpgsql set search_path = public as $$
declare
  entry_status text;
begin
  select status into entry_status from public.journal_entries
    where id = p_entry_id and fund_id = p_fund_id and book = 'actual'
    for update;
  if entry_status is distinct from 'draft' then return false; end if;

  update public.journal_postings set account_id = p_account_id
    where id = p_posting_id and journal_entry_id = p_entry_id and fund_id = p_fund_id and book = 'actual';
  if not found then
    raise exception 'Posting % is no longer on entry %', p_posting_id, p_entry_id;
  end if;

  update public.journal_entries set source_type = p_source_type
    where id = p_entry_id and fund_id = p_fund_id;

  update public.bank_transactions set suggested_account_code = p_account_code, raw = p_raw
    where id = p_bank_txn_id and fund_id = p_fund_id and journal_entry_id = p_entry_id;
  if not found then
    raise exception 'Bank transaction % is not linked to entry %', p_bank_txn_id, p_entry_id;
  end if;

  return true;
end;
$$;
revoke all on function public.apply_bank_categorization(uuid, uuid, uuid, uuid, text, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.apply_bank_categorization(uuid, uuid, uuid, uuid, text, uuid, text, jsonb) to service_role;
