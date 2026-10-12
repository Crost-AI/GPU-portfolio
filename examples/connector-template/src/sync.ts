import type { Connector, JournalTransaction, StateStore, Window } from './types.js'
import type { ImportResult, PortfolioClient } from './portfolio.js'

/**
 * Run one connector over one window: pull batches from the source, send each to Portfolio as
 * drafts, and keep a running tally.
 *
 * Why it is safe to run on a schedule with overlapping windows: the app keys every imported entry
 * by a content hash (source_ref), so a transaction sent twice is matched, not duplicated. The
 * default window therefore re-reads a margin before the last cursor, which is what catches
 * back-dated entries and late edits at the source.
 *
 * What it will NOT do on its own: confirm a review hold. If the app's comparison with the
 * investment and LP records finds differences, nothing is written and the run stops, naming them.
 * A person looks, then re-runs with --review-token. A scheduler must never be the one to say yes.
 */

/** Small enough to stay well under a serverless request-body limit; big enough to be quick. */
export const BATCH_SIZE = 200

/** Days re-read before the last cursor on each run, to catch back-dated entries. */
export const OVERLAP_DAYS = 45

export interface SyncOptions {
  window?: Partial<Window>
  dryRun?: boolean
  reviewToken?: string
  log?: (message: string) => void
}

export interface SyncSummary {
  window: Window
  batches: number
  sent: number
  created: number
  alreadyPresent: number
  skipped: number
  errors: string[]
  capitalWarnings: string[]
  /** Set when the app held the import for review. Nothing after the held batch was sent. */
  reviewRequired?: { token: string; differences: string[] }
}

const iso = (d: Date) => d.toISOString().slice(0, 10)
const addDays = (date: string, days: number) => iso(new Date(Date.parse(date + 'T00:00:00Z') + days * 86_400_000))

/** The window to read: explicit dates win; otherwise from (last cursor − overlap) to today. */
export async function resolveWindow(state: StateStore, requested: Partial<Window> = {}, today = iso(new Date())): Promise<Window> {
  const cursor = await state.get<string>('cursor')
  const from = requested.from ?? (cursor ? addDays(cursor, -OVERLAP_DAYS) : addDays(today, -365))
  return { from, to: requested.to ?? today }
}

export async function rebatch(source: AsyncIterable<JournalTransaction[]>, size = BATCH_SIZE): Promise<AsyncIterable<JournalTransaction[]>> {
  return (async function* () {
    let buf: JournalTransaction[] = []
    for await (const page of source) {
      buf.push(...page)
      while (buf.length >= size) yield buf.splice(0, size)
    }
    if (buf.length) yield buf
  })()
}

export async function runSync(connector: Connector, portfolio: Pick<PortfolioClient, 'importJournal'>, state: StateStore, opts: SyncOptions = {}): Promise<SyncSummary> {
  const log = opts.log ?? (() => {})
  const window = await resolveWindow(state, opts.window)
  log(`${connector.id}: ${window.from} → ${window.to}${opts.dryRun ? ' (dry run)' : ''}`)

  const summary: SyncSummary = { window, batches: 0, sent: 0, created: 0, alreadyPresent: 0, skipped: 0, errors: [], capitalWarnings: [] }
  const label = `${connector.id} ${window.from}..${window.to}`

  for await (const batch of await rebatch(connector.pull({ window, state, log }))) {
    const result: ImportResult = await portfolio.importJournal(connector.source, batch, { dryRun: opts.dryRun, reviewToken: opts.reviewToken, sourceLabel: label })
    summary.batches += 1
    summary.sent += batch.length

    if (result.reviewRequired && result.importReview) {
      summary.reviewRequired = {
        token: result.importReview.token,
        differences: result.importReview.differences.map(d => d.message ?? [d.name, d.metric].filter(Boolean).join(' ')),
      }
      log(`held for review: ${result.error ?? ''}`)
      return summary   // do not advance the cursor: this window has not been imported
    }

    summary.created += result.created ?? result.wouldCreate ?? 0
    summary.alreadyPresent += result.alreadyPresent ?? 0
    summary.skipped += result.skipped ?? 0
    summary.errors.push(...(result.errors ?? []))
    summary.capitalWarnings.push(...(result.capitalWarnings ?? []))
    log(`batch ${summary.batches}: ${batch.length} sent, ${result.created ?? result.wouldCreate ?? 0} new, ${result.alreadyPresent ?? 0} already there, ${result.skipped ?? 0} skipped`)
  }

  // Advance only after a real, complete run. Skipped transactions (an unmapped account, a closed
  // period) are named in `errors` and are picked up again by the overlap once they are fixed.
  if (!opts.dryRun) await state.set('cursor', window.to)
  return summary
}
