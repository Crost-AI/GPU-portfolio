// The GPU SPV management fee: a share of gross rental revenue, month by month.
//
// The fee is an expense of the SPV, outside the distribution split. It is charged on revenue
// only, never on sale proceeds (4500) or interest (4100): the accrual that ships with the ledger
// wiring reads posted revenue in `revenueSubtypes`, so those accounts are outside the basis by
// construction. This file is the pure arithmetic both the accrual and the scenario engine use.

import type { SupabaseClient } from '@supabase/supabase-js'
import { roundCents } from '@/lib/accounting/ledger'
import { vehicleIdByName, vehicleNameById } from '@/lib/accounting/vehicle-id'
import { persistEntry } from '@/lib/accounting/persist'
import { postIntercompanyCharge, voidUnsettledCharge } from '@/lib/accounting/intercompany'
import { fetchAllRows, fetchAllRowsIn } from '@/lib/accounting/load'
import { firstDay, lastDay, type MonthKey } from '@/lib/forecast/months'

export const DEFAULT_FEE_REVENUE_SUBTYPES = ['rental_revenue']

/** `vehicle_fee_terms.basis`. Only gross_revenue is accrued by this module (a GPU SPV's fee). */
export const FEE_BASES = ['committed', 'invested', 'nav', 'gross_revenue'] as const
export type FeeBasis = (typeof FEE_BASES)[number]
export const FEE_FREQUENCIES = ['monthly', 'quarterly'] as const

export interface VehicleFeeTerms {
  basis: FeeBasis
  /** Share of each month's gross revenue, e.g. 0.05. Not divided by 12: it applies to revenue. */
  annualRate: number
  /** Account subtypes whose posted revenue is the basis; `DEFAULT_FEE_REVENUE_SUBTYPES` by default. */
  revenueSubtypes: string[]
  frequency: (typeof FEE_FREQUENCIES)[number]
  /** The management company's vehicle when the fee is booked intercompany; else null (2100). */
  payeeVehicleId: string | null
  effectiveFrom?: string
  effectiveTo?: string | null
}

/** The vehicle's `vehicle_fee_terms` row, or null when it has none. A failed read throws. */
export async function loadFeeTerms(admin: SupabaseClient, fundId: string, group: string): Promise<VehicleFeeTerms | null> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  if (!vehicleId) return null
  const { data, error } = await (admin as any)
    .from('vehicle_fee_terms')
    .select('basis, annual_rate, revenue_subtypes, frequency, payee_vehicle_id, effective_from, effective_to')
    .eq('fund_id', fundId).eq('vehicle_id', vehicleId)
    .maybeSingle()
  if (error) throw new Error(`vehicle_fee_terms read failed: ${error.message}`)
  if (!data) return null
  return {
    basis: data.basis,
    annualRate: Number(data.annual_rate),
    revenueSubtypes: Array.isArray(data.revenue_subtypes) && data.revenue_subtypes.length > 0 ? data.revenue_subtypes : DEFAULT_FEE_REVENUE_SUBTYPES,
    frequency: data.frequency === 'quarterly' ? 'quarterly' : 'monthly',
    payeeVehicleId: data.payee_vehicle_id ?? null,
    effectiveFrom: data.effective_from,
    effectiveTo: data.effective_to ?? null,
  }
}

/** The fee for each month: roundCents(rate × that month's revenue). */
export function grossRevenueFee(terms: VehicleFeeTerms, revenueByMonth: Map<MonthKey, number>): Map<MonthKey, number> {
  const out = new Map<MonthKey, number>()
  for (const [month, revenue] of revenueByMonth) out.set(month, roundCents(terms.annualRate * revenue))
  return out
}

/** The ref a gross-revenue fee true-up books under, one per vehicle and month. */
export const grossRevenueFeeRef = (vehicleId: string, month: MonthKey) => `gpu-fee:${vehicleId}:${month}`

/**
 * True up the month's gross-revenue fee: what the posted revenue says it should be, less what is
 * already booked for that month, posted as the difference. Running it twice posts nothing; revenue
 * reversed after a run makes the next run post a reduction.
 *
 * The basis is POSTED postings on accounts whose subtype is in `revenueSubtypes`, dated in the
 * month. A disposal (4500) and interest (4100) carry other subtypes, so they never enter it.
 *
 * Booking: with a payee management company, through the intercompany register so it nets to the
 * fee (bookIntercompanyFee): a fee charge (SPV Dr 5000 / Cr 2900-<manco>; manco Dr 1900-<spv> /
 * Cr fee income) tagged with the month's ref, re-issued net or rebated when the fee falls. Without
 * a payee: Dr 5000 / Cr 2100 Due to manager, and the reverse for a reduction.
 *
 * `entryId` is the SPV's entry, or the intercompany charge's id when an increase is charged.
 */
export async function accrueGrossRevenueFee(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  userId: string | null,
  month: MonthKey,
): Promise<{ entryId?: string; delta: number } | { error: string }> {
  let terms: VehicleFeeTerms | null
  try {
    terms = await loadFeeTerms(admin, fundId, group)
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
  if (!terms || terms.basis !== 'gross_revenue') return { delta: 0 }
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  if (!vehicleId) return { error: `"${group}" is not in this fund's vehicle registry` }

  const start = firstDay(month)
  const end = lastDay(month)
  const inForce = (!terms.effectiveFrom || terms.effectiveFrom <= end) && (!terms.effectiveTo || terms.effectiveTo >= start)

  const { data: accounts, error: acctErr } = await (admin as any)
    .from('chart_of_accounts').select('id, code, subtype').eq('fund_id', fundId).eq('vehicle_id', vehicleId)
  if (acctErr) return { error: `chart_of_accounts read failed: ${acctErr.message}` }
  const chart = (accounts ?? []) as { id: string; code: string; subtype: string | null }[]
  const revenueIds = new Set(chart.filter(a => a.subtype && terms!.revenueSubtypes.includes(a.subtype)).map(a => a.id))
  const feeAccount = chart.find(a => a.code === '5000') ?? chart.find(a => a.subtype === 'management_fee')
  if (!feeAccount) return { error: `${group}'s chart has no management fee expense account (5000)` }
  const feeIds = new Set(chart.filter(a => a.subtype === 'management_fee').map(a => a.id).concat(feeAccount.id))

  // What the month earned (posted entries only), and what is already booked for it: entries under
  // its ref, and the SPV side of every live intercompany charge tagged with it. Paged and chunked,
  // because a busy month has more entries than one read or one `.in()` can carry; a failed read is
  // returned, not thrown, so the close that called this unwinds.
  const ref = grossRevenueFeeRef(vehicleId, month)
  let revenue: number
  let booked: number
  try {
    const monthEntries = await fetchAllRows<{ id: string }>((from, to) => (admin as any)
      .from('journal_entries').select('id')
      .eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('book', 'actual').eq('status', 'posted')
      .gte('entry_date', start).lte('entry_date', end)
      .range(from, to))
    revenue = roundCents(-(await postingsOn(admin, monthEntries.map(e => e.id), revenueIds)))

    const charges = await monthCharges(admin, fundId, vehicleId, ref)
    const refs = [ref, ...charges.map(c => `intercompany:${c.id}`)]
    const feeEntries = await fetchAllRowsIn<{ id: string }>(refs, (chunk, from, to) => (admin as any)
      .from('journal_entries').select('id')
      .eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('book', 'actual').neq('status', 'void').in('source_ref', chunk)
      .range(from, to))
    booked = roundCents(await postingsOn(admin, feeEntries.map(e => e.id), feeIds))
  } catch (e) {
    return { error: `The fee basis could not be read: ${(e as { message?: string })?.message ?? String(e)}` }
  }

  const target = inForce ? grossRevenueFee(terms, new Map([[month, revenue]])).get(month)! : 0
  const delta = roundCents(target - booked)
  if (delta === 0) return { delta: 0 }

  const memo = `Management fee, ${roundCents(terms.annualRate * 100)}% of ${month} gross revenue`
  if (terms.payeeVehicleId) return bookIntercompanyFee(admin, fundId, group, userId, vehicleId, terms.payeeVehicleId, end, delta, `${memo} [${ref}]`, ref)

  const dueToManager = chart.find(a => a.code === '2100')
  if (!dueToManager) return { error: `${group}'s chart has no 2100 Due to manager account` }
  const amount = Math.abs(delta)
  const [debit, credit] = delta > 0 ? [feeAccount.id, dueToManager.id] : [dueToManager.id, feeAccount.id]
  const result = await persistEntry(admin, fundId, group, userId, {
    fundId, entryDate: end, memo: delta > 0 ? memo : `${memo} — reduction`, sourceType: 'management_fee', sourceRef: ref,
    postings: [
      { accountId: debit, amount, currency: 'USD', lpEntityId: null },
      { accountId: credit, amount: -amount, currency: 'USD', lpEntityId: null },
    ],
  })
  if ('error' in result) return { error: result.error }
  return { entryId: result.entryId, delta }
}

/** The signed sum of postings in `entryIds` that hit `accountIds`, read in chunks of entry ids. */
async function postingsOn(admin: SupabaseClient, entryIds: string[], accountIds: Set<string>): Promise<number> {
  if (entryIds.length === 0 || accountIds.size === 0) return 0
  const rows = await fetchAllRowsIn<{ account_id: string; amount: number }>(entryIds, (chunk, from, to) => (admin as any)
    .from('journal_postings').select('id, account_id, amount').eq('book', 'actual')
    .in('journal_entry_id', chunk).in('account_id', Array.from(accountIds))
    .range(from, to))
  return rows.reduce((t, p) => t + Number(p.amount), 0)
}

/** A live intercompany charge carrying a month's fee ref: the fee itself, or a rebate of it. */
interface MonthCharge { id: string; kind: string; status: string; amount: number }

/**
 * The month's live charges: fees the SPV owes the manco and rebates the manco owes the SPV, each
 * tagged with the month's ref in its memo. Their SPV-side entries are what is already booked.
 */
async function monthCharges(admin: SupabaseClient, fundId: string, vehicleId: string, ref: string): Promise<MonthCharge[]> {
  const read = (side: 'from_vehicle_id' | 'to_vehicle_id', kind: string) => fetchAllRows<MonthCharge>((from, to) => (admin as any)
    .from('intercompany_transactions').select('id, kind, status, amount')
    .eq('fund_id', fundId).eq(side, vehicleId).eq('kind', kind).neq('status', 'void')
    .like('memo', `%[${ref}]%`)
    .range(from, to))
  const [fees, rebates] = await Promise.all([read('from_vehicle_id', 'management_fee'), read('to_vehicle_id', 'management_fee_rebate')])
  return [...fees, ...rebates]
}

/**
 * Book a fee change to the payee management company so the charge register nets to the fee, as
 * the ledger does:
 *   - an increase is a further management-fee charge;
 *   - a reduction with fee charges still unsettled voids them (both books) and re-issues what is
 *     left as one charge, so the cash that moves at settlement is the net fee;
 *   - a reduction once the fee is paid is a rebate the manco owes back (manco Dr fee income /
 *     Cr due to SPV; SPV Dr due from manco / Cr 5000), settled like any charge.
 */
async function bookIntercompanyFee(
  admin: SupabaseClient, fundId: string, group: string, userId: string | null, vehicleId: string,
  payeeVehicleId: string, date: string, delta: number, memo: string, ref: string,
): Promise<{ entryId?: string; delta: number } | { error: string }> {
  const payeeName = await vehicleNameById(admin, fundId, payeeVehicleId)
  if (!payeeName) return { error: 'The fee payee is not a vehicle in this fund' }
  const spv = { vehicleId, name: group }
  const manco = { vehicleId: payeeVehicleId, name: payeeName }
  const charge = async (amount: number): Promise<{ entryId?: string; delta: number } | { error: string }> => {
    if (amount === 0) return { delta }
    const fee = amount > 0
    const res = await postIntercompanyCharge(admin, {
      fundId, userId, kind: fee ? 'management_fee' : 'management_fee_rebate', chargeDate: date, amount: Math.abs(amount),
      memo: fee ? memo : `${memo} — rebate`, payer: fee ? spv : manco, payee: fee ? manco : spv,
    })
    return 'error' in res ? { error: res.error } : { entryId: res.id, delta }
  }
  if (delta > 0) return charge(delta)

  let unsettled: MonthCharge[]
  try {
    unsettled = (await monthCharges(admin, fundId, vehicleId, ref)).filter(c => c.kind === 'management_fee' && c.status === 'accrued')
  } catch (e) {
    return { error: `The month's fee charges could not be read: ${(e as { message?: string })?.message ?? String(e)}` }
  }
  if (unsettled.length === 0) return charge(delta)
  for (const c of unsettled) {
    const voided = await voidUnsettledCharge(admin, fundId, c.id)
    if ('error' in voided) return voided
  }
  return charge(roundCents(unsettled.reduce((t, c) => t + Number(c.amount), 0) + delta))
}
