/**
 * The outside books a journal can be imported from.
 *
 * QuickBooks came first, which is why the tables and this folder say "qb". Carta's fund-admin
 * general ledger has the same shape: a stream of balanced, double-entry transactions against an
 * outside chart that has to be mapped onto ours. So it uses the same mapping, the same draft
 * import and the same review, with its own provenance.
 *
 * `source` is what keeps them apart. It becomes the entry's `source_type`, prefixes its
 * idempotency `source_ref`, and scopes the saved account mapping. Without it, a Carta account
 * that happened to share a name with a QuickBooks account would silently take the QuickBooks
 * mapping, and an entry imported from one could be matched as a re-import of the other.
 *
 * Adding a source is a line here. Connectors live outside this repo; all the app needs to know is
 * what to call the books and how to tag what came from them.
 */

export const JOURNAL_SOURCES = {
  quickbooks: { label: 'QuickBooks', refPrefix: 'qb' },
  carta: { label: 'Carta', refPrefix: 'carta' },
} as const

export type JournalSource = keyof typeof JOURNAL_SOURCES

export const JOURNAL_SOURCE_NAMES = Object.keys(JOURNAL_SOURCES) as JournalSource[]

/**
 * `source_type`s that mean "imported from an outside book of record". These entries get the
 * treatment QuickBooks entries always had: the LP roll-forward classifies their simple cash/capital
 * exchanges, and the bank import matches bank rows against their cash lines instead of drafting a
 * second entry for the same money.
 */
export const EXTERNAL_BOOK_SOURCE_TYPES: string[] = [...JOURNAL_SOURCE_NAMES]

export function isExternalBookSource(sourceType: string | null | undefined): boolean {
  return !!sourceType && (EXTERNAL_BOOK_SOURCE_TYPES as string[]).includes(sourceType)
}

/** Parse a caller-supplied source; anything unrecognised is an error, never a silent default. */
export function journalSource(raw: unknown): JournalSource {
  if (raw === undefined || raw === null || raw === '') return 'quickbooks'
  if (typeof raw === 'string' && raw in JOURNAL_SOURCES) return raw as JournalSource
  throw new Error(`Unknown journal source "${String(raw)}". Expected one of: ${JOURNAL_SOURCE_NAMES.join(', ')}.`)
}
