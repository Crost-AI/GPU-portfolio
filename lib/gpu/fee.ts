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
import {
  buildPayeeEntry, buildPayerEntry, ensureIntercompanyAccounts, postIntercompanyCharge, resolveSideAccounts, unwindIntercompanyEntry,
} from '@/lib/accounting/intercompany'
import type { JournalEntry } from '@/lib/accounting/types'
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
 * Booking: with a payee management company, an increase is an intercompany management-fee charge
 * (SPV Dr 5000 / Cr 2900-<manco>; manco Dr 1900-<spv> / Cr fee income), tagged with the month's
 * ref in its memo. The charge register requires a positive amount, so a reduction posts the mirror
 * pair directly, both under the month's ref. Without a payee: Dr 5000 / Cr 2100 Due to manager,
 * and the reverse for a reduction.
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

  // What the month earned, from posted entries only.
  const { data: monthEntries, error: entErr } = await (admin as any)
    .from('journal_entries').select('id')
    .eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('book', 'actual').eq('status', 'posted')
    .gte('entry_date', start).lte('entry_date', end)
  if (entErr) return { error: `journal_entries read failed: ${entErr.message}` }
  const revenue = roundCents(-(await postingsOn(admin, (monthEntries ?? []).map((e: any) => e.id), revenueIds)))

  // What is already booked for the month: entries under its ref, and the SPV side of every live
  // intercompany charge tagged with it.
  const ref = grossRevenueFeeRef(vehicleId, month)
  const { data: charges, error: chErr } = await (admin as any)
    .from('intercompany_transactions').select('id')
    .eq('fund_id', fundId).eq('from_vehicle_id', vehicleId).eq('kind', 'management_fee').neq('status', 'void')
    .like('memo', `%[${ref}]%`)
  if (chErr) return { error: `intercompany_transactions read failed: ${chErr.message}` }
  const refs = [ref, ...((charges ?? []) as any[]).map(c => `intercompany:${c.id}`)]
  const { data: feeEntries, error: feeErr } = await (admin as any)
    .from('journal_entries').select('id')
    .eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('book', 'actual').neq('status', 'void').in('source_ref', refs)
  if (feeErr) return { error: `journal_entries read failed: ${feeErr.message}` }
  const booked = roundCents(await postingsOn(admin, (feeEntries ?? []).map((e: any) => e.id), feeIds))

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

/** The signed sum of postings in `entryIds` that hit `accountIds`. */
async function postingsOn(admin: SupabaseClient, entryIds: string[], accountIds: Set<string>): Promise<number> {
  if (entryIds.length === 0 || accountIds.size === 0) return 0
  const { data, error } = await (admin as any)
    .from('journal_postings').select('account_id, amount').eq('book', 'actual').in('journal_entry_id', entryIds)
  if (error) throw new Error(`journal_postings read failed: ${error.message}`)
  return ((data ?? []) as any[]).filter(p => accountIds.has(p.account_id)).reduce((t, p) => t + Number(p.amount), 0)
}

async function bookIntercompanyFee(
  admin: SupabaseClient, fundId: string, group: string, userId: string | null, vehicleId: string,
  payeeVehicleId: string, date: string, delta: number, memo: string, ref: string,
): Promise<{ entryId?: string; delta: number } | { error: string }> {
  const payeeName = await vehicleNameById(admin, fundId, payeeVehicleId)
  if (!payeeName) return { error: 'The fee payee is not a vehicle in this fund' }
  if (delta > 0) {
    const charge = await postIntercompanyCharge(admin, {
      fundId, userId, kind: 'management_fee', chargeDate: date, amount: delta, memo,
      payer: { vehicleId, name: group }, payee: { vehicleId: payeeVehicleId, name: payeeName },
    })
    return 'error' in charge ? { error: charge.error } : { entryId: charge.id, delta }
  }
  // A reduction: the charge's mirror on both books, SPV first, unwound if the manco's fails.
  try {
    const payerIc = await ensureIntercompanyAccounts(admin, fundId, group, { vehicleId: payeeVehicleId, name: payeeName })
    const payeeIc = await ensureIntercompanyAccounts(admin, fundId, payeeName, { vehicleId, name: group })
    const payer = await resolveSideAccounts(admin, fundId, group, 'management_fee', 'payer', payerIc.payableAccountId)
    const payee = await resolveSideAccounts(admin, fundId, payeeName, 'management_fee', 'payee', payeeIc.receivableAccountId)
    if ('error' in payer) return payer
    if ('error' in payee) return payee
    const input = { fundId, kind: 'management_fee' as const, chargeDate: date, amount: -delta, memo: `${memo} — reduction`, chargeId: ref }
    const mirror = (e: JournalEntry): JournalEntry => ({
      ...e, sourceRef: ref,
      postings: e.postings.map(p => ({ ...p, amount: roundCents(-p.amount) })),
    })
    const spv = await persistEntry(admin, fundId, group, userId, mirror(buildPayerEntry(input, payer)))
    if ('error' in spv) return { error: spv.error }
    const manco = await persistEntry(admin, fundId, payeeName, userId, mirror(buildPayeeEntry(input, payee)))
    if ('error' in manco) {
      const left = await unwindIntercompanyEntry(admin, fundId, spv.entryId)
      return { error: `${payeeName}: ${manco.error}${left ? `. ${left}` : ''}` }
    }
    return { entryId: spv.entryId, delta }
  } catch (e) {
    return { error: (e as Error).message }
  }
}
