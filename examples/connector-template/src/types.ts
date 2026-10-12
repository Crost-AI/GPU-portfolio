/**
 * What a connector hands the app: journal transactions in the shape Portfolio's `import_journal`
 * tool takes. One transaction is one balanced double-entry event; debits and credits are positive
 * magnitudes, as QuickBooks prints them. The app re-checks balance, so a broken one is named and
 * dropped there rather than imported.
 */
export interface JournalLine {
  /** The SOURCE's account name. The app maps it onto its own chart, once, and remembers. */
  account: string
  /** Payee, vendor or partner. An LP's name on a capital line routes it to that partner. */
  name?: string | null
  memo?: string | null
  debit?: number
  credit?: number
}

export interface JournalTransaction {
  /** YYYY-MM-DD */
  date: string
  type?: string | null
  /** The source's id for this transaction. Part of the idempotency key: keep it stable. */
  num?: string | null
  memo?: string | null
  lines: JournalLine[]
}

/** The books the app knows how to tag (Portfolio's lib/accounting/quickbooks/sources.ts). */
export type JournalSource = 'quickbooks' | 'carta'

export interface Window {
  /** Inclusive, YYYY-MM-DD. */
  from: string
  /** Inclusive, YYYY-MM-DD. */
  to: string
}

export interface ConnectorContext {
  window: Window
  /** Durable key/value store for this connector: cursors, tokens. See state.ts. */
  state: StateStore
  log: (message: string) => void
}

export interface StateStore {
  get<T>(key: string): Promise<T | undefined>
  set<T>(key: string, value: T): Promise<void>
}

export interface Connector {
  /** Used on the command line: `npm run sync -- <id>`. */
  id: string
  /** Whose books this is. Decides which account mapping the app uses. */
  source: JournalSource
  description: string
  /**
   * Read the source for one date window and yield transactions in batches. Yield as you page
   * through the source; the runner sends each batch as it arrives, so a large history never has to
   * fit in memory or in one request.
   *
   * Pull is READ-ONLY against the source. Connectors never write back to QuickBooks or Carta.
   */
  pull(ctx: ConnectorContext): AsyncIterable<JournalTransaction[]>
  /** One-time interactive sign-in for sources that need it (OAuth). */
  login?(ctx: Omit<ConnectorContext, 'window'>): Promise<void>
}
