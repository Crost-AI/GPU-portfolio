import type { SupabaseClient } from '@supabase/supabase-js'
import { listFirmEntities, type FirmEntity, type FirmEntityScope } from './firm-entities'
import { ACTUAL_BOOK } from './books'
import { expectedClosedThrough } from './attention'

// THE CLOSE CALENDAR: every entity down, the recent quarter-ends across, and whether each quarter
// is closed. The /funds/periods landing — which used to be a list of entities with a "closed
// through" date each, so seeing which quarter was behind where meant reading dates row by row.

/** How many quarter-ends the grid shows, ending at the latest one that has passed. */
export const CLOSE_GRID_QUARTERS = 8

/**
 * One cell.
 *   closed   — a closed period covers the quarter-end.
 *   reopened — a period covering it exists but is open again.
 *   late     — not closed, the books reach the quarter, and its grace has passed.
 *   due      — not closed, the books reach it, still within the grace.
 *   none     — the books do not reach it (no entries on or before the quarter-end).
 */
export type CloseCell = 'closed' | 'reopened' | 'late' | 'due' | 'none'

export interface ClosePeriod { start: string; end: string; status: string }

export interface CloseGridRow extends FirmEntity {
  firstEntryDate: string | null
  cells: CloseCell[]
}

export interface CloseGrid {
  /** Quarter-ends, oldest first, as YYYY-MM-DD. */
  quarters: string[]
  /** The latest quarter-end that counts as late when it is not closed. */
  expected: string
  rows: CloseGridRow[]
  mancoOmitted: boolean
}

const iso = (d: Date) => d.toISOString().slice(0, 10)

/** The last `n` quarter-ends on or before `today`, oldest first. */
export function recentQuarterEnds(today: Date, n = CLOSE_GRID_QUARTERS): string[] {
  const out: string[] = []
  // The quarter-end before the current quarter starts is the latest that has passed — or today
  // itself when today IS a quarter-end, which is handled by starting from tomorrow.
  const t = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1))
  let y = t.getUTCFullYear()
  let q = Math.floor(t.getUTCMonth() / 3)
  for (let i = 0; i < n; i++) {
    out.unshift(iso(new Date(Date.UTC(y, q * 3, 0))))
    q -= 1
    if (q < 0) { q = 3; y -= 1 }
  }
  return out
}

/** One entity's state for one quarter-end. Pure, so the rules are testable. */
export function closeCell(periods: ClosePeriod[], firstEntryDate: string | null, quarterEnd: string, expected: string): CloseCell {
  const covering = periods.filter(p => p.start <= quarterEnd && quarterEnd <= p.end)
  if (covering.some(p => p.status === 'closed')) return 'closed'
  // A later closed period does not close an earlier quarter: closes are per period, and a gap is
  // exactly what this grid exists to show.
  if (covering.length > 0) return 'reopened'
  if (!firstEntryDate || firstEntryDate > quarterEnd) return 'none'
  return quarterEnd <= expected ? 'late' : 'due'
}

export async function loadCloseGrid(admin: SupabaseClient, fundId: string, opts: FirmEntityScope, today = new Date()): Promise<CloseGrid> {
  const entities = await listFirmEntities(admin, fundId, opts)
  const quarters = recentQuarterEnds(today)
  const expected = expectedClosedThrough(today)
  if (entities.length === 0) return { quarters, expected, rows: [], mancoOmitted: !opts.includeManco }
  const ids = entities.map(e => e.id)

  const [{ data: periodRows, error }, firsts] = await Promise.all([
    admin.from('fiscal_periods' as any).select('vehicle_id, period_start, period_end, status')
      .eq('fund_id', fundId).in('vehicle_id', ids).gte('period_end', quarters[0]),
    Promise.all(ids.map(async id => {
      const { data } = await admin.from('journal_entries' as any).select('entry_date')
        .eq('book', ACTUAL_BOOK).eq('fund_id', fundId).eq('vehicle_id', id).eq('status', 'posted')
        .order('entry_date', { ascending: true }).limit(1)
      return [id, ((data as any[]) ?? [])[0]?.entry_date ?? null] as const
    })),
  ])
  if (error) throw new Error(error.message)

  const byVehicle = new Map<string, ClosePeriod[]>()
  for (const p of (periodRows as any[]) ?? []) {
    const list = byVehicle.get(p.vehicle_id) ?? []
    list.push({ start: p.period_start, end: p.period_end, status: p.status })
    byVehicle.set(p.vehicle_id, list)
  }
  const first = new Map(firsts)
  const rows = entities.map(e => {
    const firstEntryDate = first.get(e.id) ?? null
    const periods = byVehicle.get(e.id) ?? []
    return { ...e, firstEntryDate, cells: quarters.map(q => closeCell(periods, firstEntryDate, q, expected)) }
  })
  return { quarters, expected, rows, mancoOmitted: !opts.includeManco }
}
