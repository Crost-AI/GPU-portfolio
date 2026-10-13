import type { SupabaseClient } from '@supabase/supabase-js'
import { listFirmEntities, type FirmEntityScope } from './firm-entities'

// THE FIRM-WIDE BANK QUEUE: every open bank row across every entity the caller may see, and a
// summary per entity, for the /funds/bank landing.
//
// That landing used to be a list of doors — name, open count, cash, Open — so the question it
// was asked ("what is waiting to be reconciled?") took one visit per entity to answer. The rows
// themselves are acted on where they always were, on the entity's own bank page: booking a row
// needs that entity's chart, its closed periods and its duplicate checks, and a second copy of
// that machinery here would be a second place for it to go wrong. Each row here links there.

/** Bank rows nobody has categorised or reconciled yet — the same statuses the firm overview counts. */
export const OPEN_BANK_STATUSES = ['unmatched', 'drafted'] as const

export interface FirmBankRow {
  id: string
  vehicleId: string
  txnDate: string
  amount: number
  description: string
  counterparty: string | null
  status: string
  suggestedAccountCode: string | null
}

export interface FirmBankEntity {
  id: string
  name: string
  kind: string | null
  openRows: number
  /** Money in and out across the open rows, kept apart: netting them would hide both. */
  openIn: number
  openOut: number
  oldestOpen: string | null
  /** When a feed was last imported for it — staleness is the other thing a bank landing is for. */
  lastImported: string | null
  /** Rows on record at all; an entity with none has never had a feed. */
  everImported: boolean
}

export interface FirmBank {
  entities: FirmBankEntity[]
  rows: FirmBankRow[]
  /** True when more open rows exist than were returned. */
  truncated: boolean
  mancoOmitted: boolean
}

/** Cap on rows returned; the per-entity counts are exact regardless. */
export const FIRM_BANK_ROW_LIMIT = 1000

/** Fold the open rows into one summary per entity. Pure, so the counting is testable. */
export function summarizeOpenRows(
  entities: { id: string; name: string; kind: string | null }[],
  rows: FirmBankRow[],
  imports: Map<string, { last: string | null; any: boolean }>,
): FirmBankEntity[] {
  return entities.map(e => {
    const mine = rows.filter(r => r.vehicleId === e.id)
    const imp = imports.get(e.id)
    return {
      id: e.id, name: e.name, kind: e.kind,
      openRows: mine.length,
      openIn: mine.reduce((s, r) => s + (r.amount > 0 ? r.amount : 0), 0),
      openOut: mine.reduce((s, r) => s + (r.amount < 0 ? -r.amount : 0), 0),
      oldestOpen: mine.reduce<string | null>((min, r) => (min && min < r.txnDate ? min : r.txnDate), null),
      lastImported: imp?.last ?? null,
      everImported: imp?.any ?? false,
    }
  })
}

export async function loadFirmBank(
  admin: SupabaseClient,
  fundId: string,
  opts: FirmEntityScope,
): Promise<FirmBank> {
  const entities = await listFirmEntities(admin, fundId, opts)
  if (entities.length === 0) return { entities: [], rows: [], truncated: false, mancoOmitted: !opts.includeManco }
  const ids = entities.map(e => e.id)

  const { data, error } = await admin
    .from('bank_transactions' as any)
    .select('id, vehicle_id, txn_date, amount, description, counterparty, status, suggested_account_code')
    .eq('fund_id', fundId)
    .in('vehicle_id', ids)
    .in('status', OPEN_BANK_STATUSES as unknown as string[])
    .order('txn_date', { ascending: true })
    .limit(FIRM_BANK_ROW_LIMIT + 1)
  if (error) throw new Error(error.message)
  const raw = (data as any[]) ?? []
  const truncated = raw.length > FIRM_BANK_ROW_LIMIT
  const rows: FirmBankRow[] = raw.slice(0, FIRM_BANK_ROW_LIMIT).map(r => ({
    id: r.id, vehicleId: r.vehicle_id, txnDate: r.txn_date, amount: Number(r.amount),
    description: r.description ?? '', counterparty: r.counterparty ?? null, status: r.status,
    suggestedAccountCode: r.suggested_account_code ?? null,
  }))

  // Exact open counts and the latest import, per entity. Counted separately so a truncated row
  // list never understates what an entity has waiting.
  const [counts, imports] = await Promise.all([
    Promise.all(ids.map(async id => {
      const { count } = await admin.from('bank_transactions' as any).select('id', { count: 'exact', head: true })
        .eq('fund_id', fundId).eq('vehicle_id', id).in('status', OPEN_BANK_STATUSES as unknown as string[])
      return [id, count ?? 0] as const
    })),
    Promise.all(ids.map(async id => {
      const { data: last } = await admin.from('bank_transactions' as any).select('created_at')
        .eq('fund_id', fundId).eq('vehicle_id', id).order('created_at', { ascending: false }).limit(1)
      const at = ((last as any[]) ?? [])[0]?.created_at ?? null
      return [id, { last: at ? String(at).slice(0, 10) : null, any: !!at }] as const
    })),
  ])

  const summary = summarizeOpenRows(entities, rows, new Map(imports))
  const exact = new Map(counts)
  for (const s of summary) s.openRows = exact.get(s.id) ?? s.openRows
  return { entities: summary, rows, truncated, mancoOmitted: !opts.includeManco }
}
