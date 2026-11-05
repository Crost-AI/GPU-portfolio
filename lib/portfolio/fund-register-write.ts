// Writing a fund holding's register from a connected assistant: its terms (the commitment) and the
// capital notices it received. NAV statements go through lib/portfolio/fof-nav.ts saveNavStatement,
// the one writer of fund_nav_statements.
//
// A notice is either booked (a draft confirmed through confirmFundCapitalEvent, which produces its
// investment transaction and journal entry, as the holding page's Confirm does) or LINKED to a
// transaction already on the books. Linking is for a register filled in after the fact: the calls
// and distributions came in through the bank or a journal import, so booking them again would
// double them. The linked transaction is then owned by the notice, as a booked one is.

import type { SupabaseClient } from '@supabase/supabase-js'
import { logActivity } from '@/lib/activity'
import { vehicleNameById } from '@/lib/accounting/vehicle-id'
import { dbFail, done, fail, type Outcome } from '@/lib/service-outcome'
import { confirmFundCapitalEvent, type ConfirmResult } from './fof-register'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const CENT = 0.005

export const TERM_FIELDS = {
  commitment: 'commitment',
  commitmentDate: 'commitment_date',
  managerName: 'manager_name',
  vintageYear: 'vintage_year',
  fundSize: 'fund_size',
  strategy: 'strategy',
  geography: 'geography',
  finalCloseDate: 'final_close_date',
  termEndDate: 'term_end_date',
  notes: 'notes',
} as const

export type TermFields = Partial<Record<keyof typeof TERM_FIELDS, string | number | null>>

async function fundHolding(admin: SupabaseClient, fundId: string, companyId: string): Promise<Outcome<{ id: string; name: string }>> {
  const { data, error } = await (admin as any)
    .from('companies').select('id, name, holding_type').eq('id', companyId).eq('fund_id', fundId).maybeSingle()
  if (error) return dbFail(error, 'fund-register-write')
  if (!data) return fail(404, 'Holding not found')
  if (data.holding_type !== 'fund') {
    return fail(400, `${data.name} is not a fund holding, so it has no register. Make it one with set_holding_type first.`)
  }
  return done({ id: data.id, name: data.name })
}

/** Set a fund holding's terms on one entity, creating the row when there is none. */
export async function setFundTerms(
  admin: SupabaseClient,
  who: { fundId: string; userId: string | null },
  companyId: string,
  vehicleId: string,
  fields: TermFields,
): Promise<Outcome<{ holding: string; vehicleId: string; terms: Record<string, unknown> }>> {
  const holding = await fundHolding(admin, who.fundId, companyId)
  if (!holding.ok) return holding

  const patch: Record<string, unknown> = {}
  for (const [key, column] of Object.entries(TERM_FIELDS)) {
    if (key in fields) patch[column] = (fields as any)[key]
  }
  if (Object.keys(patch).length === 0) return fail(400, 'Pass at least one term to set.')
  if ('commitment' in patch && !(Number.isFinite(Number(patch.commitment)) && Number(patch.commitment) >= 0)) {
    return fail(400, 'commitment must be a non-negative number.')
  }
  for (const k of ['commitment_date', 'final_close_date', 'term_end_date']) {
    if (patch[k] != null && !ISO_DATE.test(String(patch[k]))) return fail(400, `${k} must be a date (YYYY-MM-DD).`)
  }

  const { data, error } = await (admin as any).from('fund_holding_terms').upsert({
    fund_id: who.fundId,
    company_id: companyId,
    vehicle_id: vehicleId,
    ...patch,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'company_id,vehicle_id' }).select('*').single()
  if (error) return dbFail(error, 'fund-register-terms')

  if (who.userId) logActivity(admin, who.fundId, who.userId, 'fund_holding.terms', { companyId, vehicleId })
  return done({ holding: holding.value.name, vehicleId, terms: data })
}

export interface NoticeInput {
  companyId: string
  vehicleId: string
  kind: 'call' | 'distribution'
  eventDate: string
  amount: number
  dueDate?: string | null
  noticeNumber?: string | null
  description?: string | null
  purposeInvestments?: number
  purposeFees?: number
  purposeExpenses?: number
  charReturnOfCapital?: number
  charRealizedGain?: number
  charIncome?: number
  recallableAmount?: number
  /** A transaction already on the books that IS this notice: linked, not booked again. */
  transactionId?: string | null
}

export interface NoticeRecorded {
  eventId: string
  status: 'confirmed' | 'draft'
  /** linked: tied to a transaction already on the books. booked: confirmed, producing its own. */
  mode: 'linked' | 'booked'
  transactionId?: string
  confirm?: ConfirmResult
}

/**
 * Record a capital notice a fund holding received. With `transactionId` it is linked to that
 * transaction (which must be this holding's, on this entity, of the matching type and amount, and
 * not already the register's); without, it is booked as the holding page's Confirm books one.
 */
export async function recordFundNotice(
  admin: SupabaseClient,
  who: { fundId: string; userId: string },
  input: NoticeInput,
): Promise<Outcome<NoticeRecorded>> {
  const holding = await fundHolding(admin, who.fundId, input.companyId)
  if (!holding.ok) return holding

  if (input.kind !== 'call' && input.kind !== 'distribution') return fail(400, 'kind must be call or distribution.')
  if (!ISO_DATE.test(String(input.eventDate ?? ''))) return fail(400, 'event_date must be a date (YYYY-MM-DD).')
  if (input.dueDate && !ISO_DATE.test(input.dueDate)) return fail(400, 'due_date must be a date (YYYY-MM-DD).')
  const amount = Number(input.amount)
  if (!Number.isFinite(amount) || amount < 0) return fail(400, 'amount must be a non-negative number.')

  const call = input.kind === 'call'
  let purposeInvestments = Number(input.purposeInvestments ?? (call ? amount - Number(input.purposeFees ?? 0) - Number(input.purposeExpenses ?? 0) : 0))
  let charReturnOfCapital = Number(input.charReturnOfCapital ?? NaN)
  let charRealizedGain = Number(input.charRealizedGain ?? 0)
  const charIncome = Number(input.charIncome ?? 0)

  let linked: any = null
  if (input.transactionId) {
    const { data: txn, error } = await (admin as any)
      .from('investment_transactions').select('*').eq('id', input.transactionId).eq('fund_id', who.fundId).maybeSingle()
    if (error) return dbFail(error, 'fund-register-notice-link')
    if (!txn || txn.company_id !== input.companyId) return fail(404, `No transaction ${input.transactionId} on ${holding.value.name}.`)
    const vehicle = await vehicleNameById(admin, who.fundId, input.vehicleId)
    if (txn.portfolio_group !== vehicle) return fail(400, `That transaction is on ${txn.portfolio_group ?? 'no entity'}, not ${vehicle}.`)
    const wantType = call ? 'investment' : 'proceeds'
    if (txn.transaction_type !== wantType) return fail(400, `A ${input.kind} links to a${call ? 'n investment' : ' proceeds'} transaction; that one is ${txn.transaction_type}.`)
    const booked = Number(call ? txn.investment_cost : txn.proceeds_received) || 0
    if (Math.abs(booked - amount) > CENT) return fail(400, `The notice is for ${amount}, but that transaction booked ${booked}.`)

    const [events, navs] = await Promise.all([
      (admin as any).from('fund_capital_events').select('id').eq('fund_id', who.fundId).eq('investment_transaction_id', txn.id).limit(1),
      (admin as any).from('fund_nav_statements').select('id').eq('fund_id', who.fundId).eq('investment_transaction_id', txn.id).limit(1),
    ])
    if (events.error || navs.error) return dbFail(events.error ?? navs.error, 'fund-register-notice-link')
    if ((events.data ?? []).length || (navs.data ?? []).length) return fail(409, 'That transaction is already linked to the fund register.')

    // A distribution's character defaults to what the transaction booked: its cost basis exited is
    // the return of capital, the rest realized gain.
    if (!call && !Number.isFinite(charReturnOfCapital)) {
      charReturnOfCapital = Number(txn.cost_basis_exited ?? 0)
      if (input.charRealizedGain === undefined) charRealizedGain = Math.max(0, amount - charReturnOfCapital - charIncome)
    }
    linked = txn
  }
  if (!Number.isFinite(charReturnOfCapital)) charReturnOfCapital = call ? 0 : amount - charRealizedGain - charIncome
  if (!call) purposeInvestments = 0

  const split = call
    ? purposeInvestments + Number(input.purposeFees ?? 0) + Number(input.purposeExpenses ?? 0)
    : charReturnOfCapital + charRealizedGain + charIncome
  if (Math.abs(split - amount) > CENT) {
    return fail(400, call
      ? `The purposes (investments, fees, expenses) add up to ${split}, not the notice's ${amount}.`
      : `The character (return of capital, realized gain, income) adds up to ${split}, not the notice's ${amount}.`)
  }

  const { data: row, error: insertError } = await (admin as any).from('fund_capital_events').insert({
    fund_id: who.fundId,
    vehicle_id: input.vehicleId,
    company_id: input.companyId,
    kind: input.kind,
    event_date: input.eventDate,
    due_date: input.dueDate ?? null,
    notice_number: input.noticeNumber ?? null,
    description: input.description ?? null,
    amount,
    purpose_investments: purposeInvestments,
    purpose_fees: call ? Number(input.purposeFees ?? 0) : 0,
    purpose_expenses: call ? Number(input.purposeExpenses ?? 0) : 0,
    char_return_of_capital: call ? 0 : charReturnOfCapital,
    char_realized_gain: call ? 0 : charRealizedGain,
    char_income: call ? 0 : charIncome,
    recallable_amount: Number(input.recallableAmount ?? 0),
    investment_transaction_id: linked?.id ?? null,
    status: linked ? 'confirmed' : 'draft',
    source: 'manual',
    created_by: who.userId,
  }).select('id').single()
  if (insertError || !row) return dbFail(insertError, 'fund-register-notice')

  logActivity(admin, who.fundId, who.userId, 'fund_holding.notice', { companyId: input.companyId, eventId: row.id })
  if (linked) return done({ eventId: row.id, status: 'confirmed', mode: 'linked', transactionId: linked.id })

  const confirm = await confirmFundCapitalEvent(admin, who.fundId, who.userId, row.id)
  if (!confirm.ok) {
    return fail(400, `The notice was saved as a draft but could not be booked: ${confirm.error}`, { eventId: row.id })
  }
  return done({ eventId: row.id, status: 'confirmed', mode: 'booked', transactionId: confirm.transactionId, confirm })
}
