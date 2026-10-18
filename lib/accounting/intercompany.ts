// Charges between two vehicles of the same firm — the management fee a fund owes the management
// company, a cost one entity paid on another's behalf, an advance between them.
//
// WHY THIS IS ITS OWN MODULE AND NOT TWO JOURNAL ENTRIES.
//
// An intercompany charge is one economic fact and two ledgers. Booked as two ordinary journal
// entries, nothing in the system knows they are the same charge: the manco's receivable and the
// fund's payable are independent numbers that agree only for as long as both were typed correctly,
// and when they stop agreeing there is no way to tell which one moved. That is the classic
// intercompany failure, and it is discovered at audit.
//
// So a charge is a row (`intercompany_transactions`), and posting it writes BOTH sides in one
// action, each entry tagged `source_ref = 'intercompany:<id>'` — the same convention the period
// close uses to find the entries it wrote. Settlement entries carry `intercompany-settlement:<id>`,
// a ref of their own so a unique index can allow one per vehicle (20261014190000). The row keeps
// the entry ids as well, so the reconciliation is a lookup in either direction rather than a join
// on a memo string.
//
// WHAT IS NOT HERE: the BALANCE. The outstanding due-from/due-to per counterparty is read off the
// ledger (`intercompanyBalances` below), not summed from these rows. A register that computed its
// own balance would disagree with the balance sheet the first time anyone posted a correcting
// entry by hand, and nothing would say which was right. The ledger is the answer; this table is
// the story of how it got there.

import type { SupabaseClient } from '@supabase/supabase-js'
import { roundCents } from './ledger'
import { liveEntryByRef, persistEntry, type LiveEntryRef } from './persist'
import { fetchAllRows } from './load'
import { vehicleIdByName } from './vehicle-id'
import {
  INTERCOMPANY_RECEIVABLE_CODE, INTERCOMPANY_PAYABLE_CODE,
  INTERCOMPANY_RECEIVABLE_SUBTYPE, INTERCOMPANY_PAYABLE_SUBTYPE,
  intercompanyCode,
} from './chart'
import { ACTUAL_BOOK } from './books'
import type { JournalEntry } from './types'

export const INTERCOMPANY_KINDS = [
  'management_fee', 'expense_reimbursement', 'allocated_cost',
  'loan_advance', 'loan_repayment', 'other',
  // The management company handing back part of a fee already charged (a GPU SPV's fee true-up
  // when revenue is reversed after the fee was paid): payer and payee swap.
  'management_fee_rebate',
] as const

export type IntercompanyKind = (typeof INTERCOMPANY_KINDS)[number]

export const INTERCOMPANY_KIND_LABELS: Record<IntercompanyKind, string> = {
  management_fee: 'Management fee',
  expense_reimbursement: 'Expense reimbursement',
  allocated_cost: 'Allocated cost',
  loan_advance: 'Advance',
  loan_repayment: 'Advance repaid',
  other: 'Other charge',
  management_fee_rebate: 'Management fee rebate',
}

/**
 * Kinds that CREATE an obligation now and move cash later — the ones with an accrual and a
 * separate settlement. The rest move cash at the moment they are recorded, so they have one event
 * and no settlement of their own (an advance is cleared by recording a repayment, which is its own
 * row, because that is what actually happened).
 */
const ACCRUING_KINDS: IntercompanyKind[] = [
  'management_fee', 'expense_reimbursement', 'allocated_cost', 'other', 'management_fee_rebate',
]

export function isAccruingKind(kind: IntercompanyKind): boolean {
  return ACCRUING_KINDS.includes(kind)
}

/**
 * Which P&L account each side books, IN PREFERENCE ORDER, by `chart_of_accounts.subtype`.
 *
 * Subtype rather than code, because the two sides of a charge hold different charts: the payee is
 * usually the management company (4000 management fee income) and the payer a fund (5000
 * management fee expense), but either can be a GP entity, whose chart numbers the same concepts
 * differently. A subtype survives that; a code does not.
 *
 * The list is a preference, not a fallback chain to a wrong answer — every entry in it is a
 * defensible home for that charge on some chart. When none of them exists, this refuses to post
 * rather than picking the nearest account, because an intercompany charge landing in the wrong
 * income account is a misstatement that balances, and therefore one nothing will ever flag.
 */
const INCOME_SUBTYPES: Record<IntercompanyKind, string[]> = {
  management_fee: ['management_fee_income'],
  expense_reimbursement: ['reimbursement_income', 'other_income'],
  allocated_cost: ['reimbursement_income', 'other_income'],
  other: ['other_income', 'reimbursement_income'],
  // The payee of a rebate is the vehicle that paid the fee: what it gains is its fee expense back.
  management_fee_rebate: ['management_fee'],
  // Cash kinds never touch the P&L: lending money is not income to the lender.
  loan_advance: [],
  loan_repayment: [],
}

const EXPENSE_SUBTYPES: Record<IntercompanyKind, string[]> = {
  management_fee: ['management_fee', 'partnership_expense', 'operating_expense'],
  expense_reimbursement: ['partnership_expense', 'operating_expense', 'office'],
  allocated_cost: ['partnership_expense', 'operating_expense', 'office'],
  other: ['partnership_expense', 'operating_expense', 'office'],
  // The payer of a rebate is the management company: what it gives up is fee income it booked.
  management_fee_rebate: ['management_fee_income'],
  loan_advance: [],
  loan_repayment: [],
}

/** The accounts one side of a charge posts to. */
export interface SideAccounts {
  /** Due-from-<counterparty> (the payee) or due-to-<counterparty> (the payer). */
  intercompanyAccountId: string
  cashAccountId: string
  /** Income for the payee, expense for the payer. Absent for the cash-only kinds. */
  pnlAccountId?: string | null
}

export interface ChargeInput {
  fundId: string
  kind: IntercompanyKind
  /** YYYY-MM-DD. */
  chargeDate: string
  amount: number
  memo?: string | null
  /** The intercompany_transactions row id, so both entries can point back at it. */
  chargeId: string
}

const sourceRef = (chargeId: string) => `intercompany:${chargeId}`

/** The accrual entries' ref (both sides of the charge). */
export const intercompanyChargeRef = sourceRef

/** The settlement entries' ref: one live entry per vehicle, enforced by a unique index. */
export const intercompanySettlementRef = (chargeId: string) => `intercompany-settlement:${chargeId}`

/**
 * The PAYEE's entry — the side that is owed. Debits what it is owed (or, for an advance, pays the
 * cash out) and credits the income it earned (or the cash it lent).
 *
 *   management fee   Dr Due from <payer>   Cr Management fee income
 *   advance          Dr Due from <payer>   Cr Cash
 */
export function buildPayeeEntry(input: ChargeInput, accts: SideAccounts): JournalEntry {
  const amount = roundCents(input.amount)
  if (!(amount > 0)) throw new Error('An intercompany charge must be a positive amount')
  const credit = isAccruingKind(input.kind) ? accts.pnlAccountId : accts.cashAccountId
  if (!credit) throw new Error('No income account for this charge on the payee’s chart')
  return finalizeCharge(input, [
    { accountId: accts.intercompanyAccountId, amount, currency: 'USD', lpEntityId: null },
    { accountId: credit, amount: -amount, currency: 'USD', lpEntityId: null },
  ])
}

/**
 * The PAYER's entry — the side that owes. Debits the cost it incurred (or, for an advance, the
 * cash it received) and credits what it now owes.
 *
 *   management fee   Dr Management fee expense   Cr Due to <payee>
 *   advance          Dr Cash                     Cr Due to <payee>
 */
export function buildPayerEntry(input: ChargeInput, accts: SideAccounts): JournalEntry {
  const amount = roundCents(input.amount)
  if (!(amount > 0)) throw new Error('An intercompany charge must be a positive amount')
  const debit = isAccruingKind(input.kind) ? accts.pnlAccountId : accts.cashAccountId
  if (!debit) throw new Error('No expense account for this charge on the payer’s chart')
  return finalizeCharge(input, [
    { accountId: debit, amount, currency: 'USD', lpEntityId: null },
    { accountId: accts.intercompanyAccountId, amount: -amount, currency: 'USD', lpEntityId: null },
  ])
}

/**
 * Settlement: the cash finally moves and the balance clears. The mirror of the two above, with
 * cash on the other side.
 *
 *   payee   Dr Cash              Cr Due from <payer>
 *   payer   Dr Due to <payee>    Cr Cash
 */
export function buildPayeeSettlementEntry(
  input: ChargeInput & { settledDate: string },
  accts: SideAccounts,
): JournalEntry {
  const amount = roundCents(input.amount)
  return finalizeCharge({ ...input, chargeDate: input.settledDate }, [
    { accountId: accts.cashAccountId, amount, currency: 'USD', lpEntityId: null },
    { accountId: accts.intercompanyAccountId, amount: -amount, currency: 'USD', lpEntityId: null },
  ], 'intercompany_settlement', intercompanySettlementRef(input.chargeId))
}

export function buildPayerSettlementEntry(
  input: ChargeInput & { settledDate: string },
  accts: SideAccounts,
): JournalEntry {
  const amount = roundCents(input.amount)
  return finalizeCharge({ ...input, chargeDate: input.settledDate }, [
    { accountId: accts.intercompanyAccountId, amount, currency: 'USD', lpEntityId: null },
    { accountId: accts.cashAccountId, amount: -amount, currency: 'USD', lpEntityId: null },
  ], 'intercompany_settlement', intercompanySettlementRef(input.chargeId))
}

function finalizeCharge(
  input: ChargeInput,
  postings: JournalEntry['postings'],
  sourceType = 'intercompany',
  ref = sourceRef(input.chargeId),
): JournalEntry {
  return {
    fundId: input.fundId,
    entryDate: input.chargeDate,
    memo: input.memo ?? INTERCOMPANY_KIND_LABELS[input.kind],
    sourceType,
    sourceRef: ref,
    postings,
  }
}

// ── Chart plumbing ────────────────────────────────────────────────────────────────────────────

/**
 * Guarantee that a vehicle's chart can hold an intercompany balance with one named counterparty:
 * the 1900/2900 parents, and a `1900-<cp>` / `2900-<cp>` sub-account beneath each.
 *
 * The same shape as `ensureCapitalAccounts`, and for the same reason. A single pooled "due from
 * affiliates" is unreconcilable the moment there are two affiliates: each counterparty has to agree
 * to a matching balance on its own books, and it cannot agree to its share of a total. One account
 * per counterparty makes the confirmation a single number on both sides.
 *
 * Idempotent — it is called before every posting, and creates only what is missing. Returns the two
 * sub-account ids, which is all the caller wants.
 */
export async function ensureIntercompanyAccounts(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  counterparty: { vehicleId: string; name: string },
): Promise<{ receivableAccountId: string; payableAccountId: string }> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  if (!vehicleId) throw new Error(`Unknown vehicle "${group}"`)

  const receivableCode = intercompanyCode(INTERCOMPANY_RECEIVABLE_CODE, counterparty.vehicleId)
  const payableCode = intercompanyCode(INTERCOMPANY_PAYABLE_CODE, counterparty.vehicleId)

  const { data: existing } = await admin
    .from('chart_of_accounts' as any)
    .select('id, code')
    .eq('fund_id', fundId)
    .eq('vehicle_id', vehicleId)
  const byCode = new Map(((existing as any[]) ?? []).map(a => [a.code as string, a.id as string]))

  const wanted = [
    // The parents. A vehicle whose chart already has them (a manco) keeps what it has; a fund's
    // chart gets them created the first time it is party to a charge, which is the only moment it
    // could possibly need them.
    { code: INTERCOMPANY_RECEIVABLE_CODE, name: 'Due from affiliates', type: 'asset', subtype: INTERCOMPANY_RECEIVABLE_SUBTYPE },
    { code: INTERCOMPANY_PAYABLE_CODE, name: 'Due to affiliates', type: 'liability', subtype: INTERCOMPANY_PAYABLE_SUBTYPE },
    { code: receivableCode, name: `Due from ${counterparty.name}`, type: 'asset', subtype: INTERCOMPANY_RECEIVABLE_SUBTYPE },
    { code: payableCode, name: `Due to ${counterparty.name}`, type: 'liability', subtype: INTERCOMPANY_PAYABLE_SUBTYPE },
  ].filter(a => !byCode.has(a.code))

  if (wanted.length > 0) {
    const { data: created, error } = await admin
      .from('chart_of_accounts' as any)
      .insert(wanted.map(a => ({
        fund_id: fundId, portfolio_group: group, vehicle_id: vehicleId,
        code: a.code, name: a.name, type: a.type, subtype: a.subtype,
      })))
      .select('id, code')
    if (error) throw new Error(`Could not create intercompany accounts on ${group}: ${error.message}`)
    for (const a of ((created as any[]) ?? [])) byCode.set(a.code as string, a.id as string)
  }

  return {
    receivableAccountId: byCode.get(receivableCode)!,
    payableAccountId: byCode.get(payableCode)!,
  }
}

/**
 * The cash and P&L accounts one side needs, resolved from ITS chart by subtype.
 *
 * Returns an error string rather than throwing, because every one of these is a thing the user can
 * fix themselves — add the account, or seed the chart — and the route turns it straight into a
 * message that says which account is missing on which vehicle.
 */
export async function resolveSideAccounts(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  kind: IntercompanyKind,
  role: 'payee' | 'payer',
  intercompanyAccountId: string,
): Promise<SideAccounts | { error: string }> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  const { data } = await admin
    .from('chart_of_accounts' as any)
    .select('id, code, subtype')
    .eq('fund_id', fundId)
    .eq('vehicle_id', vehicleId)
  const accounts = ((data as any[]) ?? []) as { id: string; code: string; subtype: string | null }[]

  const bySubtype = (wanted: string[]): string | null => {
    for (const s of wanted) {
      const hit = accounts.find(a => a.subtype === s)
      if (hit) return hit.id
    }
    return null
  }

  // Cash: the operating account. Prefer code 1000 over any other cash-subtyped account, so a firm
  // with an operating and a reserve account settles out of the operating one rather than whichever
  // row the database returned first.
  const cash = accounts.find(a => a.code === '1000' && a.subtype === 'cash')?.id
    ?? bySubtype(['cash'])
  if (!cash) return { error: `${group} has no cash account — seed its chart of accounts first.` }

  if (!isAccruingKind(kind)) {
    return { intercompanyAccountId, cashAccountId: cash, pnlAccountId: null }
  }

  const wanted = role === 'payee' ? INCOME_SUBTYPES[kind] : EXPENSE_SUBTYPES[kind]
  const pnl = bySubtype(wanted)
  if (!pnl) {
    const what = role === 'payee' ? 'income' : 'expense'
    return {
      error:
        `${group} has no ${what} account for a ${INTERCOMPANY_KIND_LABELS[kind].toLowerCase()} ` +
        `(looked for ${wanted.join(' or ')}). Add one to its chart of accounts and try again.`,
    }
  }
  return { intercompanyAccountId, cashAccountId: cash, pnlAccountId: pnl }
}

/**
 * Void an ACCRUED charge and both of its entries — a charge that has to be re-issued at another
 * amount before any cash moved (a GPU SPV's fee true-up when revenue is reversed). One database
 * transaction (`void_intercompany_charge`): the charge is locked, rechecked unsettled, and its two
 * entries, the allocations they generated and the row are voided together or not at all. A settled
 * charge is refused: what has been paid is undone by a rebate, not by voiding history.
 */
export async function voidUnsettledCharge(admin: SupabaseClient, fundId: string, chargeId: string): Promise<{ ok: true } | { error: string }> {
  const { error } = await admin.rpc('void_intercompany_charge' as any, { p_fund_id: fundId, p_charge_id: chargeId } as any)
  return error ? { error: `Charge ${chargeId} could not be voided: ${error.message}` } : { ok: true }
}

// ── Posting ───────────────────────────────────────────────────────────────────────────────────

export interface PostChargeArgs {
  fundId: string
  userId: string | null
  kind: IntercompanyKind
  chargeDate: string
  amount: number
  memo?: string | null
  payer: { vehicleId: string; name: string }
  payee: { vehicleId: string; name: string }
  /**
   * The payee's receivable is already on its books, line by line: a management company that paid
   * a fund's expenses booked each one to "Due from <fund>" as it paid. Only the payer's side is
   * posted, and the charge has no payee entry. Its settlement still clears both sides.
   */
  payeeAlreadyBooked?: boolean
  /**
   * The partnership invoice this charge books. A unique index allows one live charge per invoice,
   * so a second issue of the same invoice is refused at the insert, before anything is posted.
   */
  partnershipInvoiceId?: string | null
  /** The system process that raised the charge (e.g. `gpu-fee:<vehicle>:<YYYY-MM>`), so it can find
   *  its own charges without reading the memo. Absent for a charge raised by hand. */
  sourceRef?: string | null
}

/**
 * Record a charge and post both sides.
 *
 * ORDER MATTERS, and it is: create the row, post the payee, post the payer, then link. If the
 * payer's entry fails (a closed period on the fund's books is the realistic case), the payee's
 * entry is voided and the row is deleted, so a half-posted charge never survives. That rollback is
 * best-effort — supabase-js has no transaction — and the reason the row is created FIRST is that a
 * failure after the entries are written must still leave something that names them.
 */
export async function postIntercompanyCharge(
  admin: SupabaseClient,
  args: PostChargeArgs,
): Promise<{ id: string } | { error: string; duplicate?: true }> {
  const amount = roundCents(args.amount)
  if (!(amount > 0)) return { error: 'Amount must be greater than zero' }
  if (args.payer.vehicleId === args.payee.vehicleId) {
    return { error: 'A vehicle cannot charge itself' }
  }

  const { data: row, error: rowErr } = await admin
    .from('intercompany_transactions' as any)
    .insert({
      fund_id: args.fundId,
      from_vehicle_id: args.payer.vehicleId,
      to_vehicle_id: args.payee.vehicleId,
      kind: args.kind,
      charge_date: args.chargeDate,
      amount,
      memo: args.memo ?? null,
      status: 'accrued',
      created_by: args.userId,
      partnership_invoice_id: args.partnershipInvoiceId ?? null,
      ...(args.sourceRef ? { source_ref: args.sourceRef } : {}),
    })
    .select('id')
    .single()
  if (rowErr) {
    if ((rowErr as { code?: string }).code === '23505' && args.partnershipInvoiceId) {
      return { error: 'This invoice is being issued by another request. Refresh and try again.', duplicate: true }
    }
    return { error: rowErr.message }
  }
  const chargeId = (row as any).id as string

  // Only an accrued charge nothing is linked to: a linked one names posted entries, and a voided one
  // is the record that it was voided. Neither is deleted here.
  const cleanup = async () => {
    await admin.from('intercompany_transactions' as any).delete().eq('id', chargeId).eq('status', 'accrued').is('from_entry_id', null)
  }

  // Each side's own intercompany sub-account for the OTHER side.
  let payeeAccts: SideAccounts | { error: string }
  let payerAccts: SideAccounts | { error: string }
  try {
    const payeeIc = await ensureIntercompanyAccounts(admin, args.fundId, args.payee.name, args.payer)
    const payerIc = await ensureIntercompanyAccounts(admin, args.fundId, args.payer.name, args.payee)
    payeeAccts = await resolveSideAccounts(admin, args.fundId, args.payee.name, args.kind, 'payee', payeeIc.receivableAccountId)
    payerAccts = await resolveSideAccounts(admin, args.fundId, args.payer.name, args.kind, 'payer', payerIc.payableAccountId)
  } catch (e) {
    await cleanup()
    return { error: (e as Error).message }
  }
  if ('error' in payeeAccts && !args.payeeAlreadyBooked) { await cleanup(); return payeeAccts }
  if ('error' in payerAccts) { await cleanup(); return payerAccts }

  const input: ChargeInput = {
    fundId: args.fundId, kind: args.kind, chargeDate: args.chargeDate,
    amount, memo: args.memo, chargeId,
  }

  let payeeEntryId: string | null = null
  if (!args.payeeAlreadyBooked) {
    const payeeRes = await persistEntry(
      admin, args.fundId, args.payee.name, args.userId, buildPayeeEntry(input, payeeAccts as SideAccounts),
    )
    if ('error' in payeeRes) { await cleanup(); return { error: `${args.payee.name}: ${payeeRes.error}` } }
    payeeEntryId = payeeRes.entryId
  }

  const payerRes = await persistEntry(
    admin, args.fundId, args.payer.name, args.userId, buildPayerEntry(input, payerAccts),
  )
  if ('error' in payerRes) {
    // Both sides or neither. A charge that exists on one ledger only is exactly the drift this
    // module was written to prevent, so unwind rather than report a partial success.
    const left = payeeEntryId ? await unwindIntercompanyEntry(admin, args.fundId, payeeEntryId) : null
    if (left) return { error: `${args.payer.name}: ${payerRes.error}. ${keptCharge(chargeId, left)}` }
    await cleanup()
    return { error: `${args.payer.name}: ${payerRes.error}` }
  }

  const link = () => admin
    .from('intercompany_transactions' as any)
    .update({
      to_entry_id: payeeEntryId,
      from_entry_id: payerRes.entryId,
      // A cash kind moves the money as it is recorded; there is nothing left to settle.
      ...(isAccruingKind(args.kind) ? {} : { status: 'settled', settled_date: args.chargeDate }),
    })
    // Still accrued and unlinked: a charge voided meanwhile (voiding a draft invoice clears one
    // that has no entry yet) must not be linked to what this request has just posted.
    .eq('id', chargeId).eq('fund_id', args.fundId).eq('status', 'accrued').is('from_entry_id', null)
    .select('id')
  // THE LINK IS THE COMMIT POINT. A retry trusts a charge only through the entry ids written here,
  // which is only ever after persistEntry has returned (a posted header alone can still be rolled
  // back by its allocation). So a link that cannot be written is retried once, then both sides are
  // unwound: an unlinked charge with entries behind it is an orphan nothing will ever adopt.
  let linked = await link()
  if (linked.error) linked = await link()
  if (linked.error || ((linked.data as any[]) ?? []).length === 0) {
    // A lost response looks like a failure: the link may have committed. Ours is ours.
    const { data: now, error: readErr } = await admin.from('intercompany_transactions' as any)
      .select('status, from_entry_id').eq('id', chargeId).eq('fund_id', args.fundId).maybeSingle()
    // Not knowing whether the link committed is not knowing it failed: unwinding a committed link
    // would leave a linked charge pointing at nothing. Leave both for the explicit void path.
    if (readErr) {
      const entries = [payerRes.entryId, payeeEntryId].filter(Boolean).join(', ')
      return {
        error: `Charge ${chargeId} may or may not be linked to its entries (${entries}): the link failed and the charge could not be re-read ` +
          `(${readErr.message}). Nothing was undone. Check the charge; if it names no entry, void those entries in the journal, then void the invoice.`,
      }
    }
    if ((now as any)?.from_entry_id === payerRes.entryId) return { id: chargeId }

    const why = linked.error?.message ?? `the charge is ${(now as any)?.status === 'void' ? 'void' : 'no longer unlinked'}`
    const left = await unwindIntercompanyEntries(admin, args.fundId, [payerRes.entryId, payeeEntryId])
    if (left) return { error: `The charge could not be linked to its entries (${why}). ${keptCharge(chargeId, left)}` }
    await cleanup()
    return { error: `The charge could not be linked to its entries (${why}), so neither side was booked.` }
  }

  return { id: chargeId }
}

/** The refusal when an unwind could not be confirmed: the charge stays, as the guard against a rebook. */
function keptCharge(chargeId: string, left: string): string {
  return `Unwinding it could not be confirmed: ${left}. Charge ${chargeId} is kept so the invoice is not booked again; ` +
    'void those entries in the journal, then void the invoice.'
}

/**
 * Delete an entry this request just posted, with every partner allocation entry it generated, and
 * CONFIRM they are gone. rollbackGeneratedAllocations discards its own errors, and a ledger delete
 * can be refused (the period lock), so success is read back rather than assumed. Returns null once
 * nothing is left, or a description naming what is.
 */
export async function unwindIntercompanyEntry(admin: SupabaseClient, fundId: string, entryId: string): Promise<string | null> {
  const problems: string[] = []
  try {
    const { rollbackGeneratedAllocations } = await import('./continuous-allocation')
    await rollbackGeneratedAllocations(admin, fundId, entryId)
  } catch (e) {
    problems.push((e as Error).message)
  }
  const { error: postingsErr } = await admin.from('journal_postings' as any).delete().eq('journal_entry_id', entryId)
  if (postingsErr) problems.push(postingsErr.message)
  else {
    const { error: entryErr } = await admin.from('journal_entries' as any).delete().eq('id', entryId).eq('fund_id', fundId)
    if (entryErr) problems.push(entryErr.message)
  }
  const [source, generated] = await Promise.all([
    admin.from('journal_entries' as any).select('id').eq('fund_id', fundId).eq('id', entryId),
    admin.from('journal_entries' as any).select('id').eq('fund_id', fundId).eq('book', ACTUAL_BOOK).like('source_ref', `allocation:${entryId}:%`),
  ])
  const readErr = source.error ?? generated.error
  if (readErr) return `entry ${entryId} may still be on the books (it could not be checked: ${readErr.message})`
  const left = [...((source.data as any[]) ?? []), ...((generated.data as any[]) ?? [])].map(r => r.id as string)
  if (left.length === 0) return null
  return `entries ${left.join(', ')} are still on the books${problems.length ? ` (${problems.join('; ')})` : ''}`
}

async function unwindIntercompanyEntries(admin: SupabaseClient, fundId: string, ids: (string | null)[]): Promise<string | null> {
  const left: string[] = []
  for (const id of ids) {
    if (!id) continue
    const l = await unwindIntercompanyEntry(admin, fundId, id)
    if (l) left.push(l)
  }
  return left.length ? left.join('; ') : null
}

/**
 * Settle an accrued charge: post the cash on both sides and mark the row settled.
 *
 * Refuses a charge that is already settled or void rather than posting a second pair of cash
 * entries, which would clear a balance that was already clear and leave the counterparty holding a
 * receivable that has now been paid twice on our books and once on theirs.
 *
 * ONCE PER VEHICLE, ENFORCED BY THE DATABASE. The status check is a separate read, so two requests
 * can both pass it. Each settlement entry carries `intercompany-settlement:<chargeId>`, and a
 * partial unique index (20261014190000) allows one live entry per vehicle with that ref: the
 * second request's entry is refused before anything of its own is written.
 *
 * LINKED AS IT GOES, REPLAYED ONLY FROM LINKS. Each side's entry id is written to the row the moment
 * its persistEntry returns, and a retry trusts only those ids: both linked finishes the row, one
 * linked posts only the other side. An entry that exists by ref but was never linked is not adopted
 * (it may belong to a request still allocating it, which can yet delete it); it is named, for a
 * person to void.
 */
export async function settleIntercompanyCharge(
  admin: SupabaseClient,
  fundId: string,
  userId: string | null,
  chargeId: string,
  settledDate: string,
): Promise<{ ok: true } | { error: string }> {
  const { data: row, error: rowErr } = await admin
    .from('intercompany_transactions' as any)
    .select('*')
    .eq('id', chargeId).eq('fund_id', fundId).maybeSingle()
  if (rowErr) return { error: `The charge could not be read: ${rowErr.message}` }
  if (!row) return { error: 'Charge not found' }
  const charge = row as any
  if (charge.status !== 'accrued') return { error: `That charge is already ${charge.status}.` }

  const names = await vehicleNames(admin, fundId, [charge.from_vehicle_id, charge.to_vehicle_id])
  const payer = names.get(charge.from_vehicle_id)
  const payee = names.get(charge.to_vehicle_id)
  if (!payer || !payee) return { error: 'One side of that charge is no longer a vehicle in this fund.' }

  // Settlements booked before 20261014190000, under the accrual's ref. Their only writer was the old
  // code, which no longer runs, so they cannot be in flight and are safe to adopt by ref.
  let legacyPayee: LiveEntryRef | null
  let legacyPayer: LiveEntryRef | null
  try {
    [legacyPayee, legacyPayer] = await Promise.all([
      liveLegacySettlement(admin, fundId, charge.to_vehicle_id, chargeId),
      liveLegacySettlement(admin, fundId, charge.from_vehicle_id, chargeId),
    ])
  } catch (e) {
    return { error: (e as Error).message }
  }
  if (legacyPayee?.status === 'posted' && legacyPayer?.status === 'posted') {
    return markSettled(admin, fundId, chargeId, legacyPayee.entryDate, legacyPayee.id, legacyPayer.id, true)
  }
  const legacy = legacyPayee ? { side: payee, entry: legacyPayee } : legacyPayer ? { side: payer, entry: legacyPayer } : null
  if (legacy) {
    return {
      error: `${legacy.side} already has a settlement entry for this charge (${legacy.entry.id}, ${legacy.entry.status}) ` +
        'without the other side posted. Void that entry in the journal, then settle again.',
    }
  }

  let linked: { payee: LiveEntryRef | null; payer: LiveEntryRef | null }
  try {
    linked = await linkedSettlements(admin, fundId, charge.to_settlement_entry_id, charge.from_settlement_entry_id)
  } catch (e) {
    return { error: (e as Error).message }
  }
  if (linked.payee && linked.payer) {
    return markSettled(admin, fundId, chargeId, linked.payee.entryDate, linked.payee.id, linked.payer.id)
  }
  // One side already booked fixes the date: the cash moved once, on the date that side records.
  const date = linked.payee?.entryDate ?? linked.payer?.entryDate ?? settledDate

  const payeeIc = await ensureIntercompanyAccounts(admin, fundId, payee, { vehicleId: charge.from_vehicle_id, name: payer })
  const payerIc = await ensureIntercompanyAccounts(admin, fundId, payer, { vehicleId: charge.to_vehicle_id, name: payee })
  const payeeAccts = await resolveSideAccounts(admin, fundId, payee, charge.kind, 'payee', payeeIc.receivableAccountId)
  const payerAccts = await resolveSideAccounts(admin, fundId, payer, charge.kind, 'payer', payerIc.payableAccountId)
  if ('error' in payeeAccts) return payeeAccts
  if ('error' in payerAccts) return payerAccts

  const input = {
    fundId, kind: charge.kind as IntercompanyKind, chargeDate: charge.charge_date,
    amount: Number(charge.amount), memo: charge.memo, chargeId, settledDate: date,
  }

  let payeeId = linked.payee?.id ?? null
  let postedPayee: string | null = null
  if (!payeeId) {
    const res = await persistEntry(admin, fundId, payee, userId, buildPayeeSettlementEntry(input, payeeAccts))
    if ('error' in res) {
      if ('duplicateOf' in res) return unlinkedSettlement(admin, fundId, chargeId, 'to_settlement_entry_id', payee, charge.to_vehicle_id)
      return { error: `${payee}: ${res.error}` }
    }
    const linkErr = await linkSettlement(admin, fundId, chargeId, 'to_settlement_entry_id', res.entryId, charge.to_settlement_entry_id)
    if (linkErr && 'unknown' in linkErr) return unknownLink(payee, chargeId, res.entryId, linkErr.unknown)
    if (linkErr) {
      const left = await unwindIntercompanyEntry(admin, fundId, res.entryId)
      return { error: `${payee}: the settlement could not be linked to its charge (${linkErr.failed}), so it was not booked${left ? `, but ${left}; void them in the journal` : ''}.` }
    }
    payeeId = postedPayee = res.entryId
  }

  // Both sides or neither, for what this request posted, and only while nothing else relies on it:
  // once the payee entry is linked another attempt can read it and finish the settlement with its
  // own payer side. So it is unlinked only while the payer side is still unlinked, and deleted only
  // if that unlink matched. Returns a note for the error when something is left behind.
  const unwindPayee = async (): Promise<string> => {
    if (!postedPayee) return ''
    const { data, error } = await admin.from('intercompany_transactions' as any).update({ to_settlement_entry_id: null })
      .eq('id', chargeId).eq('fund_id', fundId).eq('status', 'accrued')
      .eq('to_settlement_entry_id', postedPayee).is('from_settlement_entry_id', null)
      .select('id')
    if (error || ((data as any[]) ?? []).length === 0) return ''
    const left = await unwindIntercompanyEntry(admin, fundId, postedPayee)
    return left ? ` ${payee}'s settlement could not be removed: ${left}; void it in the journal.` : ''
  }

  let payerId = linked.payer?.id ?? null
  if (!payerId) {
    const res = await persistEntry(admin, fundId, payer, userId, buildPayerSettlementEntry(input, payerAccts))
    if ('error' in res) {
      // The index says a payer settlement already exists: another attempt is pairing (or has paired)
      // this payee entry. Report it; deleting anything here could undo a settlement that succeeded.
      if ('duplicateOf' in res) return unlinkedSettlement(admin, fundId, chargeId, 'from_settlement_entry_id', payer, charge.from_vehicle_id)
      return { error: `${payer}: ${res.error}.${await unwindPayee()}` }
    }
    const linkErr = await linkSettlement(admin, fundId, chargeId, 'from_settlement_entry_id', res.entryId, charge.from_settlement_entry_id)
    // Unknown: the payer link may have committed and paired the payee, so neither side is touched.
    if (linkErr && 'unknown' in linkErr) return unknownLink(payer, chargeId, res.entryId, linkErr.unknown)
    if (linkErr) {
      const left = await unwindIntercompanyEntry(admin, fundId, res.entryId)
      const payeeNote = await unwindPayee()
      return {
        error: `${payer}: the settlement could not be linked to its charge (${linkErr.failed}), so it was not booked` +
          `${left ? `, but ${left}; void them in the journal` : ''}.${payeeNote}`,
      }
    }
    payerId = res.entryId
  }

  return markSettled(admin, fundId, chargeId, date, payeeId, payerId)
}

type SettlementLink = 'to_settlement_entry_id' | 'from_settlement_entry_id'

/**
 * Write one side's settlement entry id onto the still-accrued charge, replacing only what this
 * request read there (nothing, or a link to an entry voided since). Returns the failure, if any. A
 * lost response reads as no row matched, so the row is re-read: our own id there is success.
 */
async function linkSettlement(
  admin: SupabaseClient, fundId: string, chargeId: string, column: SettlementLink, entryId: string, previous: string | null,
): Promise<null | { failed: string } | { unknown: string }> {
  let q = admin.from('intercompany_transactions' as any)
    .update({ [column]: entryId }).eq('id', chargeId).eq('fund_id', fundId).eq('status', 'accrued')
  q = previous ? q.eq(column, previous) : q.is(column, null)
  const { data, error } = await q.select('id')
  if (!error && ((data as any[]) ?? []).length > 0) return null
  const { data: now, error: readErr } = await admin.from('intercompany_transactions' as any)
    .select(`status, ${column}`).eq('id', chargeId).eq('fund_id', fundId).maybeSingle()
  // Unreadable: the link may have committed, and another request may already be using it. That is
  // not a failure to unwind on; the caller keeps the entry until the outcome is known.
  if (readErr) return { unknown: `${error?.message ?? 'the link matched no row'}, and the charge could not be re-read (${readErr.message})` }
  if ((now as any)?.[column] === entryId) return null
  if (error) return { failed: error.message }
  return { failed: (now as any)?.status !== 'accrued' ? `the charge is now ${(now as any)?.status ?? 'gone'}` : 'another request linked that side first' }
}

/** The error when a settlement link's outcome is unknown: nothing is undone. */
function unknownLink(side: string, chargeId: string, entryId: string, why: string): { error: string } {
  return {
    error: `${side}: settlement entry ${entryId} may or may not be linked to charge ${chargeId} (${why}). Nothing was undone. ` +
      'Settle the charge again: it finishes from whatever is linked, or names the entry to void if it is not.',
  }
}

/**
 * The unique index refused this side's settlement: a live one exists by ref. If the row now links
 * one, another request got there first. If not, name the entry: it is either a request still in
 * flight or the remains of one that died before linking, and only a person can tell which.
 */
async function unlinkedSettlement(
  admin: SupabaseClient, fundId: string, chargeId: string, column: SettlementLink, side: string, vehicleId: string,
): Promise<{ error: string }> {
  const { data: now } = await admin.from('intercompany_transactions' as any)
    .select(column).eq('id', chargeId).eq('fund_id', fundId).maybeSingle()
  if ((now as any)?.[column]) return { error: 'This charge is being settled by another request. Refresh to see it.' }
  const existing = await liveEntryByRef(admin, fundId, vehicleId, intercompanySettlementRef(chargeId)).catch(() => null)
  const which = existing ? `${existing.id}, dated ${existing.entryDate}` : 'see the journal'
  return {
    error: `A settlement entry on ${side} (${which}) exists for this charge but is not linked to it. If no one else is ` +
      'settling this charge right now, the settlement did not complete: void that entry in the journal, then settle again.',
  }
}

/**
 * The settlement entries the row links, each only if it is still posted. A linked id is written only
 * after persistEntry returned, so it is a finished posting; one voided since counts as not booked.
 * THROWS on a failed read, and on a linked entry that has gone back to draft.
 */
async function linkedSettlements(
  admin: SupabaseClient, fundId: string, payeeId: string | null, payerId: string | null,
): Promise<{ payee: LiveEntryRef | null; payer: LiveEntryRef | null }> {
  const ids = [payeeId, payerId].filter(Boolean) as string[]
  if (ids.length === 0) return { payee: null, payer: null }
  const { data, error } = await admin.from('journal_entries' as any)
    .select('id, status, entry_date').eq('fund_id', fundId).eq('book', ACTUAL_BOOK).in('id', ids)
  if (error) throw new Error(`Could not read the charge's settlement entries: ${error.message}`)
  const byId = new Map(((data as any[]) ?? []).map(e => [e.id as string, e]))
  const pick = (id: string | null): LiveEntryRef | null => {
    const e = id ? byId.get(id) : null
    if (!e || e.status === 'void') return null
    if (e.status !== 'posted') throw new Error(`Settlement entry ${e.id} is a ${e.status}. Post or void it, then settle again.`)
    return { id: e.id, status: e.status, entryDate: e.entry_date }
  }
  return { payee: pick(payeeId), payer: pick(payerId) }
}

/**
 * A live settlement entry booked before 20261014190000, when settlements carried the accrual's ref
 * (`intercompany:<chargeId>`) and only source_type told them apart. Scoped exactly as liveEntryByRef
 * is. THROWS on a failed read.
 */
async function liveLegacySettlement(
  admin: SupabaseClient, fundId: string, vehicleId: string, chargeId: string,
): Promise<LiveEntryRef | null> {
  const { data, error } = await admin.from('journal_entries' as any)
    .select('id, status, entry_date')
    .eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('book', ACTUAL_BOOK)
    .eq('source_ref', sourceRef(chargeId)).eq('source_type', 'intercompany_settlement').neq('status', 'void')
    .order('entry_date', { ascending: true }).limit(1)
  if (error) throw new Error(`Could not check for a settlement already in the books: ${error.message}`)
  const row = ((data as any[]) ?? [])[0]
  return row ? { id: row.id, status: row.status, entryDate: row.entry_date } : null
}

/**
 * Mark an accrued charge settled with its two settlement entries. Conditional on `accrued`, so a
 * row another request already marked is not rewritten; that is still success if it names these
 * same entries (the other request was a retry linking ours).
 */
async function markSettled(
  admin: SupabaseClient,
  fundId: string,
  chargeId: string,
  settledDate: string,
  payeeEntryId: string,
  payerEntryId: string,
  /** Pre-20261014190000 entries found by ref: never linked, so there are no links to hold. */
  legacy = false,
): Promise<{ ok: true } | { error: string }> {
  // Linked entries are only MATCHED, never written: both sides must still be linked to these
  // entries, so a side a losing attempt unwound after this request read it is neither settled over
  // nor restored. Legacy entries were never linked, so for them the links are written here.
  let q = admin.from('intercompany_transactions' as any).update({
    status: 'settled',
    settled_date: settledDate,
    ...(legacy ? { to_settlement_entry_id: payeeEntryId, from_settlement_entry_id: payerEntryId } : {}),
  }).eq('id', chargeId).eq('fund_id', fundId).eq('status', 'accrued')
  if (!legacy) q = q.eq('to_settlement_entry_id', payeeEntryId).eq('from_settlement_entry_id', payerEntryId)
  const { data: updated, error } = await q.select('id')
  const booked = `The settlement entries are on both books (${payeeEntryId}, ${payerEntryId})`
  if (error) return { error: `${booked}, but the charge could not be marked settled: ${error.message}. Settle it again to finish.` }
  if (((updated as any[]) ?? []).length > 0) return { ok: true }

  const { data: now, error: readErr } = await admin.from('intercompany_transactions' as any)
    .select('status, to_settlement_entry_id, from_settlement_entry_id')
    .eq('id', chargeId).eq('fund_id', fundId).maybeSingle()
  if (readErr) return { error: `${booked}, but the charge could not be re-read: ${readErr.message}` }
  const r = now as any
  if (r?.status === 'settled' && r.to_settlement_entry_id === payeeEntryId && r.from_settlement_entry_id === payerEntryId) {
    return { ok: true }
  }
  if (r?.status === 'accrued') {
    return {
      error: `The charge was not marked settled: its settlement links changed while it was being settled (payee ` +
        `${r.to_settlement_entry_id ?? 'none'}, payer ${r.from_settlement_entry_id ?? 'none'}). Settle it again to post what is missing.`,
    }
  }
  return { error: `${booked}, but the charge changed while it was being settled (it is now ${r?.status ?? 'gone'}). Check both entries.` }
}

async function vehicleNames(
  admin: SupabaseClient,
  fundId: string,
  ids: string[],
): Promise<Map<string, string>> {
  const { data, error } = await admin
    .from('fund_vehicles' as any).select('id, name').eq('fund_id', fundId).in('id', ids)
  if (error) throw new Error(`The vehicles could not be read: ${error.message}`)
  return new Map(((data as any[]) ?? []).map(v => [v.id as string, v.name as string]))
}

// ── Reading ───────────────────────────────────────────────────────────────────────────────────

export interface IntercompanyBalance {
  counterpartyVehicleId: string
  counterpartyName: string
  /** What this vehicle is owed by the counterparty (the 1900-<cp> balance). */
  dueFrom: number
  /** What this vehicle owes the counterparty (the 2900-<cp> balance). */
  dueTo: number
  /** dueFrom - dueTo. Shown alongside the two, never instead of them. */
  net: number
}

/**
 * Outstanding intercompany balances for one vehicle, per counterparty, FROM THE LEDGER.
 *
 * Reads the posted balance of each `1900-<cp>` / `2900-<cp>` account rather than summing the
 * register, so a manual correcting entry — the way half of all intercompany disputes are actually
 * resolved — is reflected here without anyone having to remember to also amend a row.
 *
 * `dueFrom` and `dueTo` are reported separately and only then netted. Netting first is how an
 * intercompany balance stops reconciling: the counterparty confirms a payable of X and a receivable
 * of Y, and a single net number matches neither.
 */
export async function intercompanyBalances(
  admin: SupabaseClient,
  fundId: string,
  group: string,
): Promise<IntercompanyBalance[]> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  if (!vehicleId) return []

  const { data: accts, error: acctErr } = await admin
    .from('chart_of_accounts' as any)
    .select('id, code, subtype')
    .eq('fund_id', fundId)
    .eq('vehicle_id', vehicleId)
    .in('subtype', [INTERCOMPANY_RECEIVABLE_SUBTYPE, INTERCOMPANY_PAYABLE_SUBTYPE])
  if (acctErr) throw new Error(`The intercompany accounts could not be read: ${acctErr.message}`)
  // The bare parents (1900 / 2900, no suffix) carry no counterparty, so they are not part of a
  // per-counterparty breakdown. Anything posted directly to them is a bookkeeping error the
  // statements will still show; this view is about who owes whom.
  const subAccounts = ((accts as any[]) ?? []).filter(a => (a.code as string).includes('-'))
  if (subAccounts.length === 0) return []

  // Entries and postings are loaded separately and joined here, the way every other reader in
  // lib/accounting does it — an embedded PostgREST join would be a second query shape for the same
  // data, and this one has to agree with the trial balance exactly. Both are paged past PostgREST's
  // 1000-row cap, ordered by id so no row lands on two pages or none: a vehicle with more posted
  // entries than that would otherwise report a balance built from whichever thousand came back.
  const [entries, postings] = await Promise.all([
    fetchAllRows<any>((from, to) => admin.from('journal_entries' as any)
      .select('id')
      .eq('fund_id', fundId).eq('vehicle_id', vehicleId)
      .eq('status', 'posted').eq('book', ACTUAL_BOOK)
      .order('id', { ascending: true }).range(from, to)),
    fetchAllRows<any>((from, to) => admin.from('journal_postings' as any)
      .select('journal_entry_id, account_id, amount')
      .eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('book', ACTUAL_BOOK)
      .in('account_id', subAccounts.map(a => a.id))
      .order('id', { ascending: true }).range(from, to)),
  ])
  const posted = new Set(entries.map(e => e.id as string))
  const balance = new Map<string, number>()
  for (const p of postings) {
    if (!posted.has(p.journal_entry_id)) continue
    balance.set(p.account_id, roundCents((balance.get(p.account_id) ?? 0) + Number(p.amount)))
  }

  // The 8-character id prefix in the code is what ties a sub-account back to a counterparty. Match
  // it against the fund's real vehicles so a stale account (a vehicle since merged away) still
  // reports its balance rather than vanishing with the money on it.
  const { data: vehicles, error: vehErr } = await admin
    .from('fund_vehicles' as any).select('id, name').eq('fund_id', fundId)
  if (vehErr) throw new Error(`The fund's vehicles could not be read: ${vehErr.message}`)
  const byPrefix = new Map(((vehicles as any[]) ?? []).map(v => [(v.id as string).slice(0, 8), v]))

  const out = new Map<string, IntercompanyBalance>()
  for (const a of subAccounts) {
    const prefix = (a.code as string).split('-').slice(1).join('-')
    const vehicle = byPrefix.get(prefix)
    const key = (vehicle?.id as string) ?? prefix
    const row = out.get(key) ?? {
      counterpartyVehicleId: (vehicle?.id as string) ?? '',
      counterpartyName: (vehicle?.name as string) ?? 'Unknown counterparty',
      dueFrom: 0, dueTo: 0, net: 0,
    }
    const bal = balance.get(a.id as string) ?? 0
    // Postings are signed debit-positive. A receivable's natural balance is a debit; a payable's is
    // a credit, so its sign is flipped to report it as a positive amount owed.
    if (a.subtype === INTERCOMPANY_RECEIVABLE_SUBTYPE) row.dueFrom = roundCents(row.dueFrom + bal)
    else row.dueTo = roundCents(row.dueTo - bal)
    out.set(key, row)
  }

  return Array.from(out.values())
    .map(r => ({ ...r, net: roundCents(r.dueFrom - r.dueTo) }))
    .filter(r => r.dueFrom !== 0 || r.dueTo !== 0)
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net))
}

/** The charge register for a vehicle — everything it is party to, either side. */
export async function listIntercompanyCharges(
  admin: SupabaseClient,
  fundId: string,
  vehicleId: string,
  limit = 200,
) {
  const { data } = await admin
    .from('intercompany_transactions' as any)
    .select('*')
    .eq('fund_id', fundId)
    .or(`from_vehicle_id.eq.${vehicleId},to_vehicle_id.eq.${vehicleId}`)
    .order('charge_date', { ascending: false })
    .limit(limit)
  return ((data as any[]) ?? [])
}
