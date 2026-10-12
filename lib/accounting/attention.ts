// What the Financials overview lists under "Needs attention": every entity with something waiting
// on its books, and for each, the items with the page that clears them.
//
// Built from the firm-wide state of the books (`FirmVehicleRow`), which the section landings
// already load, so the overview asks for nothing new. Dependency-free so the client page and the
// tests share it.

import type { FirmVehicleRow } from './firm-load'

export type AttentionKind = 'drafts' | 'bank' | 'ties' | 'backlog' | 'close'

export interface AttentionItem {
  kind: AttentionKind
  label: string
  /** The entity subpage that clears it, relative to `/funds/<id>`. */
  href: string
}

export interface EntityAttention {
  row: FirmVehicleRow
  items: AttentionItem[]
}

/**
 * How long after a quarter ends before it counts as late to close. Without a grace, every entity
 * would be flagged on the first day of every quarter, which is when nobody can have closed yet.
 */
export const CLOSE_GRACE_DAYS = 45

const iso = (d: Date) => d.toISOString().slice(0, 10)

/** The latest quarter-end that is at least CLOSE_GRACE_DAYS before `today`, as YYYY-MM-DD. */
export function expectedClosedThrough(today: Date): string {
  // The day after the cutoff: the quarter-end before ITS quarter starts is the latest one on or
  // before the cutoff, including a cutoff that falls on a quarter-end itself.
  const after = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - CLOSE_GRACE_DAYS + 1))
  const q = Math.floor(after.getUTCMonth() / 3)
  return iso(new Date(Date.UTC(after.getUTCFullYear(), q * 3, 0)))
}

/** "Q2 2026" for a quarter-end date. */
export function quarterLabel(periodEnd: string): string {
  const [y, m] = periodEnd.split('-').map(Number)
  return `Q${Math.ceil(m / 3)} ${y}`
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** The items waiting on one entity, most urgent first. Empty when its books are up to date. */
export function attentionFor(row: FirmVehicleRow, today: Date): AttentionItem[] {
  const items: AttentionItem[] = []
  if (!row.empty && !row.trialBalanced) {
    items.push({ kind: 'ties', label: 'Trial balance does not tie', href: '/statements' })
  }
  if (row.openBankRows > 0) {
    items.push({ kind: 'bank', label: plural(row.openBankRows, 'bank row to reconcile', 'bank rows to reconcile'), href: '/bank' })
  }
  if (row.draftEntries > 0) {
    items.push({ kind: 'drafts', label: plural(row.draftEntries, 'draft waiting', 'drafts waiting'), href: '/journal?status=draft' })
  }
  if (row.underivedTransactions > 0) {
    items.push({
      kind: 'backlog',
      label: plural(row.underivedTransactions, 'investment transaction not on the ledger', 'investment transactions not on the ledger'),
      href: '/status#book-investments',
    })
  }
  // Only an entity with books can be behind on closing them, and only for a quarter its books
  // reach: an entity whose first entry is after the quarter-end has nothing to close for it.
  const expected = expectedClosedThrough(today)
  if (!row.empty && row.firstEntryDate && row.firstEntryDate <= expected && (!row.closedThrough || row.closedThrough < expected)) {
    items.push({ kind: 'close', label: `${quarterLabel(expected)} not closed`, href: '/periods' })
  }
  return items
}

/** Every entity with something waiting, in the order given. */
export function firmAttention(rows: FirmVehicleRow[], today: Date): EntityAttention[] {
  return rows
    .map(row => ({ row, items: attentionFor(row, today) }))
    .filter(e => e.items.length > 0)
}
