import type { SupabaseClient } from '@supabase/supabase-js'
import { listVehiclesWithId, listMancoVehicles, loadLedgerRowsBatch, loadPostedLedger } from './load'
import { trialBalance, scheduleOfInvestments } from './statements'
import { MANCO_KIND } from '@/lib/vehicle-kinds'
import { countUnderived, vehicleNames } from './investment-backfill'

// The firm overview: one row per entity — fund, SPV, GP entity, individual, management company —
// with the state of its books. Where a preparer's "are we ready?" is answered for the whole firm
// at once instead of vehicle by vehicle.

export interface FirmVehicleRow {
  id: string | null
  name: string
  kind: string | null
  /** Latest closed period end, or null when nothing has been closed. */
  closedThrough: string | null
  /** The most recent posted entry, or null on an empty ledger. */
  lastEntryDate: string | null
  /** The earliest posted entry, or null on an empty ledger — which quarters the books reach. */
  firstEntryDate: string | null
  postedEntries: number
  draftEntries: number
  /** Bank rows nobody has categorised or reconciled yet. */
  openBankRows: number
  trialBalanced: boolean
  /** Total debits on the trial balance — the size of the books, as a sanity check. */
  totalDebits: number
  /** Whether the vehicle has any postings at all. */
  empty: boolean
  /** Cash on hand: the balance of every `cash`-subtype account (operating, reserve, …). */
  cash: number
  /** Investments at cost, from the ledger's investment control accounts. */
  investmentsAtCost: number
  /** Investments at carrying value — cost plus the mark plus FX. What the schedule of
   *  investments reports and what portfolio construction plans against. */
  investmentsAtValue: number
  /** Investment transactions not on the ledger yet — the exception report the index shows instead of "—". */
  underivedTransactions: number
}

export interface FirmOverview {
  vehicles: FirmVehicleRow[]
  /** True when the caller may not see management companies, so their rows are omitted. */
  mancoOmitted: boolean
}

export async function loadFirmOverview(
  admin: SupabaseClient,
  fundId: string,
  opts: {
    includeManco: boolean
    /** Count each entity's investment transactions not on the ledger. Costs queries per entity, so only when the page shows it. */
    includeBacklog?: boolean
    /** Which entities the caller may see (entity access). Omitted = all — a server-side caller. */
    visible?: (vehicleId: string | null) => boolean
  },
): Promise<FirmOverview> {
  const vehicles = await listVehiclesWithId(admin, fundId)
  const mancos = opts.includeManco ? await listMancoVehicles(admin, fundId) : []
  const all: { id: string | null; name: string; kind: string | null }[] = [
    ...vehicles,
    ...mancos.map(m => ({ id: m.id, name: m.name, kind: MANCO_KIND as string })),
  ].filter(v => !opts.visible || opts.visible(v.id))

  // Every registered entity's ledger rows in one batch (3 paged reads in all), its counts in one
  // grouped RPC, and the backlog counts alongside — rather than a ledger load and six count queries
  // per entity, entity after entity.
  const ids = all.map(v => v.id).filter((id): id is string => !!id)
  const backlogFor = all.filter(v => opts.includeBacklog && v.id && v.kind !== MANCO_KIND)
  const [ledgerRows, counts, backlog] = await Promise.all([
    loadLedgerRowsBatch(admin, fundId, ids),
    vehicleCounts(admin, fundId, ids),
    mapLimit(backlogFor, BACKLOG_CONCURRENCY, async v => {
      // One entity whose backlog cannot be counted must not fail the whole index: its count reads 0.
      try {
        const names = await vehicleNames(admin, fundId, v.id!, v.name)
        return [v.id!, await countUnderived(admin, fundId, v.id!, names)] as const
      } catch (err) {
        console.error('[firm-load] could not count transactions not on the ledger', v.id, err)
        return [v.id!, 0] as const
      }
    }),
  ])
  const underived = new Map(backlog)

  const rows = await Promise.all(all.map(async v => {
    // A legacy name-only vehicle is not in the batch: its ledger still loads by name, and with
    // nothing to count against, its counts read zero.
    const ledger = v.id
      ? await loadPostedLedger(admin, fundId, v.name, undefined, undefined, ledgerRows.get(v.id))
      : await loadPostedLedger(admin, fundId, v.name)
    const tb = trialBalance(ledger.accounts, ledger.postings)
    // Net assets are only used for the percent-of-net-assets column, which no consumer of this
    // row reads, so 0 is passed rather than computing a balance sheet for every vehicle.
    const soi = scheduleOfInvestments(ledger.accounts, ledger.postings, 0)
    const cashIds = new Set(ledger.accounts.filter(a => a.subtype === 'cash').map(a => a.id))
    const cash = tb.rows.filter(row => cashIds.has(row.accountId)).reduce((sum, row) => sum + row.balance, 0)
    const c = (v.id && counts.get(v.id)) || NO_COUNTS
    const underivedTransactions = (v.id && underived.get(v.id)) || 0
    return {
      id: v.id, name: v.name, kind: v.kind,
      closedThrough: c.closedThrough,
      lastEntryDate: c.lastEntryDate,
      firstEntryDate: c.firstEntryDate,
      postedEntries: c.posted,
      draftEntries: c.drafts,
      openBankRows: c.openBank,
      trialBalanced: tb.balanced,
      totalDebits: tb.totalDebits,
      empty: ledger.postings.length === 0,
      cash,
      investmentsAtCost: soi.totalCost,
      investmentsAtValue: soi.totalFairValue,
      underivedTransactions,
    }
  }))

  return { vehicles: rows, mancoOmitted: !opts.includeManco }
}

interface VehicleCounts {
  closedThrough: string | null
  lastEntryDate: string | null
  firstEntryDate: string | null
  posted: number
  drafts: number
  openBank: number
}

const NO_COUNTS: VehicleCounts = { closedThrough: null, lastEntryDate: null, firstEntryDate: null, posted: 0, drafts: 0, openBank: 0 }

/** Each entity's counts, by id, from one grouped query (firm_vehicle_counts, 20261014182000). A
 *  failed read throws: zero drafts and no open bank rows would read as "all clear". */
async function vehicleCounts(admin: SupabaseClient, fundId: string, vehicleIds: string[]): Promise<Map<string, VehicleCounts>> {
  // The RPC returns one row per id, and PostgREST caps any response at max_rows (1,000), so the
  // ids go in chunks well under it — a firm can have more entities than that.
  const chunks: string[][] = []
  for (let i = 0; i < vehicleIds.length; i += COUNTS_CHUNK) chunks.push(vehicleIds.slice(i, i + COUNTS_CHUNK))
  const results = await Promise.all(chunks.map(chunk =>
    admin.rpc('firm_vehicle_counts' as any, { p_fund_id: fundId, p_vehicle_ids: chunk } as any)))
  const out = new Map<string, VehicleCounts>()
  for (const { data, error } of results) {
    if (error) throw new Error(`firm_vehicle_counts: ${error.message}`)
    for (const r of (data as any[]) ?? []) {
      out.set(r.vehicle_id, {
        closedThrough: r.closed_through ?? null,
        lastEntryDate: r.last_entry_date ?? null,
        firstEntryDate: r.first_entry_date ?? null,
        posted: Number(r.posted_entries ?? 0),
        drafts: Number(r.draft_entries ?? 0),
        openBank: Number(r.open_bank_rows ?? 0),
      })
    }
  }
  // Every requested id comes back, even with nothing on its books. One that did not was cut off,
  // and showing it as zeros would make it look clear.
  const missing = vehicleIds.filter(id => !out.has(id))
  if (missing.length > 0) throw new Error(`firm_vehicle_counts: no row for ${missing.length} of ${vehicleIds.length} entities`)
  return out
}

const COUNTS_CHUNK = 200

// Backlog counts are a few queries per entity; a handful at a time keeps a large firm from opening
// every one at once.
const BACKLOG_CONCURRENCY = 5

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}
