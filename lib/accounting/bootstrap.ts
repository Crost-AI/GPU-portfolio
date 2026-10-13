// Cutover bootstrap: generate a vehicle's opening capital from the LP data already in the platform
// (paid-in − distributions per LP) as of a date, booked as a posted opening-balance entry. Shared by
// the /api/accounting/bootstrap route (manual date) and the one-click turn-on flow (latest snapshot).

import type { SupabaseClient } from '@supabase/supabase-js'
import { vehicleIdByName } from './vehicle-id'
import { loadOwnership } from './load'
import { accountIdByCode, ensureCapitalAccounts, persistEntry } from './persist'
import { chartForVehicleKind } from './chart'
import { vehicleKindByName } from './vehicle-domain'
import { roundCents } from './ledger'
import type { Posting, JournalEntry } from './types'
import { ACTUAL_BOOK } from './books'

/** The source_ref of a vehicle's partner opening entry (one live per date, by unique index). */
export const PARTNER_OPENING_REF = 'partner-opening'

export async function bootstrapOpeningBalances(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  userId: string | null,
  entryDate: string,
): Promise<{ ok: true; entryId: string; lpCount: number; total: number } | { error: string }> {
  // Seed the chart for this vehicle's KIND if it has none. This used to seed DEFAULT_CHART
  // whatever the kind, which handed a GP entity a fund's chart on its first bootstrap.
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  let codes = await accountIdByCode(admin, fundId, group)
  if (codes.size === 0) {
    const kind = await vehicleKindByName(admin, fundId, group)
    const rows = chartForVehicleKind(kind).map(a => ({ fund_id: fundId, portfolio_group: group, vehicle_id: vehicleId, code: a.code, name: a.name, type: a.type, subtype: a.subtype ?? null }))
    await admin.from('chart_of_accounts' as any).insert(rows)
    codes = await accountIdByCode(admin, fundId, group)
  }

  const ownership = await loadOwnership(admin, fundId, group)
  const balances = ownership
    .map(o => ({ lpEntityId: o.lpEntityId, amount: roundCents(o.paidIn - o.distributions) }))
    .filter(b => b.amount !== 0)
  if (balances.length === 0) {
    return { error: 'No LP paid-in capital found for this vehicle — nothing to bootstrap' }
  }

  // NEVER TWICE. This used to post with no source_ref and no check at all, so a second run — a
  // retry, a second tab, a second chat — booked every partner's opening capital again. Refuse when
  // any of these partners already has capital on this vehicle's books (the opening-balances route
  // asks the same question), naming the entry, so a legacy bootstrap with no ref is caught too.
  // A failed read refuses: it must never look like "nothing booked yet".
  if (!vehicleId) return { error: `Unknown vehicle "${group}" — add it in Settings before booking to it.` }
  const { data: overlap, error: overlapError } = await admin.from('journal_postings' as any)
    .select('journal_entry_id, journal_entries!inner(status)')
    .eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('book', ACTUAL_BOOK)
    .neq('journal_entries.status', 'void')
    .in('lp_entity_id', balances.map(b => b.lpEntityId)).limit(1)
  if (overlapError) return { error: `Could not check for opening capital already in the books: ${overlapError.message}` }
  const already = ((overlap as any[]) ?? [])[0]
  if (already) {
    return { error: `These partners already have capital entries on this vehicle (entry ${already.journal_entry_id}). Bootstrapping would book their opening capital twice — nothing was posted. Void that entry first if it is wrong.` }
  }

  // Capital in nets against cash: the opening credits each LP's capital and debits Cash. The
  // investment purchase is booked separately (Dr Investments / Cr Cash).
  const offsetId = codes.get('1000')
  if (!offsetId) return { error: 'Chart missing account 1000 (Cash)' }
  const capMap = await ensureCapitalAccounts(admin, fundId, group, balances.map(b => b.lpEntityId))

  let total = 0
  const postings: Posting[] = []
  for (const b of balances) {
    total = roundCents(total + b.amount)
    postings.push({ accountId: capMap.get(b.lpEntityId)!, amount: -b.amount, currency: 'USD', lpEntityId: b.lpEntityId })
  }
  postings.push({ accountId: offsetId, amount: total, currency: 'USD', lpEntityId: null })

  // `partner-opening`, the opening-balances route's ref, so the unique index
  // journal_entries_partner_opening_once_per_date refuses a concurrent second copy on this date
  // (persistEntry names the entry that won).
  const entry: JournalEntry = { fundId, entryDate, memo: 'Opening capital bootstrapped from LP data', sourceType: 'opening_balance', sourceRef: PARTNER_OPENING_REF, postings }
  const result = await persistEntry(admin, fundId, group, userId, entry, 'posted')
  if ('error' in result) return { error: result.error }

  return { ok: true, entryId: result.entryId, lpCount: balances.length, total }
}
