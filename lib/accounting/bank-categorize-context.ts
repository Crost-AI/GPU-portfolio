// Gathers what `categorizeBankRow` reads: the entity's own chart, the other vehicles in the fund
// (the far side of a transfer), and how this entity's earlier bank rows were actually booked.
// Shared by the import, the duplicate-review route and the AI pass, so all three suggest from
// the same evidence.

import type { SupabaseClient } from '@supabase/supabase-js'
import { vehicleIdByName } from './vehicle-id'
import { readAll } from './bank-quickbooks-match'
import { ACTUAL_BOOK } from './books'
import { payeeKey, type Affiliate, type CategorizeContext, type ChartAccountRef, type HistoryEntry } from './bank-categorize'

export interface LoadedCategorizeContext extends CategorizeContext {
  vehicleId: string | null
}

/** A bank row as stored, with the fields history needs. */
export interface StoredBankRow {
  amount: number | string
  description: string | null
  counterparty: string | null
  status: string
  journal_entry_id: string | null
  raw: any
}

/** Who chose a stored row's account — what the import, the AI pass or a person recorded. */
export function categorizedBy(raw: any): string | null {
  return typeof raw?.categorization?.by === 'string' ? raw.categorization.by : null
}

function countsAsHistory(r: StoredBankRow): boolean {
  if (!r.journal_entry_id) return false
  if (r.raw?.investmentReview || r.raw?.quickbooksReview) return false
  return r.status === 'reconciled' || (r.status === 'drafted' && categorizedBy(r.raw) === 'user')
}

/**
 * Turn stored bank rows into history, given what each row's entry ACTUALLY posts to.
 *
 * The ledger is the truth, not `suggested_account_code`: editing an entry in the journal changes
 * its postings and never touches that column. Only rows a person has stood behind count — posted
 * (reconciled), or re-pointed by hand while still a draft. Rows linked to an investment or a
 * QuickBooks entry are left out: their entry was not booked from the bank line, so it says
 * nothing about what the bank line means.
 */
export function historyFromRows(
  rows: StoredBankRow[],
  accountOfEntry: Map<string, string>,
): HistoryEntry[] {
  const out: HistoryEntry[] = []
  for (const r of rows) {
    if (!countsAsHistory(r)) continue
    const chosen = categorizedBy(r.raw) === 'user'
    const code = accountOfEntry.get(r.journal_entry_id!)
    const payee = payeeKey(r)
    if (!code || !payee) continue
    out.push({ payee, inflow: Number(r.amount) >= 0, accountCode: code, chosen })
  }
  return out
}

export async function loadCategorizeContext(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  /** The vehicle's stored bank rows, when the caller has already read them. */
  rows?: StoredBankRow[],
): Promise<LoadedCategorizeContext> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  if (!vehicleId) return { vehicleId: null, chart: [], affiliates: [], history: [] }

  const [{ data: chartRows, error: chartError }, { data: vehicles, error: vehicleError }, stored] = await Promise.all([
    admin.from('chart_of_accounts' as any).select('id, code, name, type, subtype, lp_entity_id')
      .eq('fund_id', fundId).eq('vehicle_id', vehicleId),
    (admin as any).from('fund_vehicles').select('id, name, aliases').eq('fund_id', fundId),
    rows ? Promise.resolve(rows) : readAll<StoredBankRow>((from, to) => admin.from('bank_transactions' as any)
      .select('amount, description, counterparty, status, journal_entry_id, raw')
      .eq('fund_id', fundId).eq('vehicle_id', vehicleId).in('status', ['reconciled', 'drafted'])
      .order('id').range(from, to) as any),
  ])
  if (chartError) throw new Error(chartError.message)
  if (vehicleError) throw new Error(vehicleError.message)

  const accounts = ((chartRows as any[]) ?? [])
  const chart: ChartAccountRef[] = accounts.map(a => ({
    code: a.code, name: a.name, type: a.type, subtype: a.subtype ?? null, lpEntityId: a.lp_entity_id ?? null,
  }))
  const affiliates: Affiliate[] = (((vehicles as any[]) ?? []))
    .filter(v => v.id !== vehicleId)
    .map(v => ({ vehicleId: v.id, names: [v.name, ...((v.aliases as string[] | null) ?? [])].filter(Boolean) }))

  // What each candidate entry posts to: its single non-cash account, when it has exactly one and
  // it names no partner. A split entry or a partner settlement is not a pattern to repeat.
  const byId = new Map(accounts.map(a => [a.id as string, a]))
  const entryIds = Array.from(new Set(stored.filter(countsAsHistory).map(r => r.journal_entry_id as string)))
  const accountOfEntry = new Map<string, string>()
  const nonCash = new Map<string, Set<string> | 'skip'>()
  for (let i = 0; i < entryIds.length; i += 200) {
    const { data: postings, error } = await admin.from('journal_postings' as any)
      .select('journal_entry_id, account_id, lp_entity_id')
      .eq('book', ACTUAL_BOOK).eq('fund_id', fundId).in('journal_entry_id', entryIds.slice(i, i + 200))
    if (error) throw new Error(error.message)
    for (const p of ((postings as any[]) ?? [])) {
      const acct = byId.get(p.account_id)
      if (!acct || acct.subtype === 'cash') continue
      if (p.lp_entity_id || acct.lp_entity_id) { nonCash.set(p.journal_entry_id, 'skip'); continue }
      const seen = nonCash.get(p.journal_entry_id)
      if (seen === 'skip') continue
      nonCash.set(p.journal_entry_id, (seen ?? new Set<string>()).add(acct.code))
    }
  }
  for (const [entryId, codes] of Array.from(nonCash.entries())) {
    if (codes !== 'skip' && codes.size === 1) accountOfEntry.set(entryId, Array.from(codes)[0])
  }

  return { vehicleId, chart, affiliates, history: historyFromRows(stored, accountOfEntry) }
}
