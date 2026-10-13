import type { SupabaseClient } from '@supabase/supabase-js'
import { listFirmEntities, type FirmEntity, type FirmEntityScope } from './firm-entities'
import { ACTUAL_BOOK } from './books'

// THE FIRM-WIDE DRAFTS QUEUE: every draft journal entry across the entities the caller may see,
// for the /funds/journal landing. Posting and discarding happen in place, through the journal's
// own bulk routes (one entry at a time, with that entity named), so the guards are the ones the
// journal page already runs: balanced, not in a closed period, investments only with the grant.

export interface FirmDraft {
  id: string
  vehicleId: string
  entryDate: string
  memo: string
  sourceType: string | null
  /** The entry's size: the sum of its debits. */
  amount: number
  /** Debits minus credits, so an entry that would be refused for not balancing says so up front. */
  imbalance: number
  lines: number
}

export interface FirmDraftEntity extends FirmEntity { drafts: number }

export interface FirmDrafts {
  entities: FirmDraftEntity[]
  drafts: FirmDraft[]
  truncated: boolean
  mancoOmitted: boolean
}

export const FIRM_DRAFT_LIMIT = 500

const cents = (n: number) => Math.round(n * 100) / 100

/** An entry's debits and its imbalance, from its postings. Pure, so it is testable. */
export function draftTotals(postings: { amount: number | string }[]): { amount: number; imbalance: number } {
  let debit = 0
  let net = 0
  for (const p of postings) {
    const a = Number(p.amount)
    if (a > 0) debit += a
    net += a
  }
  return { amount: cents(debit), imbalance: cents(net) }
}

export async function loadFirmDrafts(admin: SupabaseClient, fundId: string, opts: FirmEntityScope): Promise<FirmDrafts> {
  const entities = await listFirmEntities(admin, fundId, opts)
  if (entities.length === 0) return { entities: [], drafts: [], truncated: false, mancoOmitted: !opts.includeManco }
  const ids = entities.map(e => e.id)

  const [{ data, error }, counts] = await Promise.all([
    admin.from('journal_entries' as any)
      .select('id, vehicle_id, entry_date, memo, source_type, journal_postings(amount)')
      .eq('book', ACTUAL_BOOK).eq('fund_id', fundId).in('vehicle_id', ids).eq('status', 'draft')
      .order('entry_date', { ascending: false })
      .limit(FIRM_DRAFT_LIMIT + 1),
    Promise.all(ids.map(async id => {
      const { count } = await admin.from('journal_entries' as any).select('id', { count: 'exact', head: true })
        .eq('book', ACTUAL_BOOK).eq('fund_id', fundId).eq('vehicle_id', id).eq('status', 'draft')
      return [id, count ?? 0] as const
    })),
  ])
  if (error) throw new Error(error.message)

  const raw = (data as any[]) ?? []
  const drafts: FirmDraft[] = raw.slice(0, FIRM_DRAFT_LIMIT).map(r => {
    const postings = (r.journal_postings as { amount: number | string }[]) ?? []
    return {
      id: r.id, vehicleId: r.vehicle_id, entryDate: r.entry_date,
      memo: r.memo ?? '', sourceType: r.source_type ?? null,
      ...draftTotals(postings), lines: postings.length,
    }
  })
  const count = new Map(counts)
  return {
    entities: entities.map(e => ({ ...e, drafts: count.get(e.id) ?? 0 })),
    drafts,
    truncated: raw.length > FIRM_DRAFT_LIMIT,
    mancoOmitted: !opts.includeManco,
  }
}
