// Quarterly partnership-expense invoices: the management company (or whichever entity paid) bills
// a fund for the fund's expenses it paid during the quarter.
//
// THE FLOW.
//   1. Entries on the payer's books are tagged `rebill_vehicle_id = <fund>` (receipts.ts,
//      tagPartnershipExpense). Usually with a receipt attached, which is the point.
//   2. `previewPartnershipInvoice` lists every POSTED, tagged, not-yet-billed entry in the quarter.
//      Drafts are listed separately as a warning, never billed: a draft is not yet a cost.
//   3. `createPartnershipInvoice` freezes the lines and the total into a DRAFT invoice and stamps
//      each entry with the invoice id, so the same expense cannot land on two invoices.
//   4. `issuePartnershipInvoice` books it as ONE intercompany expense reimbursement through
//      intercompany.ts, both ledgers or neither:
//
//        payer of the cost (manco)   Dr Due from <fund>            Cr Expense reimbursement income
//        the fund                    Dr Partnership expenses       Cr Due to <manco>
//
//      and the cash, when the fund pays, is the charge's settlement on the manco's Intercompany tab.
//   5. `voidPartnershipInvoice` releases the entries. An issued invoice's charge has to be reversed
//      on both ledgers first (a void here never silently unposts the other side's books).
//
// The invoice row is the document; the ledger is the fact. The amount on the row never moves after
// creation, the same way a capital call notice keeps the number the partner was told.

import type { SupabaseClient } from '@supabase/supabase-js'
import { roundCents } from './ledger'
import { postIntercompanyCharge } from './intercompany'
import { vehicleNameById } from './vehicle-id'
import { ACTUAL_BOOK } from './books'
import { billableAmount, invoiceNumber, quarterBounds, type Quarter } from './receipts-core'

export interface InvoiceLine {
  entryId: string
  entryDate: string
  memo: string | null
  reference: string | null
  vendorName: string | null
  amount: number
  receiptCount: number
  status: string
}

export interface InvoicePreview {
  quarter: Quarter
  from: { vehicleId: string; name: string }
  to: { vehicleId: string; name: string }
  lines: InvoiceLine[]
  total: number
  /** Tagged entries still in draft: not billed until posted. */
  drafts: InvoiceLine[]
  /** An invoice already covering this quarter, if one exists. */
  existing: { id: string; invoiceNumber: string; status: string; amount: number } | null
}

async function vehiclePair(admin: SupabaseClient, fundId: string, fromId: string, toId: string) {
  const [fromName, toName] = await Promise.all([vehicleNameById(admin, fundId, fromId), vehicleNameById(admin, fundId, toId)])
  if (!fromName || !toName) return null
  return { from: { vehicleId: fromId, name: fromName }, to: { vehicleId: toId, name: toName } }
}

/**
 * The tagged entries on `fromVehicleId`'s books billed to `toVehicleId` and dated in the window.
 * `invoiceId` narrows to the lines of one invoice; otherwise only entries not on any invoice.
 */
async function loadLines(
  admin: SupabaseClient,
  fundId: string,
  fromVehicleId: string,
  toVehicleId: string,
  window: { start: string; end: string } | null,
  invoiceId: string | null,
): Promise<InvoiceLine[]> {
  let q = admin.from('journal_entries' as any)
    .select('id, entry_date, memo, reference, status, rebill_amount, vendor_id, journal_postings(amount, account_id)')
    .eq('fund_id', fundId).eq('vehicle_id', fromVehicleId).eq('book', ACTUAL_BOOK)
    .eq('rebill_vehicle_id', toVehicleId)
    .in('status', ['draft', 'posted'])
  q = invoiceId ? q.eq('partnership_invoice_id', invoiceId) : q.is('partnership_invoice_id', null)
  if (window) q = q.gte('entry_date', window.start).lte('entry_date', window.end)
  const { data: entries, error } = await q.order('entry_date', { ascending: true }).limit(2000)
  if (error) throw new Error(`The tagged entries could not be read: ${error.message}`)
  const rows = (entries as any[]) ?? []
  if (rows.length === 0) return []

  const ids = rows.map(e => e.id as string)
  const vendorIds = Array.from(new Set(rows.map(e => e.vendor_id).filter(Boolean)))
  const [{ data: accounts }, { data: vendors }, { data: receipts }] = await Promise.all([
    admin.from('chart_of_accounts' as any).select('id, type').eq('fund_id', fundId).eq('vehicle_id', fromVehicleId),
    vendorIds.length ? admin.from('vendors' as any).select('id, name').eq('fund_id', fundId).in('id', vendorIds) : Promise.resolve({ data: [] }),
    admin.from('receipts' as any).select('journal_entry_id').eq('fund_id', fundId).neq('status', 'dismissed').in('journal_entry_id', ids),
  ])
  const typeOf = new Map(((accounts as any[]) ?? []).map(a => [a.id as string, a.type as string]))
  const vendorName = new Map(((vendors as any[]) ?? []).map(v => [v.id as string, v.name as string]))
  const receiptCount = new Map<string, number>()
  for (const r of ((receipts as any[]) ?? [])) receiptCount.set(r.journal_entry_id, (receiptCount.get(r.journal_entry_id) ?? 0) + 1)

  return rows.map(e => ({
    entryId: e.id,
    entryDate: e.entry_date,
    memo: e.memo ?? null,
    reference: e.reference ?? null,
    vendorName: e.vendor_id ? vendorName.get(e.vendor_id) ?? null : null,
    amount: billableAmount(e.rebill_amount == null ? null : Number(e.rebill_amount),
      ((e.journal_postings as any[]) ?? []).map(p => ({ amount: Number(p.amount), accountType: typeOf.get(p.account_id) ?? null }))),
    receiptCount: receiptCount.get(e.id) ?? 0,
    status: e.status,
  }))
}

async function existingInvoice(admin: SupabaseClient, fundId: string, fromId: string, toId: string, q: Quarter) {
  const { data } = await admin.from('partnership_invoices' as any)
    .select('id, invoice_number, status, amount')
    .eq('fund_id', fundId).eq('from_vehicle_id', fromId).eq('to_vehicle_id', toId)
    .eq('period_start', q.start).eq('period_end', q.end).neq('status', 'void').maybeSingle()
  return data ? { id: (data as any).id, invoiceNumber: (data as any).invoice_number, status: (data as any).status, amount: Number((data as any).amount) } : null
}

/** What an invoice for this quarter would bill, without writing anything. */
export async function previewPartnershipInvoice(
  admin: SupabaseClient,
  fundId: string,
  args: { fromVehicleId: string; toVehicleId: string; year: number; quarter: number },
): Promise<InvoicePreview | { error: string }> {
  let q: Quarter
  try { q = quarterBounds(args.year, args.quarter) } catch (e) { return { error: (e as Error).message } }
  const pair = await vehiclePair(admin, fundId, args.fromVehicleId, args.toVehicleId)
  if (!pair) return { error: 'Both entities must be in this fund.' }
  if (args.fromVehicleId === args.toVehicleId) return { error: 'An entity cannot bill itself.' }
  const all = await loadLines(admin, fundId, args.fromVehicleId, args.toVehicleId, q, null)
  const lines = all.filter(l => l.status === 'posted' && l.amount > 0)
  return {
    quarter: q, ...pair, lines,
    total: roundCents(lines.reduce((s, l) => s + l.amount, 0)),
    drafts: all.filter(l => l.status === 'draft'),
    existing: await existingInvoice(admin, fundId, args.fromVehicleId, args.toVehicleId, q),
  }
}

/** Every entity that has tagged, unbilled partnership expenses on `fromVehicleId`'s books, with totals. */
export async function unbilledByCounterparty(admin: SupabaseClient, fundId: string, fromVehicleId: string): Promise<{ vehicleId: string; name: string; entries: number }[]> {
  const { data } = await admin.from('journal_entries' as any)
    .select('rebill_vehicle_id')
    .eq('fund_id', fundId).eq('vehicle_id', fromVehicleId).eq('book', ACTUAL_BOOK).eq('status', 'posted')
    .not('rebill_vehicle_id', 'is', null).is('partnership_invoice_id', null).limit(5000)
  const counts = new Map<string, number>()
  for (const r of ((data as any[]) ?? [])) counts.set(r.rebill_vehicle_id, (counts.get(r.rebill_vehicle_id) ?? 0) + 1)
  const out: { vehicleId: string; name: string; entries: number }[] = []
  for (const [vehicleId, entries] of Array.from(counts.entries())) {
    const name = await vehicleNameById(admin, fundId, vehicleId)
    if (name) out.push({ vehicleId, name, entries })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Freeze the quarter's lines into a DRAFT invoice. Refuses an empty quarter, and a quarter that
 * already has a live invoice (the unique index says the same; this says it in words).
 */
export async function createPartnershipInvoice(
  admin: SupabaseClient,
  fundId: string,
  userId: string | null,
  args: { fromVehicleId: string; toVehicleId: string; year: number; quarter: number; invoiceDate?: string | null; memo?: string | null },
): Promise<{ id: string; invoiceNumber: string; amount: number; lines: number } | { error: string; status?: number }> {
  const preview = await previewPartnershipInvoice(admin, fundId, args)
  if ('error' in preview) return { error: preview.error, status: 400 }
  if (preview.existing) {
    return { error: `${preview.quarter.label} is already billed to ${preview.to.name} on invoice ${preview.existing.invoiceNumber} (${preview.existing.status}). Void it to bill the quarter again.`, status: 409 }
  }
  if (preview.lines.length === 0) {
    return { error: `Nothing to bill: no posted partnership expenses tagged to ${preview.to.name} in ${preview.quarter.label}.`, status: 400 }
  }

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

  // Claim the lines. `is null` in the filter makes the claim exclusive: an entry another invoice
  // claimed a moment ago is left alone, and the totals are checked against what this one got.
  const ids = preview.lines.map(l => l.entryId)
  const { data: claimed, error: claimErr } = await admin.from('journal_entries' as any)
    .update({ partnership_invoice_id: row.id })
    .eq('fund_id', fundId).eq('book', ACTUAL_BOOK).in('id', ids).is('partnership_invoice_id', null)
    .select('id')
  const got = new Set(((claimed as any[]) ?? []).map(e => e.id as string))
  if (claimErr || got.size !== ids.length) {
    await admin.from('journal_entries' as any).update({ partnership_invoice_id: null }).eq('fund_id', fundId).eq('partnership_invoice_id', row.id)
    await admin.from('partnership_invoices' as any).delete().eq('id', row.id).eq('fund_id', fundId)
    return { error: 'Some of these entries were billed on another invoice at the same moment. Refresh and try again.', status: 409 }
  }

  return { id: row.id, invoiceNumber: row.invoice_number, amount: preview.total, lines: ids.length }
}

export interface InvoiceDetail {
  id: string
  invoiceNumber: string
  invoiceDate: string
  periodStart: string
  periodEnd: string
  label: string
  amount: number
  currency: string
  memo: string | null
  status: 'draft' | 'issued' | 'void'
  issuedAt: string | null
  intercompanyTransactionId: string | null
  from: { vehicleId: string; name: string }
  to: { vehicleId: string; name: string }
  lines: InvoiceLine[]
}

export async function getPartnershipInvoice(admin: SupabaseClient, fundId: string, id: string): Promise<InvoiceDetail | null> {
  const { data } = await admin.from('partnership_invoices' as any).select('*').eq('fund_id', fundId).eq('id', id).maybeSingle()
  if (!data) return null
  const inv = data as any
  const pair = await vehiclePair(admin, fundId, inv.from_vehicle_id, inv.to_vehicle_id)
  if (!pair) return null
  const lines = await loadLines(admin, fundId, inv.from_vehicle_id, inv.to_vehicle_id, null, inv.id)
  const [y, m] = String(inv.period_start).split('-').map(Number)
  return {
    id: inv.id, invoiceNumber: inv.invoice_number, invoiceDate: inv.invoice_date,
    periodStart: inv.period_start, periodEnd: inv.period_end,
    label: `Q${Math.floor((m - 1) / 3) + 1} ${y}`,
    amount: Number(inv.amount), currency: inv.currency, memo: inv.memo ?? null,
    status: inv.status, issuedAt: inv.issued_at ?? null,
    intercompanyTransactionId: inv.intercompany_transaction_id ?? null,
    ...pair, lines,
  }
}

/** Invoices one entity sent or received, newest period first. */
export async function listPartnershipInvoices(admin: SupabaseClient, fundId: string, vehicleId: string) {
  const { data } = await admin.from('partnership_invoices' as any)
    .select('id, invoice_number, invoice_date, period_start, period_end, amount, currency, status, from_vehicle_id, to_vehicle_id, issued_at')
    .eq('fund_id', fundId)
    .or(`from_vehicle_id.eq.${vehicleId},to_vehicle_id.eq.${vehicleId}`)
    .order('period_end', { ascending: false }).order('created_at', { ascending: false })
    .limit(200)
  return ((data as any[]) ?? [])
}

/**
 * Issue a draft invoice: book it on both ledgers as an intercompany expense reimbursement, dated
 * the invoice date. If either side refuses (a closed period on the fund's books, a chart with no
 * partnership-expense account), nothing is booked and the invoice stays a draft, with the reason.
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

  // The lines are re-read, not trusted from creation: an entry voided or unposted since cannot be
  // billed, and the fund must not be charged for it.
  const notPosted = inv.lines.filter(l => l.status !== 'posted')
  if (notPosted.length > 0) {
    return { error: `${notPosted.length} of this invoice's entries ${notPosted.length === 1 ? 'is' : 'are'} no longer posted. Void the invoice and create it again.`, status: 409 }
  }
  const total = roundCents(inv.lines.reduce((s, l) => s + l.amount, 0))
  if (Math.abs(total - inv.amount) >= 0.005) {
    return { error: `The entries on this invoice now total ${total.toFixed(2)}, not the ${inv.amount.toFixed(2)} it was created for. Void it and create it again.`, status: 409 }
  }

  const res = await postIntercompanyCharge(admin, {
    fundId, userId,
    kind: 'expense_reimbursement',
    chargeDate: inv.invoiceDate,
    amount: inv.amount,
    memo: `Partnership expenses ${inv.label}, invoice ${inv.invoiceNumber}`,
    payee: inv.from,
    payer: inv.to,
  })
  if ('error' in res) return { error: res.error, status: 400 }

  await admin.from('partnership_invoices' as any).update({
    status: 'issued', issued_at: new Date().toISOString(), intercompany_transaction_id: res.id, updated_at: new Date().toISOString(),
  }).eq('id', id).eq('fund_id', fundId)
  return { ok: true, intercompanyTransactionId: res.id }
}

/**
 * Void an invoice and release its entries for re-billing. An ISSUED invoice is refused while its
 * intercompany charge still stands: voiding the document would leave the fund holding a payable for
 * an invoice that no longer exists. Reverse (void) the two entries of the charge first.
 */
export async function voidPartnershipInvoice(
  admin: SupabaseClient,
  fundId: string,
  id: string,
): Promise<{ ok: true } | { error: string; status?: number }> {
  const { data } = await admin.from('partnership_invoices' as any).select('id, status, intercompany_transaction_id').eq('fund_id', fundId).eq('id', id).maybeSingle()
  if (!data) return { error: 'Invoice not found', status: 404 }
  const inv = data as any
  if (inv.status === 'void') return { ok: true }
  if (inv.status === 'issued' && inv.intercompany_transaction_id) {
    const { data: charge } = await admin.from('intercompany_transactions' as any)
      .select('from_entry_id, to_entry_id').eq('id', inv.intercompany_transaction_id).maybeSingle()
    const entryIds = [(charge as any)?.from_entry_id, (charge as any)?.to_entry_id].filter(Boolean)
    if (entryIds.length > 0) {
      const { data: live } = await admin.from('journal_entries' as any).select('id').eq('book', ACTUAL_BOOK).in('id', entryIds).neq('status', 'void')
      if (((live as any[]) ?? []).length > 0) {
        return { error: 'This invoice is booked on both ledgers. Void its two intercompany entries first, then void the invoice.', status: 409 }
      }
    }
    // Both entries are gone, so the charge they booked is too.
    await admin.from('intercompany_transactions' as any).update({ status: 'void', updated_at: new Date().toISOString() })
      .eq('id', inv.intercompany_transaction_id).eq('fund_id', fundId)
  }
  await admin.from('journal_entries' as any).update({ partnership_invoice_id: null }).eq('fund_id', fundId).eq('partnership_invoice_id', id)
  await admin.from('partnership_invoices' as any).update({ status: 'void', updated_at: new Date().toISOString() }).eq('id', id).eq('fund_id', fundId)
  return { ok: true }
}
