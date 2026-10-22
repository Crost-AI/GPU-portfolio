// Writing a fund holding's register from a connected assistant: its terms (the commitment) and the
// capital notices it received. NAV statements go through lib/portfolio/fof-nav.ts saveNavStatement,
// the one writer of fund_nav_statements.
//
// A notice is either booked (a draft confirmed through confirmFundCapitalEvent, which produces its
// investment transaction and journal entry, as the holding page's Confirm does) or LINKED to a
// transaction already on the books. Linking is for a register filled in after the fact: the calls
// and distributions came in through the bank or a journal import, so booking them again would
// double them. The linked transaction is then owned by the notice, as a booked one is.
//
// Because the notice owns its transaction, a correction is made to the notice (updateFundNotice):
// the notice row changes and its transaction is re-derived from it, retracting and re-drafting the
// journal entry as an edit on the company page does, then the holding's later NAV marks re-book.

import type { SupabaseClient } from '@supabase/supabase-js'
import { logActivity } from '@/lib/activity'
import { vehicleNameById } from '@/lib/accounting/vehicle-id'
import { groupWriteDenial } from '@/lib/access/scope'
import { dbFail, done, fail, type Outcome } from '@/lib/service-outcome'
import { confirmFundCapitalEvent, transactionForEvent, type ConfirmResult } from './fof-register'
import { updateInvestmentTransaction } from './transaction-edit'
import { costRecoverySplit, remainingCostAt } from './distribution-cost-recovery'

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
  /** A linked distribution's transaction re-booked to the return of capital worked out for it. */
  rebooked?: boolean
  navRebooked?: unknown[]
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

    linked = txn
  }

  // A distribution whose return of capital and gain are not stated is split by cost recovery
  // against the cost the holding still carries on this entity at that date; income stated by the
  // manager stays income. A linked transaction whose cost basis exited differs is re-booked to match.
  let rebookLinked = false
  if (!call && input.charReturnOfCapital === undefined && input.charRealizedGain === undefined) {
    const vehicle = await vehicleNameById(admin, who.fundId, input.vehicleId)
    if (!vehicle) return fail(400, 'That entity was not found.')
    const remaining = await remainingCostAt(admin, who.fundId, input.companyId, vehicle, input.eventDate, linked?.id ?? null)
    const split = costRecoverySplit(amount, remaining, charIncome)
    charReturnOfCapital = split.returnOfCapital
    charRealizedGain = split.realizedGain
    rebookLinked = !!linked && Math.abs(Number(linked.cost_basis_exited ?? 0) - charReturnOfCapital) > CENT
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
  if (linked) {
    if (rebookLinked) {
      const vehicle = await vehicleNameById(admin, who.fundId, input.vehicleId)
      const edited = await updateInvestmentTransaction(admin, { fundId: who.fundId, userId: who.userId, vehicleNames: vehicle ? [vehicle] : [] },
        input.companyId, linked.id, { cost_basis_exited: charReturnOfCapital }, { asRegister: true })
      if (!edited.ok) {
        return fail(edited.status ?? 409, `The notice was linked, but its transaction could not be re-booked to the return of capital worked out `
          + `(${charReturnOfCapital}): ${edited.error}`, { eventId: row.id })
      }
      const absorbed = await absorbInNextMark(admin, { fundId: who.fundId, userId: who.userId, vehicleNames: vehicle ? [vehicle] : [] },
        input.companyId, vehicle!, String(linked.transaction_date), carried(edited.value.transaction) - carried(linked))
      if (!absorbed.ok) {
        return fail(absorbed.status, `The notice was linked and its transaction re-booked, but the next mark could not be adjusted to keep `
          + `the holding at its value: ${absorbed.error}`, { eventId: row.id })
      }
      const { rebookNavsFrom } = await import('./fof-nav')
      const navRebooked = await rebookNavsFrom(admin, who.fundId, who.userId,
        { companyId: input.companyId, vehicleId: input.vehicleId, since: input.eventDate, inclusive: true })
      return done({ eventId: row.id, status: 'confirmed', mode: 'linked', transactionId: linked.id, rebooked: true, ...(navRebooked.length ? { navRebooked } : {}) })
    }
    return done({ eventId: row.id, status: 'confirmed', mode: 'linked', transactionId: linked.id })
  }

  const confirm = await confirmFundCapitalEvent(admin, who.fundId, who.userId, row.id)
  if (!confirm.ok) {
    return fail(400, `The notice was saved as a draft but could not be booked: ${confirm.error}`, { eventId: row.id })
  }
  return done({ eventId: row.id, status: 'confirmed', mode: 'booked', transactionId: confirm.transactionId, confirm })
}

/** What a transaction adds to the holding's carrying value: cost in, less cost basis exited. */
const carried = (t: any) => Number(t?.investment_cost ?? 0) - Number(t?.cost_basis_exited ?? 0)

/**
 * After a correction moved the holding's carrying value by `valueDelta`, take it back out of the next
 * mark on or after `date`, so the holding stays at the value its marks were struck to (a manager's
 * NAV) and only the split between cost, realized and unrealized changes. A mark a NAV statement
 * owns is left to rebookNavsFrom, which re-derives it against the corrected ledger. With no later
 * mark the value does move, and the note says so.
 */
async function absorbInNextMark(
  admin: SupabaseClient,
  who: { fundId: string; userId: string | null; vehicleNames: string[] | null },
  companyId: string,
  vehicleName: string,
  date: string,
  valueDelta: number,
): Promise<Outcome<{ markId?: string; note?: string }>> {
  if (Math.abs(valueDelta) <= CENT) return done({})
  const { data, error } = await (admin as any).from('investment_transactions').select('*')
    .eq('fund_id', who.fundId).eq('company_id', companyId).eq('portfolio_group', vehicleName)
    .eq('transaction_type', 'unrealized_gain_change').gte('transaction_date', date)
  if (error) return dbFail(error, 'fund-register-absorb-mark')
  const next = [...((data as any[]) ?? [])].sort((a, b) => String(a.transaction_date).localeCompare(String(b.transaction_date)))[0]
  if (!next) {
    return done({ note: `No mark on or after ${date}, so the holding's value moved by ${Math.round(valueDelta * 100) / 100}.` })
  }
  const { data: owner } = await (admin as any).from('fund_nav_statements').select('id')
    .eq('fund_id', who.fundId).eq('investment_transaction_id', next.id).limit(1)
  if (((owner as any[]) ?? []).length) return done({ markId: next.id })
  const edited = await updateInvestmentTransaction(admin, who, companyId, next.id,
    { unrealized_value_change: Math.round((Number(next.unrealized_value_change ?? 0) - valueDelta) * 100) / 100 })
  if (!edited.ok) return edited
  return done({ markId: next.id })
}

/** The fields of a notice a correction may change. Its holding, entity and kind stay. */
export interface NoticeChanges {
  eventDate?: string
  amount?: number
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
}

const NOTICE_COLUMNS: Record<keyof NoticeChanges, string> = {
  eventDate: 'event_date',
  amount: 'amount',
  dueDate: 'due_date',
  noticeNumber: 'notice_number',
  description: 'description',
  purposeInvestments: 'purpose_investments',
  purposeFees: 'purpose_fees',
  purposeExpenses: 'purpose_expenses',
  charReturnOfCapital: 'char_return_of_capital',
  charRealizedGain: 'char_realized_gain',
  charIncome: 'char_income',
  recallableAmount: 'recallable_amount',
}

/**
 * A correction's fields from a request body or tool input, in either the API's camelCase or the
 * tool's snake_case. Only keys present are taken, so an omitted field is left as it is.
 */
export function noticeChangesFrom(body: Record<string, any> | null | undefined): NoticeChanges {
  const out: NoticeChanges = {}
  for (const [key, column] of Object.entries(NOTICE_COLUMNS) as [keyof NoticeChanges, string][]) {
    if (body?.[key] !== undefined) (out as any)[key] = body[key]
    else if (body?.[column] !== undefined) (out as any)[key] = body[column]
  }
  return out
}

const NUMERIC_NOTICE_FIELDS = new Set<keyof NoticeChanges>([
  'amount', 'purposeInvestments', 'purposeFees', 'purposeExpenses',
  'charReturnOfCapital', 'charRealizedGain', 'charIncome', 'recallableAmount',
])

export interface NoticeUpdated {
  eventId: string
  status: 'confirmed' | 'draft'
  /** The transaction the notice owns, re-derived from the corrected notice. Absent for a draft. */
  transactionId?: string
  ledger?: unknown
  /** The later mark adjusted so the holding keeps its value. */
  markAdjusted?: string
  note?: string
  /** Later NAV statements re-booked against the corrected ledger. */
  navRebooked?: unknown[]
}

/**
 * Correct a capital notice already in the register: its date, amount, a call's purposes or a
 * distribution's character, and the descriptive fields. A draft just changes. A confirmed notice
 * re-derives the transaction it owns (linked or booked alike) and so its journal entry, refused as
 * a whole when the entry cannot be retracted (a closed period); then every NAV statement for the
 * holding and entity from the earlier of the old and new dates re-books, so the marks keep the
 * position at the manager's NAV. A distribution moved from realized gain to return of capital, say,
 * retires basis instead of booking a gain, and the next statement's mark absorbs the difference.
 */
export async function updateFundNotice(
  admin: SupabaseClient,
  who: { fundId: string; userId: string | null; vehicleNames: string[] | null },
  companyId: string,
  eventId: string,
  changes: NoticeChanges,
  /**
   * Work the distribution's return of capital and gain out again by cost recovery even though its
   * amount and date are unchanged. They are worked out anyway when either changes and no character
   * is passed.
   */
  opts: { recalculateCharacter?: boolean } = {},
): Promise<Outcome<NoticeUpdated>> {
  const holding = await fundHolding(admin, who.fundId, companyId)
  if (!holding.ok) return holding

  const { data: row, error } = await (admin as any).from('fund_capital_events')
    .select('*').eq('id', eventId).eq('fund_id', who.fundId).eq('company_id', companyId).maybeSingle()
  if (error) return dbFail(error, 'fund-register-notice-update')
  if (!row) return fail(404, `No notice ${eventId} on ${holding.value.name}.`)

  // Only a notice on one of the caller's entities.
  const vehicleName = row.vehicle_id ? await vehicleNameById(admin, who.fundId, row.vehicle_id) : null
  const denied = groupWriteDenial(who.vehicleNames, vehicleName)
  if (denied) return fail(403, denied)

  const patch: Record<string, unknown> = {}
  for (const [key, column] of Object.entries(NOTICE_COLUMNS) as [keyof NoticeChanges, string][]) {
    if (changes[key] === undefined) continue
    const value = changes[key]
    if (NUMERIC_NOTICE_FIELDS.has(key)) {
      const n = Number(value)
      if (!Number.isFinite(n) || n < 0) return fail(400, `${column} must be a non-negative number.`)
      patch[column] = n
    } else {
      patch[column] = value
    }
  }
  if (Object.keys(patch).length === 0 && !opts.recalculateCharacter) return fail(400, 'Pass at least one field of the notice to change.')
  if ('event_date' in patch && !ISO_DATE.test(String(patch.event_date ?? ''))) return fail(400, 'event_date must be a date (YYYY-MM-DD).')
  if (patch.due_date != null && !ISO_DATE.test(String(patch.due_date))) return fail(400, 'due_date must be a date (YYYY-MM-DD).')

  const call = row.kind === 'call'
  const next = { ...row, ...patch }
  // A call has no character and a distribution no purposes, whatever was passed.
  if (call) Object.assign(next, { char_return_of_capital: 0, char_realized_gain: 0, char_income: 0 })
  else Object.assign(next, { purpose_investments: 0, purpose_fees: 0, purpose_expenses: 0 })

  const amount = Number(next.amount)
  const characterStated = changes.charReturnOfCapital !== undefined || changes.charRealizedGain !== undefined
  if (!call && !characterStated && (opts.recalculateCharacter || 'amount' in patch || 'event_date' in patch)) {
    if (!vehicleName) return fail(400, 'This notice has no entity, so there is no cost to recover against.')
    const remaining = await remainingCostAt(admin, who.fundId, companyId, vehicleName, String(next.event_date), row.investment_transaction_id ?? null)
    const worked = costRecoverySplit(amount, remaining, Number(next.char_income ?? 0))
    Object.assign(next, {
      char_return_of_capital: worked.returnOfCapital,
      char_realized_gain: worked.realizedGain,
      char_income: worked.income,
    })
  }
  const split = call
    ? Number(next.purpose_investments) + Number(next.purpose_fees) + Number(next.purpose_expenses)
    : Number(next.char_return_of_capital) + Number(next.char_realized_gain) + Number(next.char_income)
  if (Math.abs(split - amount) > CENT) {
    return fail(400, call
      ? `The purposes (investments, fees, expenses) add up to ${split}, not the notice's ${amount}.`
      : `The character (return of capital, realized gain, income) adds up to ${split}, not the notice's ${amount}.`)
  }

  const rowUpdate = Object.fromEntries(Object.values(NOTICE_COLUMNS).map(c => [c, next[c]]))

  const txnId: string | null = row.investment_transaction_id ?? null
  if (!txnId) {
    const { error: updateError } = await (admin as any).from('fund_capital_events')
      .update(rowUpdate).eq('id', eventId).eq('fund_id', who.fundId)
    if (updateError) return dbFail(updateError, 'fund-register-notice-update')
    if (who.userId) logActivity(admin, who.fundId, who.userId, 'fund_holding.notice_update', { companyId, eventId })
    return done({ eventId, status: row.status === 'confirmed' ? 'confirmed' : 'draft' })
  }

  // The transaction the corrected notice implies, derived exactly as confirming it would.
  const { data: settings } = await (admin as any).from('vehicle_accounting_settings')
    .select('ledger_start_date').eq('fund_id', who.fundId).eq('vehicle_id', row.vehicle_id).maybeSingle()
  let draft
  try {
    draft = transactionForEvent({
      companyId,
      kind: row.kind,
      eventDate: String(next.event_date),
      amount,
      recallableAmount: Number(next.recallable_amount ?? 0),
      charReturnOfCapital: Number(next.char_return_of_capital ?? 0),
      charRealizedGain: Number(next.char_realized_gain ?? 0),
      charIncome: Number(next.char_income ?? 0),
      purposeInvestments: Number(next.purpose_investments ?? 0),
      purposeFees: Number(next.purpose_fees ?? 0),
      purposeExpenses: Number(next.purpose_expenses ?? 0),
    }, { ledgerStartDate: settings?.ledger_start_date ?? null })
  } catch (e) {
    return fail(400, (e as Error).message)
  }
  if (!draft) {
    return fail(400, `That date is before this entity's ledger starts (${settings?.ledger_start_date}), but the notice is already on the books. `
      + 'Keep it on or after that date.')
  }

  const { data: before } = await (admin as any).from('investment_transactions').select('*').eq('id', txnId).eq('fund_id', who.fundId).maybeSingle()

  // The notes stay: they say where a linked transaction came from.
  const { company_id: _company, notes: _notes, ...txnFields } = draft
  const edited = await updateInvestmentTransaction(admin, who, companyId, txnId, txnFields, { asRegister: true })
  if (!edited.ok) return edited

  const { error: updateError } = await (admin as any).from('fund_capital_events')
    .update(rowUpdate).eq('id', eventId).eq('fund_id', who.fundId)
  if (updateError) {
    return fail(500, `The transaction was re-booked from the corrected notice, but the notice itself could not be saved: ${updateError.message}. `
      + 'Save the notice again with the same values.')
  }
  if (who.userId) logActivity(admin, who.fundId, who.userId, 'fund_holding.notice_update', { companyId, eventId, transactionId: txnId })

  const since = [String(row.event_date), String(next.event_date)].sort()[0]
  const absorbed: Outcome<{ markId?: string; note?: string }> = vehicleName
    ? await absorbInNextMark(admin, who, companyId, vehicleName, since, carried(edited.value.transaction) - carried(before))
    : done({})
  if (!absorbed.ok) {
    return fail(absorbed.status, `The notice and its transaction were corrected, but the next mark could not be adjusted to keep the `
      + `holding at its value: ${absorbed.error}`)
  }
  const { rebookNavsFrom } = await import('./fof-nav')
  const navRebooked = row.vehicle_id
    ? await rebookNavsFrom(admin, who.fundId, who.userId, { companyId, vehicleId: row.vehicle_id, since, inclusive: true })
    : []

  return done({
    eventId,
    status: 'confirmed',
    transactionId: txnId,
    ledger: edited.value.ledger,
    ...(absorbed.value.markId ? { markAdjusted: absorbed.value.markId } : {}),
    ...(absorbed.value.note ? { note: absorbed.value.note } : {}),
    ...(navRebooked.length ? { navRebooked } : {}),
  })
}

export interface DistributionRecalculated {
  transactionId: string
  date: string
  amount: number
  eventId?: string
  returnOfCapital: { from: number; to: number }
}

/**
 * Work out again, by cost recovery, the return of capital on every distribution a fund holding paid
 * an entity, oldest first, and re-book the ones that differ: a register notice through
 * updateFundNotice (which re-books its transaction and the later NAV marks), any other proceeds
 * transaction through the ordinary edit. Income a notice states is kept. Stops at the first one that
 * cannot be re-booked (a closed period, say), saying which; the ones before it stay done.
 */
export async function recalculateFundDistributions(
  admin: SupabaseClient,
  who: { fundId: string; userId: string | null; vehicleNames: string[] | null },
  companyId: string,
  vehicleId: string,
  opts: { dryRun?: boolean } = {},
): Promise<Outcome<{ holding: string; entity: string; changed: DistributionRecalculated[]; unchanged: number; dryRun: boolean }>> {
  const holding = await fundHolding(admin, who.fundId, companyId)
  if (!holding.ok) return holding
  const vehicleName = await vehicleNameById(admin, who.fundId, vehicleId)
  if (!vehicleName) return fail(404, 'That entity was not found.')
  const denied = groupWriteDenial(who.vehicleNames, vehicleName)
  if (denied) return fail(403, denied)

  const [txns, events] = await Promise.all([
    (admin as any).from('investment_transactions').select('*')
      .eq('fund_id', who.fundId).eq('company_id', companyId).eq('portfolio_group', vehicleName).eq('transaction_type', 'proceeds'),
    (admin as any).from('fund_capital_events').select('*')
      .eq('fund_id', who.fundId).eq('company_id', companyId).eq('kind', 'distribution'),
  ])
  if (txns.error || events.error) return dbFail(txns.error ?? events.error, 'fund-distribution-recalculate')
  const noticeFor = new Map<string, any>()
  for (const e of (events.data as any[]) ?? []) if (e.investment_transaction_id) noticeFor.set(e.investment_transaction_id, e)

  const ordered = [...((txns.data as any[]) ?? [])].sort((a, b) =>
    String(a.transaction_date).localeCompare(String(b.transaction_date)) || String(a.id).localeCompare(String(b.id)))

  const changed: DistributionRecalculated[] = []
  let unchanged = 0
  // A dry run carries each worked-out figure forward itself, since nothing is written for the next
  // distribution's remaining cost to read.
  let dryRunShift = 0
  for (const t of ordered) {
    const notice = noticeFor.get(t.id)
    const amount = Number(t.proceeds_received ?? 0)
    const income = Number(notice?.char_income ?? 0)
    const remaining = Math.max(0, await remainingCostAt(admin, who.fundId, companyId, vehicleName, t.transaction_date, t.id) - dryRunShift)
    const worked = costRecoverySplit(amount, remaining, income)
    const from = Number(t.cost_basis_exited ?? 0)
    if (Math.abs(from - worked.returnOfCapital) <= CENT) { unchanged++; continue }

    const entry: DistributionRecalculated = {
      transactionId: t.id, date: t.transaction_date, amount,
      ...(notice ? { eventId: notice.id } : {}),
      returnOfCapital: { from, to: worked.returnOfCapital },
    }
    if (opts.dryRun) {
      dryRunShift += worked.returnOfCapital - from
      changed.push(entry)
      continue
    }
    const out = notice
      ? await updateFundNotice(admin, who, companyId, notice.id, {
          charReturnOfCapital: worked.returnOfCapital, charRealizedGain: worked.realizedGain, charIncome: worked.income,
        })
      : await updateInvestmentTransaction(admin, who, companyId, t.id, { cost_basis_exited: worked.returnOfCapital })
        .then(async o => o.ok ? absorbInNextMark(admin, who, companyId, vehicleName, t.transaction_date, from - worked.returnOfCapital) : o)
    if (!out.ok) {
      return fail(out.status, `Stopped at the ${t.transaction_date} distribution of ${amount}: ${out.error}`
        + (changed.length ? ` The ${changed.length} before it were re-booked.` : ''), { changed })
    }
    changed.push(entry)
  }

  if (!opts.dryRun && changed.length && who.userId) {
    logActivity(admin, who.fundId, who.userId, 'fund_holding.distributions_recalculated', { companyId, vehicleId, changed: changed.length })
  }
  return done({ holding: holding.value.name, entity: vehicleName, changed, unchanged, dryRun: !!opts.dryRun })
}
