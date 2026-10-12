// Editing and deleting a recorded investment transaction — the one path behind the company page's
// edit/delete (app/api/companies/[id]/investments/[txnId]) and the agent tools
// `update_investment` / `delete_investment`, so a correction made by a connected assistant
// retracts and re-derives the ledger exactly as one made on the web.

import type { SupabaseClient } from '@supabase/supabase-js'
import { logActivity } from '@/lib/activity'
import { draftEntryForTransaction, retractEntriesForTransaction } from '@/lib/accounting/from-portfolio'
import { validateConversionLink } from '@/lib/accounting/conversion-link'
import { normalizeSecurityType, SECURITY_TYPES } from '@/lib/accounting/soi'
import { TRANSACTION_TYPES, transactionRowError } from '@/lib/portfolio/transaction-checks'
import { ensureVehiclesByName } from '@/lib/accounting/vehicle-id'
import { groupWriteDenial } from '@/lib/access/scope'

/** Who is making the change: their fund, their id (null for a credential with no user) and their entities. */
export interface TxnEditor {
  fundId: string
  userId: string | null
  /** The caller's entity names; null = every entity. */
  vehicleNames: string[] | null
}

/**
 * A refusal carries the HTTP status the route answers with. `dbError` is set when the database
 * itself failed, so the route can log it and answer with its generic 500.
 */
export type TxnEditResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string; dbError?: { message: string } }

/** Fields an edit may change. Anything else in the body is ignored. */
export const EDITABLE_TXN_FIELDS = [
  'transaction_type',
  'round_name', 'transaction_date', 'notes',
  'investment_cost', 'interest_converted', 'shares_acquired', 'share_price',
  // Corrigible on edit: a split announced at the wrong ratio is a share count that is wrong
  // everywhere until it is fixed. The DB constraints still enforce positive-and-dated.
  'split_ratio',
  // Income the position produced, and acquisition costs capitalised into its basis.
  'income_kind', 'income_settlement', 'income_amount', 'fee_amount',
  'cost_basis_exited', 'proceeds_received', 'proceeds_escrow',
  'proceeds_written_off', 'proceeds_per_share',
  'unrealized_value_change', 'current_share_price',
  'postmoney_valuation', 'ownership_pct', 'latest_postmoney_valuation', 'exit_valuation',
  'original_currency',
  'original_investment_cost', 'original_share_price', 'original_postmoney_valuation',
  'original_proceeds_received', 'original_proceeds_per_share', 'original_exit_valuation',
  'original_unrealized_value_change', 'original_current_share_price',
  'original_latest_postmoney_valuation',
  'valuation_change_source', 'fx_rate', 'prior_fx_rate', 'fx_value_change',
  'original_position_value',
  'portfolio_group',
  // The Schedule of Investments reads `security_type` for its by-asset-type breakout, but
  // it was in no create route, no allowlist and no import — so nothing in the app could
  // ever set it, and the breakout fell back to a two-bucket guess forever.
  'security_type',
  // Convertible-note terms. `interest_rate` is the ONLY rate the ledger accrues on.
  // `dividend_rate` is preferred-equity dividends: they accrue to the liquidation preference,
  // not to income, and never touch the books.
  'interest_rate', 'maturity_date', 'dividend_rate',
  // The conversion link (which SAFE/note this priced round converted). Editing a conversion
  // re-drafts its ledger entry from the new values, same as any other investment edit.
  'converts_from_txn_id',
] as const

/**
 * A transaction the fund register booked — a manager NAV's mark, or a confirmed capital notice — is
 * owned by that register row: it is derived from the statement or notice, and re-derived when they
 * change. Edited or deleted here it would leave the register describing a value the ledger no longer
 * carries, and every later NAV's mark (a delta against the ledger) stale. So it is changed there.
 * Fails closed: a lookup that errors refuses too.
 */
async function fundRegisterOwner(admin: any, fundId: string, txnId: string): Promise<string | null> {
  const [navs, events] = await Promise.all([
    admin.from('fund_nav_statements').select('id').eq('fund_id', fundId).eq('investment_transaction_id', txnId).limit(1),
    admin.from('fund_capital_events').select('id').eq('fund_id', fundId).eq('investment_transaction_id', txnId).limit(1),
  ])
  if (navs.error || events.error) {
    return 'Could not check whether the fund register owns this transaction, so it was not changed. Try again.'
  }
  if ((navs.data ?? []).length > 0) {
    return 'This is the mark of a manager NAV statement. Change or delete that statement in the fund register on the holding '
      + '(Manager NAV statements), which re-books the mark.'
  }
  if ((events.data ?? []).length > 0) {
    return 'This was booked from a capital notice in the fund register. Change it from the notice in the fund register on the holding.'
  }
  return null
}

/** The transaction, if it is this company's and this fund's. */
async function loadTransaction(admin: SupabaseClient, fundId: string, companyId: string, txnId: string): Promise<any | null> {
  const { data: existing } = await (admin as any)
    .from('investment_transactions')
    .select('*')
    .eq('id', txnId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (!existing || existing.fund_id !== fundId) return null
  return existing
}

async function dependentConversions(admin: SupabaseClient, txnId: string): Promise<number> {
  const { data } = await (admin as any)
    .from('investment_transactions')
    .select('id')
    .eq('converts_from_txn_id', txnId)
  return ((data as any[]) ?? []).length
}

/**
 * Change a recorded transaction and re-mirror the ledger: retract its journal entry, update the row,
 * then derive the entry afresh from the new values.
 */
export async function updateInvestmentTransaction(
  admin: SupabaseClient,
  who: TxnEditor,
  companyId: string,
  txnId: string,
  body: Record<string, any>,
): Promise<TxnEditResult<{ transaction: any; ledger: any }>> {
  const existing = await loadTransaction(admin, who.fundId, companyId, txnId)
  if (!existing) return { ok: false, status: 404, error: 'Transaction not found' }

  // Only the caller's entities' rows, and only into one of their entities.
  const deniedHere = groupWriteDenial(who.vehicleNames, existing.portfolio_group)
    ?? ('portfolio_group' in body ? groupWriteDenial(who.vehicleNames, body.portfolio_group) : null)
  if (deniedHere) return { ok: false, status: 403, error: deniedHere }

  const owned = await fundRegisterOwner(admin, who.fundId, txnId)
  if (owned) return { ok: false, status: 409, error: owned }

  // A mis-typed row can be reclassified on edit (e.g. a "Round" that should be a "Valuation
  // Update"). Only the DB types are valid; the UI's "conversion" is already translated to
  // 'investment' + converts_from before it reaches here.
  if ('transaction_type' in body && !TRANSACTION_TYPES.includes(body.transaction_type)) {
    return { ok: false, status: 400, error: 'Invalid transaction_type' }
  }
  const nextType: string = ('transaction_type' in body ? body.transaction_type : existing.transaction_type)

  // #5 — A conversion source must stay an `investment`. Reclassifying it to anything else would
  // silently drop the dependent conversion's carried basis (computeSummary skips non-investment
  // sources). Block it rather than let the numbers shrink with no warning.
  const dependentCount = await dependentConversions(admin, txnId)
  if (dependentCount > 0 && nextType !== 'investment') {
    return {
      ok: false,
      status: 400,
      error: `Can't change this to a ${nextType}: ${dependentCount} conversion${dependentCount > 1 ? 's' : ''} on this company convert${dependentCount > 1 ? '' : 's'} from it. Re-point or remove those conversions first.`,
    }
  }

  // #2 — Validate the conversion link the same way create does (dangling / cross-company / self /
  // non-investment). Without this, an edit could set a link the create path would have rejected.
  if (body.converts_from_txn_id) {
    const linkError = await validateConversionLink(admin, companyId, body.converts_from_txn_id, nextType, who.vehicleNames, txnId)
    if (linkError) return { ok: false, status: 400, error: linkError }
  }

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
  for (const key of EDITABLE_TXN_FIELDS) {
    if (key in body) updates[key] = body[key]
  }

  // Same CHECK constraint as the create route: reject in words rather than let Postgres reject it
  // in a 500. Null stays null — that's how you clear the instrument back to the derived fallback.
  if (body.security_type != null && body.security_type !== '') {
    const security_type = normalizeSecurityType(body.security_type)
    if (!security_type) {
      return {
        ok: false,
        status: 400,
        error: `Invalid security_type "${body.security_type}". Must be one of: ${SECURITY_TYPES.join(', ')}`,
      }
    }
    updates.security_type = security_type
  } else if ('security_type' in body) {
    updates.security_type = null
  }

  // The edited row as the database will see it, checked against its constraints BEFORE anything is
  // retracted: a deterministic refusal must leave the transaction and its journal entry as they were.
  const rowProblem = transactionRowError({ ...existing, ...updates })
  if (rowProblem) return { ok: false, status: 400, error: rowProblem }

  if ('portfolio_group' in updates) {
    // Every stored portfolio_group name must be backed by a real fund_vehicles row — never a
    // disconnected string. Resolve/create before the write, not after.
    await ensureVehiclesByName(admin, existing.fund_id, [updates.portfolio_group as string | null | undefined])
  }

  // Retract the ledger side FIRST, as DELETE does. When it refuses — a closed period, an adopted
  // entry that can't be split — nothing is written, so the tracker and the ledger stay in step.
  // Editing the row first used to leave the tracker on the new figures and the ledger on the old.
  const retracted = await retractEntriesForTransaction(admin, existing.fund_id, txnId, { userId: who.userId, original: existing })
  if (retracted.reason) {
    return { ok: false, status: 409, error: `Can't change this transaction. ${retracted.reason}` }
  }

  const { data: company } = await (admin as any)
    .from('companies')
    .select('name')
    .eq('id', companyId)
    .maybeSingle()
  const companyName = company?.name ?? 'Investment'

  const { data: txn, error } = await (admin as any)
    .from('investment_transactions')
    .update(updates)
    .eq('id', txnId)
    .select('*')
    .single()

  if (error) {
    // The old entry was retracted; put the unchanged transaction back on the ledger. If that fails
    // too, the transaction is in the tracker with no journal entry — say so plainly, not a bare 500.
    if (retracted.retracted > 0) {
      const restored = await draftEntryForTransaction(admin, existing.fund_id, who.userId, existing, companyName)
      if (!restored.drafted) {
        console.error('[investment-transaction-update] update failed:', error.message, '; re-derive failed:', restored.reason)
        return {
          ok: false,
          status: 500,
          error: `The transaction's journal entry was removed and could not be re-derived: ${(restored.reason ?? 'unknown reason').replace(/\.\s*$/, '')}. `
            + 'Re-save the transaction to post it again.',
        }
      }
    }
    return { ok: false, status: 500, error: error.message, dbError: error }
  }

  if (who.userId) {
    logActivity(admin, existing.fund_id, who.userId, 'investment.update', { companyId, transactionId: txnId })
  }

  // Re-mirror the ledger: derive the edited transaction afresh.
  const derived = await draftEntryForTransaction(admin, existing.fund_id, who.userId, txn, companyName)
  const ledger = retracted.warning ? { ...derived, warning: retracted.warning } : derived

  return { ok: true, value: { transaction: txn, ledger } }
}

/** Delete a recorded transaction, retracting its journal entry first. */
export async function deleteInvestmentTransaction(
  admin: SupabaseClient,
  who: TxnEditor,
  companyId: string,
  txnId: string,
): Promise<TxnEditResult<{ ledger: any }>> {
  const existing = await loadTransaction(admin, who.fundId, companyId, txnId)
  if (!existing) return { ok: false, status: 404, error: 'Transaction not found' }

  const deniedDelete = groupWriteDenial(who.vehicleNames, existing.portfolio_group)
  if (deniedDelete) return { ok: false, status: 403, error: deniedDelete }

  const owned = await fundRegisterOwner(admin, who.fundId, txnId)
  if (owned) return { ok: false, status: 409, error: owned }

  // #3 — Refuse to delete an instrument that a conversion depends on. The FK is ON DELETE SET
  // NULL, so deleting it would silently orphan the conversion into a $0-cost investment (its basis
  // gone, its shares now valued at nothing). Make the dependency explicit instead of destroying it.
  const n = await dependentConversions(admin, txnId)
  if (n > 0) {
    return {
      ok: false,
      status: 400,
      error: `Can't delete this: ${n} conversion${n > 1 ? 's' : ''} on this company convert${n > 1 ? '' : 's'} from it. Delete or re-point ${n > 1 ? 'those' : 'that'} first.`,
    }
  }

  // Retract the ledger side FIRST. If its journal entry sits in a closed period we refuse the
  // whole delete — otherwise the tracker would lose a transaction the books still carry, and
  // the two would disagree with nothing to explain why. Deleting the tracker row first and
  // then failing here would leave exactly that mess.
  const ledger = await retractEntriesForTransaction(admin, existing.fund_id, txnId, { userId: who.userId })
  if (ledger.reason) {
    return { ok: false, status: 400, error: `Can't delete this transaction. ${ledger.reason}` }
  }

  const { error } = await (admin as any)
    .from('investment_transactions')
    .delete()
    .eq('id', txnId)

  if (error) return { ok: false, status: 500, error: error.message, dbError: error }

  if (who.userId) {
    logActivity(admin, existing.fund_id, who.userId, 'investment.delete', { companyId, transactionId: txnId })
  }

  return { ok: true, value: { ledger } }
}
