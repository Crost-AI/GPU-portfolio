// Quarterly partnership-expense invoices: the management company (or whichever entity paid) bills
// a fund for the fund's expenses it paid during the quarter.
//
// THE FLOW, which is how the books are kept by hand.
//   1. When the management company pays a fund's expense it books it to the fund's receivable:
//        Dr Due from <fund> (1900-<fund>)   Cr Cash (or the card)
//      from the bank feed, a typed entry, or a draft made from the receipt (receipts.ts). The
//      receipt is attached to that entry. Nothing else marks it: the account IS the tag.
//   2. `previewPartnershipInvoice` lists every POSTED debit to that account dated on or before the
//      quarter's end that no live invoice has billed yet (receipts-core.ts, billablePostings). That
//      includes earlier ones nobody billed (paid the week before the quarter opened, or missed
//      last quarter), flagged `beforePeriod`, so nothing falls between two invoices. Drafts are
//      listed separately as a warning, never billed: a draft is not yet a cost.
//   3. `createPartnershipInvoice` freezes those postings (less any the person left off) and the
//      total into a DRAFT invoice (partnership_invoice_lines), so the same expense cannot land on
//      two invoices. A line left off stays open for the next one.
//   4. `issuePartnershipInvoice` books the FUND's side only, as an intercompany expense
//      reimbursement whose receivable is already on the manco's books:
//        the fund   Dr Partnership expenses   Cr Due to <manco>
//      When the fund pays, the charge's settlement (the manco's Intercompany tab) posts the cash on
//      both sides and clears the receivable: manco Dr Cash / Cr Due from <fund>.
//   ADJUSTMENTS (partnership_invoice_adjustments) are lines typed onto a draft that change what the
//   fund is asked to pay without billing an expense: a credit for an earlier invoice that asked for
//   more than the books said (and was paid), or a charge for one that asked for too little. They
//   are never booked. The books already hold the expenses at what they cost, and the difference in
//   cash sits in the intercompany accounts; so issuing still books the expenses (`amount`), and
//   settling the charge moves the amount due (`amount + adjustment_total`), which clears both.
//   5. `deletePartnershipInvoice` removes a DRAFT and releases its lines; it was never sent.
//      `voidPartnershipInvoice` is for an ISSUED one: it keeps the number and releases the lines,
//      and the fund's entry has to be voided first (a void here never unposts the other side's books).
//
// The invoice row is the document; the ledger is the fact. Once issued, the amount on the row never
// moves, the same way a capital call notice keeps the number the partner was told. A draft, never
// sent, can still gain and lose lines (editPartnershipInvoice), and its amount follows.

import type { SupabaseClient } from '@supabase/supabase-js'
import { roundCents } from './ledger'
import { liveEntryByRef } from './persist'
import { vehicleNameById } from './vehicle-id'
import { ACTUAL_BOOK } from './books'
import { INTERCOMPANY_RECEIVABLE_SUBTYPE } from './chart'
import { intercompanyChargeRef, postIntercompanyCharge, unwindIntercompanyEntry, intercompanyChart, pickIntercompanyAccounts, type IntercompanyChartRow } from './intercompany'
import { amountDue, billablePostings, invoiceNumber, isoDateOrNull, parseAdjustments, quarterBounds, type InvoiceAdjustmentInput, type Quarter } from './receipts-core'
import { allocationRules, saveAllocationRule, startingAllocationBasis, type AllocationSource } from './allocation-basis'
import { ensureVendor } from './vendors'

export interface InvoiceLine {
  entryId: string
  postingId: string
  entryDate: string
  memo: string | null
  reference: string | null
  vendorName: string | null
  amount: number
  receiptCount: number
  status: string
  /** Dated before the invoice's quarter: an earlier expense nobody billed, carried onto this one. */
  beforePeriod?: boolean
  /** Why the fund bears it, printed on the invoice (allocation-basis.ts says where it comes from). */
  allocationBasis: string | null
  /** Where a preview line's basis came from; null when none was found. Frozen lines omit it. */
  allocationSource?: AllocationSource | null
}

/** A credit (negative) or charge (positive) typed onto an invoice; not an expense, never booked. */
export interface InvoiceAdjustment { id: string; description: string; amount: number }

/** A line of an existing invoice, with what its posting says NOW (null when the posting is gone). */
export interface InvoiceDetailLine extends InvoiceLine {
  currentAmount: number | null
}

export interface InvoicePreview {
  quarter: Quarter
  /** The dates the expenses were read from: `from` null means every earlier unbilled one. */
  range: { from: string | null; through: string }
  from: { vehicleId: string; name: string }
  to: { vehicleId: string; name: string }
  lines: InvoiceLine[]
  total: number
  /** Debits to the Due-from account still in draft: not billed until posted. */
  drafts: InvoiceLine[]
  /** False when the biller's chart has no "Due from <fund>" account yet, so nothing can be billed. */
  hasReceivableAccount: boolean
  /** The account the quarter is read from: the one linked to the fund, or `1900-<fund>`. */
  receivableAccount: { id: string; code: string; name: string } | null
  /** An invoice already covering this quarter, if one exists. */
  existing: { id: string; invoiceNumber: string; status: string; amount: number } | null
}

async function vehiclePair(admin: SupabaseClient, fundId: string, fromId: string, toId: string) {
  const [fromName, toName] = await Promise.all([vehicleNameById(admin, fundId, fromId), vehicleNameById(admin, fundId, toId)])
  if (!fromName || !toName) return null
  return { from: { vehicleId: fromId, name: fromName }, to: { vehicleId: toId, name: toName } }
}

/** The biller's "Due from <fund>" account, if its chart has one (linked, or by the code convention). */
export async function receivableAccount(
  admin: SupabaseClient, fundId: string, fromVehicleId: string, toVehicleId: string,
): Promise<{ id: string; code: string; name: string } | null> {
  const hit = pickIntercompanyAccounts(await intercompanyChart(admin, fundId, fromVehicleId), toVehicleId).receivable
  return hit ? { id: hit.id, code: hit.code, name: hit.name } : null
}

/**
 * The biller's accounts that could be a fund's "Due from": its receivables, minus the bare 1900
 * parent. Each says which entity it is linked to, if any, so a picker can offer the free ones.
 */
export function receivableCandidates(chart: IntercompanyChartRow[]) {
  return chart
    .filter(a => a.type === 'asset' && a.code !== '1900' && (a.counterparty_vehicle_id || a.subtype === INTERCOMPANY_RECEIVABLE_SUBTYPE || a.subtype === 'receivable'))
    .map(a => ({ id: a.id, code: a.code, name: a.name, counterpartyVehicleId: a.counterparty_vehicle_id }))
    .sort((a, b) => a.code.localeCompare(b.code))
}

interface EntryRow {
  id: string; entry_date: string; memo: string | null; reference: string | null; status: string
  vendor_id: string | null; source_type: string | null
  journal_postings: { id: string; amount: number; account_id: string }[]
}

/** Entries on the biller's books with a posting to any of these accounts (only those postings). */
async function entriesTouching(
  admin: SupabaseClient, fundId: string, fromVehicleId: string, accountIds: string[],
  opts: { window?: { start: string | null; end: string } | null; statuses: string[] },
): Promise<EntryRow[]> {
  if (accountIds.length === 0) return []
  let q = admin.from('journal_entries' as any)
    .select('id, entry_date, memo, reference, status, vendor_id, source_type, journal_postings!inner(id, amount, account_id)')
    .eq('fund_id', fundId).eq('vehicle_id', fromVehicleId).eq('book', ACTUAL_BOOK)
    .in('status', opts.statuses)
    .in('journal_postings.account_id', accountIds)
  if (opts.window?.start) q = q.gte('entry_date', opts.window.start)
  if (opts.window) q = q.lte('entry_date', opts.window.end)
  const { data, error } = await q.order('entry_date', { ascending: true }).limit(5000)
  if (error) throw new Error(`The Due-from entries could not be read: ${error.message}`)
  return ((data as any[]) ?? []).map(e => ({ ...e, journal_postings: ((e.journal_postings as any[]) ?? []).map(p => ({ ...p, amount: Number(p.amount) })) }))
}

/** Of these postings, the ones a live invoice already bills. */
async function billedPostingIds(admin: SupabaseClient, fundId: string, postingIds: string[]): Promise<Set<string>> {
  const out = new Set<string>()
  for (let i = 0; i < postingIds.length; i += 150) {
    const { data } = await admin.from('partnership_invoice_lines' as any).select('journal_posting_id')
      .eq('fund_id', fundId).eq('active', true).in('journal_posting_id', postingIds.slice(i, i + 150))
    for (const r of ((data as any[]) ?? [])) out.add(r.journal_posting_id as string)
  }
  return out
}

/** Vendor names and receipt counts for a set of entries: what a line shows beside its amount. */
async function lineDetails(admin: SupabaseClient, fundId: string, entries: EntryRow[]) {
  const ids = entries.map(e => e.id)
  const vendorIds = Array.from(new Set(entries.map(e => e.vendor_id).filter(Boolean))) as string[]
  const [{ data: vendors }, { data: receipts }] = await Promise.all([
    vendorIds.length ? admin.from('vendors' as any).select('id, name').eq('fund_id', fundId).in('id', vendorIds) : Promise.resolve({ data: [] }),
    ids.length ? admin.from('receipts' as any).select('journal_entry_id, vendor_name, allocation_basis').eq('fund_id', fundId).neq('status', 'dismissed').in('journal_entry_id', ids) : Promise.resolve({ data: [] }),
  ])
  const vendorName = new Map(((vendors as any[]) ?? []).map(v => [v.id as string, v.name as string]))
  const receiptCount = new Map<string, number>()
  // The first receipt that names a vendor, or carries a basis, speaks for its entry.
  const receiptVendor = new Map<string, string>()
  const receiptBasis = new Map<string, string>()
  for (const r of ((receipts as any[]) ?? [])) {
    receiptCount.set(r.journal_entry_id, (receiptCount.get(r.journal_entry_id) ?? 0) + 1)
    if (r.vendor_name && !receiptVendor.has(r.journal_entry_id)) receiptVendor.set(r.journal_entry_id, r.vendor_name)
    if (r.allocation_basis?.trim() && !receiptBasis.has(r.journal_entry_id)) receiptBasis.set(r.journal_entry_id, r.allocation_basis.trim())
  }
  return (e: EntryRow, postingId: string, amount: number): InvoiceLine => ({
    entryId: e.id, postingId,
    entryDate: e.entry_date,
    memo: e.memo ?? null,
    reference: e.reference ?? null,
    vendorName: (e.vendor_id ? vendorName.get(e.vendor_id) : null) ?? receiptVendor.get(e.id) ?? null,
    amount,
    receiptCount: receiptCount.get(e.id) ?? 0,
    status: e.status,
    allocationBasis: receiptBasis.get(e.id) ?? null,
  })
}

/** The unbilled Due-from debits in the window, posted and draft. */
async function openLines(
  admin: SupabaseClient, fundId: string, fromVehicleId: string, receivableId: string, window: { start: string | null; end: string } | null,
): Promise<InvoiceLine[]> {
  const entries = await entriesTouching(admin, fundId, fromVehicleId, [receivableId], { window, statuses: ['draft', 'posted'] })
  const billed = await billedPostingIds(admin, fundId, entries.flatMap(e => e.journal_postings.map(p => p.id)))
  const picked = billablePostings(
    entries.map(e => ({ id: e.id, sourceType: e.source_type, postings: e.journal_postings.map(p => ({ id: p.id, accountId: p.account_id, amount: p.amount })) })),
    receivableId, billed,
  )
  const byId = new Map(entries.map(e => [e.id, e]))
  const line = await lineDetails(admin, fundId, entries)
  return picked.map(p => line(byId.get(p.entryId)!, p.postingId, p.amount))
}

async function existingInvoice(admin: SupabaseClient, fundId: string, fromId: string, toId: string, q: Quarter) {
  const { data } = await admin.from('partnership_invoices' as any)
    .select('id, invoice_number, status, amount')
    .eq('fund_id', fundId).eq('from_vehicle_id', fromId).eq('to_vehicle_id', toId)
    .eq('period_start', q.start).eq('period_end', q.end).neq('status', 'void').maybeSingle()
  return data ? { id: (data as any).id, invoiceNumber: (data as any).invoice_number, status: (data as any).status, amount: Number((data as any).amount) } : null
}

/** The dates an invoice reads expenses from: `from` (null for no start) through `through`. */
export function expenseRange(q: Quarter, from?: string | null, through?: string | null): { from: string | null; through: string } | { error: string } {
  const f = from ? isoDateOrNull(from) : null
  const t = through ? isoDateOrNull(through) : q.end
  if (from && !f) return { error: 'from must be a date (YYYY-MM-DD).' }
  if (!t) return { error: 'through must be a date (YYYY-MM-DD).' }
  if (f && f > t) return { error: 'The start date is after the end date.' }
  return { from: f, through: t }
}

/**
 * What an invoice for this quarter would bill, without writing anything: every unbilled debit dated
 * in the range, which by default is everything up to the quarter's end. `from` / `through` narrow
 * or move it (the person chooses which expenses this invoice picks up; the quarter still names and
 * numbers the invoice). Lines from before the quarter are flagged `beforePeriod`.
 */
export async function previewPartnershipInvoice(
  admin: SupabaseClient,
  fundId: string,
  args: { fromVehicleId: string; toVehicleId: string; year: number; quarter: number; from?: string | null; through?: string | null },
): Promise<InvoicePreview | { error: string }> {
  let q: Quarter
  try { q = quarterBounds(args.year, args.quarter) } catch (e) { return { error: (e as Error).message } }
  const range = expenseRange(q, args.from, args.through)
  if ('error' in range) return range
  const pair = await vehiclePair(admin, fundId, args.fromVehicleId, args.toVehicleId)
  if (!pair) return { error: 'Both entities must be in this fund.' }
  if (args.fromVehicleId === args.toVehicleId) return { error: 'An entity cannot bill itself.' }
  const receivable = await receivableAccount(admin, fundId, args.fromVehicleId, args.toVehicleId)
  const [open, rules] = await Promise.all([
    receivable ? openLines(admin, fundId, args.fromVehicleId, receivable.id, { start: range.from, end: range.through }) : Promise.resolve([]),
    allocationRules(admin, fundId, args.fromVehicleId, args.toVehicleId),
  ])
  const all = open.map(l => ({
    ...l, beforePeriod: l.entryDate < q.start,
    ...startingAllocationBasis(l.allocationBasis, l.vendorName, rules),
  }))
  const lines = all.filter(l => l.status === 'posted')
  return {
    quarter: q, range, ...pair, lines, hasReceivableAccount: !!receivable, receivableAccount: receivable,
    total: roundCents(lines.reduce((s, l) => s + l.amount, 0)),
    drafts: all.filter(l => l.status === 'draft'),
    existing: await existingInvoice(admin, fundId, args.fromVehicleId, args.toVehicleId, q),
  }
}

/**
 * Every entity with posted, unbilled debits on its "Due from" account on `fromVehicleId`'s books,
 * across all dates (a quarter nobody invoiced still shows up here).
 */
export async function unbilledByCounterparty(
  admin: SupabaseClient, fundId: string, fromVehicleId: string,
): Promise<{ vehicleId: string; name: string; entries: number; amount: number }[]> {
  const [{ data: vehicles }, chart] = await Promise.all([
    admin.from('fund_vehicles' as any).select('id, name').eq('fund_id', fundId),
    intercompanyChart(admin, fundId, fromVehicleId),
  ])
  const pairs = ((vehicles as any[]) ?? [])
    .filter(v => v.id !== fromVehicleId)
    .map(v => ({ vehicleId: v.id as string, name: v.name as string, accountId: pickIntercompanyAccounts(chart, v.id).receivable?.id }))
    .filter((p): p is { vehicleId: string; name: string; accountId: string } => !!p.accountId)
  if (pairs.length === 0) return []

  const entries = await entriesTouching(admin, fundId, fromVehicleId, pairs.map(p => p.accountId), { statuses: ['posted'] })
  const billed = await billedPostingIds(admin, fundId, entries.flatMap(e => e.journal_postings.map(p => p.id)))
  const asReceivable = entries.map(e => ({ id: e.id, sourceType: e.source_type, postings: e.journal_postings.map(p => ({ id: p.id, accountId: p.account_id, amount: p.amount })) }))
  return pairs
    .map(p => {
      const lines = billablePostings(asReceivable, p.accountId, billed)
      return { vehicleId: p.vehicleId, name: p.name, entries: lines.length, amount: roundCents(lines.reduce((s, l) => s + l.amount, 0)) }
    })
    .filter(p => p.entries > 0)
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Freeze the quarter's lines into a DRAFT invoice. Refuses an empty quarter, and a quarter that
 * already has a live invoice (the unique index says the same; this says it in words).
 */
export async function createPartnershipInvoice(
  admin: SupabaseClient,
  fundId: string,
  userId: string | null,
  args: {
    fromVehicleId: string; toVehicleId: string; year: number; quarter: number; invoiceDate?: string | null; memo?: string | null
    /** The dates to read expenses from, as in the preview. */
    from?: string | null; through?: string | null
    /** Postings to leave off this invoice; they stay open for the next one. */
    excludePostingIds?: string[] | null
    /** An allocation basis typed for a line, by posting id: it replaces the one the line started with. */
    allocations?: Record<string, string> | null
    /** Lines whose basis is saved for that vendor's future expenses billed to this fund. */
    rememberPostingIds?: string[] | null
    /** Credits (negative) and charges (positive) to print below the expenses; they change the amount due. */
    adjustments?: InvoiceAdjustmentInput[] | null
  },
): Promise<{ id: string; invoiceNumber: string; amount: number; adjustmentTotal: number; amountDue: number; lines: number; basesNotSaved?: string[] } | { error: string; status?: number }> {
  const parsed = parseAdjustments(args.adjustments ?? null)
  if ('error' in parsed) return { error: parsed.error, status: 400 }
  const found = await previewPartnershipInvoice(admin, fundId, args)
  if ('error' in found) return { error: found.error, status: 400 }
  const excluded = new Set(args.excludePostingIds ?? [])
  const typed = args.allocations ?? {}
  const kept = found.lines
    .filter(l => !excluded.has(l.postingId))
    .map(l => (l.postingId in typed ? { ...l, allocationBasis: String(typed[l.postingId] ?? '').trim() || null } : l))
  const preview = { ...found, lines: kept, total: roundCents(kept.reduce((sum, l) => sum + l.amount, 0)) }
  if (preview.existing) {
    return { error: `${preview.quarter.label} is already billed to ${preview.to.name} on invoice ${preview.existing.invoiceNumber} (${preview.existing.status}). ${preview.existing.status === 'draft' ? 'Delete that draft' : 'Void it'} to bill the quarter again.`, status: 409 }
  }
  if (preview.lines.length === 0) {
    return { error: found.lines.length > 0
      ? 'Nothing to bill: every expense was left off this invoice.'
      : `Nothing to bill: no posted debits to Due from ${preview.to.name} ${preview.range.from ? `from ${preview.range.from} ` : ''}through ${preview.range.through} that are not already on an invoice.`, status: 400 }
  }
  const adjustmentTotal = roundCents(parsed.adjustments.reduce((sum, a) => sum + a.amount, 0))
  const due = amountDue(preview.total, adjustmentTotal)
  if (due < 0) return { error: overCredited(preview.total, adjustmentTotal), status: 400 }

  const { data: settings } = await admin.from('fund_settings' as any).select('currency').eq('fund_id', fundId).maybeSingle()
  const invoiceDate = args.invoiceDate && /^\d{4}-\d{2}-\d{2}$/.test(args.invoiceDate) ? args.invoiceDate : new Date().toISOString().slice(0, 10)

  // A voided invoice for the same quarter keeps its number; the reissue gets the next suffix.
  let row: any = null
  let lastError = ''
  for (let attempt = 0; attempt < 10 && !row; attempt++) {
    const { data, error } = await admin.from('partnership_invoices' as any).insert({
      fund_id: fundId,
      from_vehicle_id: args.fromVehicleId,
      to_vehicle_id: args.toVehicleId,
      period_start: preview.quarter.start,
      period_end: preview.quarter.end,
      invoice_number: invoiceNumber(preview.quarter, args.toVehicleId, attempt),
      invoice_date: invoiceDate,
      amount: preview.total,
      adjustment_total: adjustmentTotal,
      currency: (settings as any)?.currency || 'USD',
      memo: args.memo?.trim() || null,
      status: 'draft',
      created_by: userId,
    }).select('id, invoice_number').single()
    if (data) { row = data; break }
    lastError = error?.message ?? 'unknown error'
    // 23505 on the number index: try the next suffix. On the period index: someone else just made it.
    if ((error as any)?.code !== '23505' || /period/.test(lastError)) break
  }
  if (!row) return { error: `The invoice could not be created: ${lastError}`, status: 409 }

  // Claim the lines. The partial unique index on journal_posting_id (where active) makes the claim
  // exclusive: a posting another invoice claimed a moment ago fails the whole insert.
  const { error: claimErr } = await admin.from('partnership_invoice_lines' as any).insert(preview.lines.map(l => ({
    fund_id: fundId, invoice_id: row.id, journal_entry_id: l.entryId, journal_posting_id: l.postingId, amount: l.amount,
    allocation_basis: l.allocationBasis,
  })))
  if (claimErr) {
    await admin.from('partnership_invoices' as any).delete().eq('id', row.id).eq('fund_id', fundId)
    return { error: (claimErr as any).code === '23505'
      ? 'Some of these expenses were billed on another invoice at the same moment. Refresh and try again.'
      : `The invoice lines could not be saved: ${claimErr.message}`, status: 409 }
  }
  if (parsed.adjustments.length > 0) {
    const { error: adjErr } = await admin.from('partnership_invoice_adjustments' as any).insert(parsed.adjustments.map(a => ({
      fund_id: fundId, invoice_id: row.id, description: a.description, amount: a.amount, created_by: userId,
    })))
    if (adjErr) {
      await admin.from('partnership_invoices' as any).delete().eq('id', row.id).eq('fund_id', fundId)
      return { error: `The adjustments could not be saved: ${adjErr.message}`, status: 400 }
    }
  }

  // Saved last: a rule is a convenience for next quarter, and failing to save one must not undo
  // an invoice that was made.
  const remember = new Set(args.rememberPostingIds ?? [])
  const notSaved: string[] = []
  for (const l of preview.lines.filter(x => remember.has(x.postingId) && x.allocationBasis)) {
    const saved = await saveAllocationRule(admin, fundId, userId, { fromVehicleId: args.fromVehicleId, toVehicleId: args.toVehicleId, vendorName: l.vendorName, allocationBasis: l.allocationBasis })
    if ('error' in saved) notSaved.push(l.vendorName ?? l.memo ?? l.entryDate)
  }
  return { id: row.id, invoiceNumber: row.invoice_number, amount: preview.total, adjustmentTotal, amountDue: due, lines: preview.lines.length, ...(notSaved.length ? { basesNotSaved: notSaved } : {}) }
}

export interface InvoiceDetail {
  id: string
  invoiceNumber: string
  invoiceDate: string
  periodStart: string
  periodEnd: string
  label: string
  /** The expenses billed: what issuing books on the fund's side. */
  amount: number
  adjustments: InvoiceAdjustment[]
  adjustmentTotal: number
  /** What the fund is asked to pay, and what settling the charge moves: amount + adjustmentTotal. */
  amountDue: number
  currency: string
  memo: string | null
  status: 'draft' | 'issued' | 'void'
  issuedAt: string | null
  intercompanyTransactionId: string | null
  from: { vehicleId: string; name: string }
  to: { vehicleId: string; name: string }
  lines: InvoiceDetailLine[]
}

/**
 * The expenses a DRAFT invoice could still pick up: every posted, unbilled debit to the biller's
 * "Due from <fund>" account, whatever its date, each with the basis it would start with (the
 * receipt's, else the one saved for its vendor). An issued or void invoice can add nothing.
 */
export async function addableInvoiceLines(admin: SupabaseClient, fundId: string, inv: Pick<InvoiceDetail, 'status' | 'from' | 'to'>): Promise<InvoiceLine[]> {
  if (inv.status !== 'draft') return []
  const receivable = await receivableAccount(admin, fundId, inv.from.vehicleId, inv.to.vehicleId)
  if (!receivable) return []
  const [open, rules] = await Promise.all([
    openLines(admin, fundId, inv.from.vehicleId, receivable.id, null),
    allocationRules(admin, fundId, inv.from.vehicleId, inv.to.vehicleId),
  ])
  return open
    .filter(l => l.status === 'posted')
    .map(l => ({ ...l, ...startingAllocationBasis(l.allocationBasis, l.vendorName, rules) }))
    .sort((a, b) => a.entryDate.localeCompare(b.entryDate))
}

/**
 * Edit an invoice already created.
 *
 * On any invoice that is not void, `allocations` changes the allocation basis, a note printed beside
 * each line that is part of no amount or booking. The invoice keeps its number and entries, and the
 * PDF reads the new text. Lines not named keep theirs; an empty string clears one. `rememberPostingIds`
 * also saves a line's basis for that vendor's future expenses billed to the same fund.
 *
 * `descriptions` changes a line's vendor and description, which are its journal entry's: the
 * change is made on the entry (memo, and vendor_id via the vendors list), so the books and the
 * invoice say the same thing. Neither moves an amount, but a closed period refuses it like any
 * other change to an entry dated in it.
 *
 * On a DRAFT, the expenses can change too. `addPostingIds` puts unbilled expenses on it (from
 * addableInvoiceLines), and `removePostingIds` takes lines off and returns them to unbilled. The
 * draft's amount follows. An issued invoice's amount is booked on the fund's books, so its expenses
 * cannot change; void it and bill again.
 *
 * Also on a DRAFT only, `addAdjustments` types credits (negative) and charges (positive) below the
 * expenses and `removeAdjustmentIds` takes them off. They change the amount due, never the amount
 * booked, and the amount due cannot go below zero.
 */
export async function editPartnershipInvoice(
  admin: SupabaseClient,
  fundId: string,
  userId: string | null,
  id: string,
  args: {
    allocations?: Record<string, string> | null
    rememberPostingIds?: string[] | null
    addPostingIds?: string[] | null
    removePostingIds?: string[] | null
    descriptions?: Record<string, { vendor?: string | null; description?: string | null }> | null
    addAdjustments?: InvoiceAdjustmentInput[] | null
    removeAdjustmentIds?: string[] | null
  },
): Promise<{ ok: true; updated: number; added: number; removed: number; described: number; adjusted: number; amount: number; adjustmentTotal: number; amountDue: number; basesNotSaved?: string[] } | { error: string; status?: number }> {
  const inv = await getPartnershipInvoice(admin, fundId, id)
  if (!inv) return { error: 'Invoice not found', status: 404 }
  if (inv.status === 'void') return { error: 'This invoice is void. Bill the expenses on a new invoice instead.', status: 409 }
  const onInvoice = new Map<string, InvoiceLine>(inv.lines.map(l => [l.postingId, l]))
  const typed = args.allocations ?? {}

  const remove = Array.from(new Set(args.removePostingIds ?? [])).filter(p => onInvoice.has(p))
  const addIds = Array.from(new Set(args.addPostingIds ?? [])).filter(p => !onInvoice.has(p))
  const parsedAdj = parseAdjustments(args.addAdjustments ?? null)
  if ('error' in parsedAdj) return { error: parsedAdj.error, status: 400 }
  const dropAdj = Array.from(new Set(args.removeAdjustmentIds ?? [])).filter(a => inv.adjustments.some(x => x.id === a))
  const adjusting = parsedAdj.adjustments.length > 0 || dropAdj.length > 0
  if (adjusting && inv.status !== 'draft') return { error: 'This invoice is issued, so the fund has been told its amount due. Void it and bill again to change its adjustments, or put the adjustment on the next invoice.', status: 409 }
  const adjustmentTotal = roundCents(
    inv.adjustments.filter(a => !dropAdj.includes(a.id)).reduce((sum, a) => sum + a.amount, 0)
    + parsedAdj.adjustments.reduce((sum, a) => sum + a.amount, 0),
  )
  let amount = inv.amount
  if (remove.length > 0 || addIds.length > 0) {
    if (inv.status !== 'draft') return { error: 'This invoice is issued, so its amount is booked on the fund’s books. Void it and bill again to change its expenses.', status: 409 }
    const addable = new Map((await addableInvoiceLines(admin, fundId, inv)).map(l => [l.postingId, l]))
    const missing = addIds.filter(p => !addable.has(p))
    if (missing.length > 0) return { error: `${missing.length === 1 ? 'One expense is' : `${missing.length} expenses are`} no longer open to bill (already invoiced, unposted or voided). Refresh and try again.`, status: 409 }
    if (onInvoice.size - remove.length + addIds.length === 0) return { error: 'That removes every expense. Delete the draft instead.', status: 400 }
    const next = roundCents(Array.from(onInvoice.values()).filter(l => !remove.includes(l.postingId)).reduce((sum, l) => sum + l.amount, 0)
      + addIds.reduce((sum, p) => sum + addable.get(p)!.amount, 0))
    if (amountDue(next, adjustmentTotal) < 0) return { error: overCredited(next, adjustmentTotal), status: 400 }

    // Add first: a claim another invoice beat us to fails here, before anything is taken off.
    if (addIds.length > 0) {
      const lines = addIds.map(p => {
        const l = addable.get(p)!
        return p in typed ? { ...l, allocationBasis: String(typed[p] ?? '').trim() || null } : l
      })
      const { error } = await admin.from('partnership_invoice_lines' as any).insert(lines.map(l => ({
        fund_id: fundId, invoice_id: id, journal_entry_id: l.entryId, journal_posting_id: l.postingId, amount: l.amount,
        allocation_basis: l.allocationBasis,
      })))
      if (error) return { error: (error as any).code === '23505'
        ? 'Some of these expenses were just billed on another invoice. Refresh and try again.'
        : `The expenses could not be added: ${error.message}`, status: 409 }
      for (const l of lines) onInvoice.set(l.postingId, l)
    }
    if (remove.length > 0) {
      const { error } = await admin.from('partnership_invoice_lines' as any).delete()
        .eq('fund_id', fundId).eq('invoice_id', id).in('journal_posting_id', remove)
      if (error) return { error: `The expenses could not be removed: ${error.message}`, status: 400 }
      for (const p of remove) onInvoice.delete(p)
    }
    amount = roundCents(Array.from(onInvoice.values()).reduce((sum, l) => sum + l.amount, 0))
  } else if (amountDue(amount, adjustmentTotal) < 0) {
    return { error: overCredited(amount, adjustmentTotal), status: 400 }
  }
  if (adjusting) {
    if (parsedAdj.adjustments.length > 0) {
      const { error } = await admin.from('partnership_invoice_adjustments' as any).insert(parsedAdj.adjustments.map(a => ({
        fund_id: fundId, invoice_id: id, description: a.description, amount: a.amount, created_by: userId,
      })))
      if (error) return { error: `The adjustments could not be saved: ${error.message}`, status: 400 }
    }
    if (dropAdj.length > 0) {
      const { error } = await admin.from('partnership_invoice_adjustments' as any).delete().eq('fund_id', fundId).eq('invoice_id', id).in('id', dropAdj)
      if (error) return { error: `The adjustments could not be removed: ${error.message}`, status: 400 }
    }
  }
  // The amount and the adjustments are written together: the amount due must never read below zero.
  if (amount !== inv.amount || adjustmentTotal !== inv.adjustmentTotal) {
    const { error: amtErr } = await admin.from('partnership_invoices' as any).update({ amount, adjustment_total: adjustmentTotal, updated_at: new Date().toISOString() })
      .eq('id', id).eq('fund_id', fundId).eq('status', 'draft')
    if (amtErr) return { error: `The invoice total could not be updated: ${amtErr.message}`, status: 400 }
  }

  const added = new Set(addIds)
  const changes = Object.entries(typed)
    .filter(([postingId]) => onInvoice.has(postingId) && !added.has(postingId))
    .map(([postingId, basis]) => ({ postingId, basis: String(basis ?? '').trim() || null }))
    .filter(c => c.basis !== onInvoice.get(c.postingId)!.allocationBasis)
  for (const c of changes) {
    const { error } = await admin.from('partnership_invoice_lines' as any).update({ allocation_basis: c.basis })
      .eq('fund_id', fundId).eq('invoice_id', id).eq('journal_posting_id', c.postingId)
    if (error) return { error: `The allocation basis could not be saved: ${error.message}`, status: 400 }
    onInvoice.set(c.postingId, { ...onInvoice.get(c.postingId)!, allocationBasis: c.basis })
  }
  // Vendor and description live on the entry, so a rule saved below keys on the vendor as corrected.
  let described = 0
  for (const [postingId, d] of Object.entries(args.descriptions ?? {})) {
    const l = onInvoice.get(postingId)
    if (!l || !d || typeof d !== 'object') continue
    const patch: Record<string, unknown> = {}
    if (typeof d.description === 'string' && (d.description.trim() || null) !== l.memo) patch.memo = d.description.trim() || null
    let vendorName = l.vendorName
    if (typeof d.vendor === 'string' && (d.vendor.trim() || null) !== l.vendorName) {
      const v = d.vendor.trim() ? await ensureVendor(admin, fundId, d.vendor) : null
      if (d.vendor.trim() && !v) return { error: `The vendor “${d.vendor.trim()}” could not be saved.`, status: 400 }
      patch.vendor_id = v?.id ?? null
      vendorName = v?.name ?? null
    }
    if (Object.keys(patch).length === 0) continue
    const { error } = await admin.from('journal_entries' as any).update(patch)
      .eq('id', l.entryId).eq('fund_id', fundId).eq('book', ACTUAL_BOOK).eq('vehicle_id', inv.from.vehicleId)
    if (error) return { error: `The expense dated ${l.entryDate} could not be updated: ${error.message}`, status: 400 }
    onInvoice.set(postingId, { ...l, memo: 'memo' in patch ? (patch.memo as string | null) : l.memo, vendorName })
    described++
  }

  const notSaved: string[] = []
  for (const postingId of args.rememberPostingIds ?? []) {
    const l = onInvoice.get(postingId)
    if (!l?.allocationBasis) continue
    const saved = await saveAllocationRule(admin, fundId, userId, { fromVehicleId: inv.from.vehicleId, toVehicleId: inv.to.vehicleId, vendorName: l.vendorName, allocationBasis: l.allocationBasis })
    if ('error' in saved) notSaved.push(l.vendorName ?? l.memo ?? l.entryDate)
  }
  if (changes.length > 0) await admin.from('partnership_invoices' as any).update({ updated_at: new Date().toISOString() }).eq('id', id).eq('fund_id', fundId)
  return { ok: true, updated: changes.length, added: addIds.length, removed: remove.length, described, adjusted: parsedAdj.adjustments.length + dropAdj.length, amount, adjustmentTotal, amountDue: amountDue(amount, adjustmentTotal), ...(notSaved.length ? { basesNotSaved: notSaved } : {}) }
}

/**
 * Delete a draft invoice and release its expenses for the next one. A draft was never sent and
 * booked nothing, so it leaves no trace; an issued invoice is voided instead, which keeps its number.
 */
export async function deletePartnershipInvoice(
  admin: SupabaseClient,
  fundId: string,
  id: string,
): Promise<{ ok: true } | { error: string; status?: number }> {
  const { data } = await admin.from('partnership_invoices' as any).select('id, status').eq('fund_id', fundId).eq('id', id).maybeSingle()
  if (!data) return { error: 'Invoice not found', status: 404 }
  if ((data as any).status !== 'draft') return { error: `This invoice is ${(data as any).status}. Only a draft can be deleted; void an issued one.`, status: 409 }
  // A draft can carry a charge: an issue that failed partway, or one still running (intercompany_once).
  // Deleting the invoice would orphan it (partnership_invoice_id is on delete set null), which is what
  // voiding exists to avoid: void unwinds the charge with the invoice (releaseDraftCharge).
  const { data: charge, error: chargeErr } = await admin.from('intercompany_transactions' as any)
    .select('id').eq('fund_id', fundId).eq('partnership_invoice_id', id).neq('status', 'void').maybeSingle()
  if (chargeErr) return { error: `Could not check this invoice's charge: ${chargeErr.message}`, status: 500 }
  if (charge) return { error: 'This draft already has an intercompany charge (an issue failed partway or is still running). Void it instead: that unwinds the charge with it.', status: 409 }
  // Its lines go with it (on delete cascade), which frees their postings.
  const { error } = await admin.from('partnership_invoices' as any).delete().eq('id', id).eq('fund_id', fundId).eq('status', 'draft')
  return error ? { error: `The invoice could not be deleted: ${error.message}`, status: 400 } : { ok: true }
}

/** The refusal when credits would leave the fund owed money by the invoice that bills it. */
function overCredited(expenses: number, adjustmentTotal: number): string {
  return `The adjustments (${roundCents(adjustmentTotal).toFixed(2)}) are more than the expenses billed (${roundCents(expenses).toFixed(2)}), so the amount due would be negative. Credit no more than this invoice bills and carry the rest to the next one.`
}

async function invoiceAdjustments(admin: SupabaseClient, fundId: string, invoiceId: string): Promise<InvoiceAdjustment[]> {
  const { data } = await admin.from('partnership_invoice_adjustments' as any)
    .select('id, description, amount').eq('fund_id', fundId).eq('invoice_id', invoiceId).order('created_at', { ascending: true })
  return ((data as any[]) ?? []).map(a => ({ id: a.id as string, description: a.description as string, amount: roundCents(Number(a.amount)) }))
}

/** An invoice's frozen lines, beside what the ledger says about each now. */
async function invoiceLines(admin: SupabaseClient, fundId: string, invoiceId: string): Promise<InvoiceDetailLine[]> {
  const { data, error } = await admin.from('partnership_invoice_lines' as any)
    .select('journal_entry_id, journal_posting_id, amount, allocation_basis').eq('fund_id', fundId).eq('invoice_id', invoiceId)
  if (error) throw new Error(`The invoice lines could not be read: ${error.message}`)
  const rows = ((data as any[]) ?? [])
  if (rows.length === 0) return []
  const entryIds = Array.from(new Set(rows.map(r => r.journal_entry_id as string)))
  const [{ data: entries, error: entriesErr }, { data: postings, error: postingsErr }] = await Promise.all([
    admin.from('journal_entries' as any).select('id, entry_date, memo, reference, status, vendor_id, source_type')
      .eq('fund_id', fundId).eq('book', ACTUAL_BOOK).in('id', entryIds),
    admin.from('journal_postings' as any).select('id, amount')
      .eq('book', ACTUAL_BOOK).in('id', rows.map(r => r.journal_posting_id as string)),
  ])
  const linesErr = entriesErr ?? postingsErr
  if (linesErr) throw new Error(`The invoice's entries could not be read: ${linesErr.message}`)
  const entryById = new Map(((entries as any[]) ?? []).map(e => [e.id as string, { ...e, journal_postings: [] } as EntryRow]))
  const nowAmount = new Map(((postings as any[]) ?? []).map(p => [p.id as string, roundCents(Number(p.amount))]))
  const line = await lineDetails(admin, fundId, Array.from(entryById.values()))
  return rows
    .map(r => {
      const e = entryById.get(r.journal_entry_id) ?? { id: r.journal_entry_id, entry_date: '', memo: null, reference: null, status: 'deleted', vendor_id: null, source_type: null, journal_postings: [] }
      return {
        ...line(e, r.journal_posting_id, roundCents(Number(r.amount))),
        // The line's own, frozen with the invoice; never re-read from the receipt or the rules.
        allocationBasis: r.allocation_basis ?? null,
        currentAmount: nowAmount.get(r.journal_posting_id) ?? null,
      }
    })
    .sort((a, b) => a.entryDate.localeCompare(b.entryDate))
}

export async function getPartnershipInvoice(admin: SupabaseClient, fundId: string, id: string): Promise<InvoiceDetail | null> {
  const { data, error } = await admin.from('partnership_invoices' as any).select('*').eq('fund_id', fundId).eq('id', id).maybeSingle()
  if (error) throw new Error(`The invoice could not be read: ${error.message}`)
  if (!data) return null
  const inv = data as any
  const pair = await vehiclePair(admin, fundId, inv.from_vehicle_id, inv.to_vehicle_id)
  if (!pair) return null
  const [lines, adjustments] = await Promise.all([invoiceLines(admin, fundId, inv.id), invoiceAdjustments(admin, fundId, inv.id)])
  const [y, m] = String(inv.period_start).split('-').map(Number)
  const adjustmentTotal = roundCents(Number(inv.adjustment_total ?? 0))
  return {
    id: inv.id, invoiceNumber: inv.invoice_number, invoiceDate: inv.invoice_date,
    periodStart: inv.period_start, periodEnd: inv.period_end,
    label: `Q${Math.floor((m - 1) / 3) + 1} ${y}`,
    amount: Number(inv.amount), adjustments, adjustmentTotal, amountDue: amountDue(Number(inv.amount), adjustmentTotal),
    currency: inv.currency, memo: inv.memo ?? null,
    status: inv.status, issuedAt: inv.issued_at ?? null,
    intercompanyTransactionId: inv.intercompany_transaction_id ?? null,
    ...pair, lines,
  }
}

/** Invoices one entity sent or received, newest period first. */
export async function listPartnershipInvoices(admin: SupabaseClient, fundId: string, vehicleId: string) {
  const { data } = await admin.from('partnership_invoices' as any)
    .select('id, invoice_number, invoice_date, period_start, period_end, amount, adjustment_total, currency, status, from_vehicle_id, to_vehicle_id, issued_at')
    .eq('fund_id', fundId)
    .or(`from_vehicle_id.eq.${vehicleId},to_vehicle_id.eq.${vehicleId}`)
    .order('period_end', { ascending: false }).order('created_at', { ascending: false })
    .limit(200)
  return ((data as any[]) ?? [])
}

/**
 * Issue a draft invoice: book the fund's side, dated the invoice date, as an intercompany expense
 * reimbursement whose receivable is already on the biller's books. If the fund's books refuse (a
 * closed period, a chart with no partnership-expense account), nothing is booked and the invoice
 * stays a draft, with the reason.
 *
 * ONCE, AND A RETRY FINISHES RATHER THAN REPOSTS. The draft check is a separate read, so two
 * requests can both pass it. The charge carries the invoice id, and a unique index allows one live
 * charge per invoice (20261014190000): the second request's insert is refused before it posts. A
 * charge that is already booked while the invoice still says draft means an earlier attempt failed
 * to mark it; issuing again marks it and posts nothing (the shape of issueCapitalCall's replay).
 */
export async function issuePartnershipInvoice(
  admin: SupabaseClient,
  fundId: string,
  userId: string | null,
  id: string,
): Promise<{ ok: true; intercompanyTransactionId: string } | { error: string; status?: number }> {
  const inv = await getPartnershipInvoice(admin, fundId, id)
  if (!inv) return { error: 'Invoice not found', status: 404 }
  if (inv.status !== 'draft') return { error: `This invoice is already ${inv.status}.`, status: 409 }

  const { data: prior, error: priorErr } = await admin.from('intercompany_transactions' as any)
    .select('id, from_entry_id').eq('fund_id', fundId).eq('partnership_invoice_id', id).neq('status', 'void').maybeSingle()
  if (priorErr) return { error: `Could not check whether this invoice is already booked: ${priorErr.message}`, status: 500 }
  if (prior) return replayIssue(admin, fundId, id, inv.to.vehicleId, prior as { id: string; from_entry_id: string | null })

  // The lines are re-read, not trusted from creation: an entry voided or changed since cannot be
  // billed as it was, and the fund must not be charged for what the books no longer say.
  const stale = inv.lines.filter(l => l.status !== 'posted' || l.currentAmount == null || Math.abs(l.currentAmount - l.amount) >= 0.005)
  if (stale.length > 0) {
    return { error: `${stale.length} of this invoice's expenses ${stale.length === 1 ? 'has' : 'have'} been voided or changed since it was created. Delete this draft and create it again.`, status: 409 }
  }

  const res = await postIntercompanyCharge(admin, {
    fundId, userId,
    kind: 'expense_reimbursement',
    chargeDate: inv.invoiceDate,
    amount: inv.amount,
    // The charge books the expenses; settling it moves the amount due, so say so where it is settled.
    memo: `Partnership expenses ${inv.label}, invoice ${inv.invoiceNumber}${inv.adjustmentTotal !== 0 ? `; ${inv.amountDue.toFixed(2)} due after adjustments` : ''}`,
    payee: inv.from,
    payer: inv.to,
    payeeAlreadyBooked: true,
    partnershipInvoiceId: id,
  })
  if ('error' in res) return { error: res.error, status: res.duplicate ? 409 : 400 }
  return markIssued(admin, fundId, id, res.id, true)
}

/**
 * A live charge already books this invoice: finish the issue from the entry it LINKS, never by
 * posting again and never by adopting an entry found by ref.
 *
 * The link is written only after persistEntry has returned (postIntercompanyCharge), and a posted
 * header is not a finished posting until then: its allocation can still fail and delete it. So:
 *
 *   no entry linked     another request is still posting, or one died before linking (an orphan,
 *                       which voiding the draft invoice clears; see voidPartnershipInvoice): 409.
 *   linked, posted      an earlier attempt booked it and failed to mark the invoice: mark it.
 *   linked, a draft     refuse and name it: it is not a cost until it is posted.
 *   linked, void        someone unbooked it since. The charge is dead; void it and refuse, so the
 *                       next issue books afresh as a deliberate act. (A deleted entry nulls the
 *                       link, which is the first case.)
 */
async function replayIssue(
  admin: SupabaseClient,
  fundId: string,
  id: string,
  payerVehicleId: string,
  charge: { id: string; from_entry_id: string | null },
): Promise<{ ok: true; intercompanyTransactionId: string } | { error: string; status?: number }> {
  if (!charge.from_entry_id) {
    return { error: 'This invoice is being issued by another request. Refresh in a moment; if this persists, void the invoice and create it again.', status: 409 }
  }

  const { data: entry, error } = await admin.from('journal_entries' as any)
    .select('id, status').eq('id', charge.from_entry_id).eq('fund_id', fundId).eq('vehicle_id', payerVehicleId).eq('book', ACTUAL_BOOK)
    .maybeSingle()
  if (error) return { error: `Could not check the fund's entry for this invoice: ${error.message}`, status: 500 }
  const status = (entry as any)?.status as string | undefined
  if (status === 'posted') return markIssued(admin, fundId, id, charge.id)
  if (status === 'draft') {
    return { error: `The fund's entry for this invoice (${charge.from_entry_id}) is a draft. Post or void it, then issue the invoice again.`, status: 409 }
  }
  const { data: voided, error: voidErr } = await admin.from('intercompany_transactions' as any)
    .update({ status: 'void', updated_at: new Date().toISOString() })
    .eq('id', charge.id).eq('fund_id', fundId).eq('status', 'accrued').eq('from_entry_id', charge.from_entry_id)
    .select('id')
  if (voidErr) return { error: `Could not void the charge whose fund entry was voided: ${voidErr.message}`, status: 500 }
  if (((voided as any[]) ?? []).length === 0) {
    const { data: now } = await admin.from('intercompany_transactions' as any).select('status').eq('id', charge.id).eq('fund_id', fundId).maybeSingle()
    return {
      error: `The fund's entry for this invoice (${charge.from_entry_id}) was voided, but its charge is now ${(now as any)?.status ?? 'gone'}, ` +
        'so it was left as it is and the invoice was not issued. Check the charge in the intercompany register.',
      status: 409,
    }
  }
  return {
    error: `The fund's entry for this invoice (${charge.from_entry_id}) was voided after it was booked, so the invoice was not issued and its charge was voided too. Issue it again to book it afresh.`,
    status: 409,
  }
}

/**
 * Mark a draft invoice issued by the charge that booked it. Conditional on `draft`, so a row another
 * request already marked is not rewritten; that is still success if it names this same charge.
 */
async function markIssued(
  admin: SupabaseClient,
  fundId: string,
  id: string,
  chargeId: string,
  /** This request has just booked the charge: if the invoice is gone, so is the booking. */
  fresh = false,
): Promise<{ ok: true; intercompanyTransactionId: string } | { error: string; status?: number }> {
  const now = new Date().toISOString()
  const { data: updated, error } = await admin.from('partnership_invoices' as any).update({
    status: 'issued', issued_at: now, intercompany_transaction_id: chargeId, updated_at: now,
  }).eq('id', id).eq('fund_id', fundId).eq('status', 'draft').select('id')
  const booked = `The fund's side is booked (charge ${chargeId})`
  if (error) return { error: `${booked}, but the invoice could not be marked issued: ${error.message}. Issue it again to finish.`, status: 500 }
  if (((updated as any[]) ?? []).length > 0) return { ok: true, intercompanyTransactionId: chargeId }

  const { data: row, error: readErr } = await admin.from('partnership_invoices' as any)
    .select('status, intercompany_transaction_id').eq('id', id).eq('fund_id', fundId).maybeSingle()
  if (readErr) return { error: `${booked}, but the invoice could not be re-read: ${readErr.message}`, status: 500 }
  const r = row as any
  if (r?.status === 'issued' && r.intercompany_transaction_id === chargeId) return { ok: true, intercompanyTransactionId: chargeId }
  const state = r?.status ?? 'gone'
  if (!fresh) return { error: `${booked}, but the invoice changed while it was being issued (it is now ${state}).`, status: 409 }

  // The invoice was voided (its lines released) while this request booked it. A payable for an
  // invoice that no longer exists, with its lines free to bill again, is a double booking waiting
  // to happen: take the entry back off the fund and void the charge.
  const { data: charge, error: chargeErr } = await admin.from('intercompany_transactions' as any)
    .select('from_entry_id').eq('id', chargeId).eq('fund_id', fundId).maybeSingle()
  if (chargeErr) return { error: `${booked}, but the invoice is now ${state} and the charge could not be read to undo it: ${chargeErr.message}`, status: 500 }
  const entryId = (charge as any)?.from_entry_id as string | null
  const left = entryId ? await unwindIntercompanyEntry(admin, fundId, entryId) : null
  if (left) {
    return { error: `The invoice became ${state} while it was being issued, and undoing the fund's entry could not be confirmed: ${left}. Charge ${chargeId} is kept; void those entries in the journal.`, status: 409 }
  }
  const { error: voidErr } = await admin.from('intercompany_transactions' as any)
    .update({ status: 'void', updated_at: new Date().toISOString() }).eq('id', chargeId).eq('fund_id', fundId).eq('status', 'accrued')
  if (voidErr) return { error: `The invoice became ${state} while it was being issued; its fund entry was removed but charge ${chargeId} could not be voided: ${voidErr.message}`, status: 500 }
  return { error: `The invoice became ${state} while it was being issued, so its fund entry was removed and the charge voided. Nothing is booked.`, status: 409 }
}

/**
 * Void an invoice and release its lines for the next one. An ISSUED invoice is refused once the
 * fund has paid it, and while the fund's entry for it still stands: voiding the document would
 * leave the fund holding a payable for an invoice that no longer exists. Void that entry first.
 */
export async function voidPartnershipInvoice(
  admin: SupabaseClient,
  fundId: string,
  id: string,
): Promise<{ ok: true } | { error: string; status?: number }> {
  const { data } = await admin.from('partnership_invoices' as any).select('id, status, intercompany_transaction_id, to_vehicle_id').eq('fund_id', fundId).eq('id', id).maybeSingle()
  if (!data) return { error: 'Invoice not found', status: 404 }
  const inv = data as any
  if (inv.status === 'void') return { ok: true }
  if (inv.status === 'draft') {
    const refused = await releaseDraftCharge(admin, fundId, id, inv.to_vehicle_id)
    if (refused) return refused
  }
  if (inv.status === 'issued' && inv.intercompany_transaction_id) {
    const { data: charge } = await admin.from('intercompany_transactions' as any)
      .select('status, from_entry_id, to_entry_id').eq('id', inv.intercompany_transaction_id).maybeSingle()
    if ((charge as any)?.status === 'settled') {
      return { error: 'This invoice has been paid. Reverse the payment before voiding it.', status: 409 }
    }
    const entryIds = [(charge as any)?.from_entry_id, (charge as any)?.to_entry_id].filter(Boolean)
    if (entryIds.length > 0) {
      const { data: live } = await admin.from('journal_entries' as any).select('id').eq('book', ACTUAL_BOOK).in('id', entryIds).neq('status', 'void')
      if (((live as any[]) ?? []).length > 0) {
        const fundName = await vehicleNameById(admin, fundId, inv.to_vehicle_id)
        return { error: `This invoice is booked on ${fundName ?? 'the fund'}'s books. Void that entry first, then void the invoice.`, status: 409 }
      }
    }
    await admin.from('intercompany_transactions' as any).update({ status: 'void', updated_at: new Date().toISOString() })
      .eq('id', inv.intercompany_transaction_id).eq('fund_id', fundId)
  }
  await admin.from('partnership_invoice_lines' as any).update({ active: false }).eq('fund_id', fundId).eq('invoice_id', id)
  await admin.from('partnership_invoices' as any).update({ status: 'void', updated_at: new Date().toISOString() }).eq('id', id).eq('fund_id', fundId)
  return { ok: true }
}

/**
 * A draft invoice can carry a live charge: an issue that booked the fund and failed to mark the
 * invoice, or one that died before linking its entry. Voiding the invoice is how a person clears
 * it, and the same rule as for an issued invoice holds: refuse while the fund's books still carry
 * the charge, so a void never leaves a payable behind for an invoice that no longer exists.
 * Returns the refusal, or null once any such charge is void.
 */
async function releaseDraftCharge(
  admin: SupabaseClient, fundId: string, invoiceId: string, payerVehicleId: string,
): Promise<{ error: string; status: number } | null> {
  const { data, error } = await admin.from('intercompany_transactions' as any)
    .select('id, status, from_entry_id').eq('fund_id', fundId).eq('partnership_invoice_id', invoiceId).neq('status', 'void').maybeSingle()
  if (error) return { error: `Could not check this invoice's charge: ${error.message}`, status: 500 }
  const charge = data as { id: string; status: string; from_entry_id: string | null } | null
  if (!charge) return null
  if (charge.status === 'settled') return { error: 'This invoice has been paid. Reverse the payment before voiding it.', status: 409 }

  let liveId: string | null = null
  if (charge.from_entry_id) {
    const { data: live, error: liveErr } = await admin.from('journal_entries' as any).select('id')
      .eq('fund_id', fundId).eq('book', ACTUAL_BOOK).eq('id', charge.from_entry_id).neq('status', 'void').maybeSingle()
    if (liveErr) return { error: `Could not check the fund's entry for this invoice: ${liveErr.message}`, status: 500 }
    liveId = (live as any)?.id ?? null
  } else {
    try {
      liveId = (await liveEntryByRef(admin, fundId, payerVehicleId, intercompanyChargeRef(charge.id)))?.id ?? null
    } catch (e) {
      return { error: (e as Error).message, status: 500 }
    }
  }
  if (liveId) {
    const fundName = await vehicleNameById(admin, fundId, payerVehicleId)
    return { error: `This invoice is booked on ${fundName ?? 'the fund'}'s books (entry ${liveId}). Void that entry first, then void the invoice.`, status: 409 }
  }

  let q = admin.from('intercompany_transactions' as any).update({ status: 'void', updated_at: new Date().toISOString() })
    .eq('id', charge.id).eq('fund_id', fundId).eq('status', 'accrued')
  q = charge.from_entry_id ? q.eq('from_entry_id', charge.from_entry_id) : q.is('from_entry_id', null)
  const { data: voided, error: voidErr } = await q.select('id')
  if (voidErr) return { error: `Could not void this invoice's charge: ${voidErr.message}`, status: 500 }
  if (((voided as any[]) ?? []).length === 0) {
    return { error: 'This invoice\'s charge changed while it was being voided. Refresh and try again.', status: 409 }
  }
  return null
}
