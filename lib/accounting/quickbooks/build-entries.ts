import { matchQbLp, type QbLpTarget } from './match-lp'
import { createHash } from 'crypto'
import type { QbTransaction } from './parse-journal'
import type { JournalEntry, Posting } from '@/lib/accounting/types'
import { JOURNAL_SOURCES, type JournalSource } from './sources'

/**
 * QuickBooks transactions + a confirmed mapping → journal entries. Pure.
 *
 * IDEMPOTENCE is the whole design constraint. Migrating years of history takes several passes:
 * import, spot a mis-mapped account, fix it, re-import. Each entry therefore carries a content
 * hash as `sourceRef` (`qb:<hash>`) — the same mechanism `txnRef` uses for portfolio
 * transactions and `dedupHash` for bank rows. Re-importing the same transaction finds the
 * existing entry instead of writing a second one; genuinely editing it in QuickBooks changes
 * the hash, which is what makes a corrected export re-import cleanly.
 *
 * The hash is line-ORDER-INSENSITIVE, because QuickBooks does not promise a stable split order
 * between exports and an order-sensitive hash would duplicate the whole ledger on a re-run.
 *
 * THE PAYEE IS PART OF THE TRANSACTION. The first version hashed date, type, number and the
 * account/amount of each split — not who paid. Two LPs who each wire the same amount on the same
 * day, with no transaction number, hashed identically, and every one after the first was skipped
 * as "already imported". The current version (`<prefix>:v2:<hash>`) also hashes each split's name
 * and memo and the transaction memo. Transactions identical even in those get an ordinal in the
 * batch (`:2`, `:3`, …), so the second of two genuinely identical deposits is imported too.
 *
 * Entries imported under the first version keep their refs; dedupe.ts recognises them through
 * qbLegacySourceRef, by count, so a re-run of an old file adds nothing it already added.
 */

const clean = (s: string | null | undefined) => (s ?? '').trim().replace(/\s+/g, ' ')
const hash32 = (payload: string) => createHash('sha256').update(payload).digest('hex').slice(0, 32)

export function qbSourceRef(t: QbTransaction, source: JournalSource = 'quickbooks'): string {
  const lines = t.lines
    .map(l => JSON.stringify([l.account, l.debit.toFixed(2), l.credit.toFixed(2), clean(l.name), clean(l.memo)]))
    .sort()                                   // order-insensitive — see note above
  const payload = JSON.stringify(['v2', t.date, t.type ?? '', t.num ?? '', clean(t.memo), lines])
  return `${JOURNAL_SOURCES[source].refPrefix}:v2:${hash32(payload)}`
}

/**
 * The first version of the ref, which ignored payee and memo. Never written any more; kept so
 * entries already in the book under it are still recognised on a re-import.
 */
export function qbLegacySourceRef(t: QbTransaction, source: JournalSource = 'quickbooks'): string {
  const lines = t.lines
    .map(l => `${l.account}|${l.debit.toFixed(2)}|${l.credit.toFixed(2)}`)
    .sort()
    .join(';')
  const payload = `${t.date}|${t.type ?? ''}|${t.num ?? ''}|${lines}`
  return `${JOURNAL_SOURCES[source].refPrefix}:${hash32(payload)}`
}

/**
 * Refs for a batch, in order. The k-th transaction (k ≥ 2) whose qbSourceRef repeats one earlier in
 * the batch gets `:k` appended, so identical transactions do not collide with each other — and a
 * re-run of the same file assigns the same ordinals, so it still matches what it wrote.
 */
export function qbSourceRefs(txns: QbTransaction[], source: JournalSource = 'quickbooks'): { ref: string; legacyRef: string }[] {
  const seen = new Map<string, number>()
  return txns.map(t => {
    const base = qbSourceRef(t, source)
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    return { ref: n === 1 ? base : `${base}:${n}`, legacyRef: qbLegacySourceRef(t, source) }
  })
}

export interface SkippedTransaction {
  transaction: QbTransaction
  reason: string
}

/** The payee a QuickBooks transaction names — the first split line that carries one. */
export function qbVendorName(t: QbTransaction): string | null {
  const line = t.lines.find(l => l.name && l.name.trim())
  return line?.name?.trim() ?? null
}

export function buildEntries(
  txns: QbTransaction[],
  /** QuickBooks account name → our account code. From the confirmed mapping. */
  mapping: Map<string, string>,
  /** Our account code → chart_of_accounts.id. From accountIdByCode(). */
  accountIds: Map<string, string>,
  fundId: string,
  /**
   * QuickBooks Name (lower-cased) → vendors.id, for the payee on each entry. Optional: without it
   * the Name column is read and dropped, as it was before vendors existed.
   */
  vendorIdByName?: Map<string, string>,
  capital?: { accountIds: Set<string>; targets: QbLpTarget[] },
  /** Whose books these are (sources.ts). Sets source_type and the source_ref prefix. */
  source: JournalSource = 'quickbooks',
): {
  entries: JournalEntry[]
  /** Aligned with `entries`: the transaction each came from and its first-version ref (dedupe.ts). */
  origins: { transaction: QbTransaction; legacyRef: string }[]
  skipped: SkippedTransaction[]
  capitalWarnings: string[]
} {
  const entries: JournalEntry[] = []
  const origins: { transaction: QbTransaction; legacyRef: string }[] = []
  const skipped: SkippedTransaction[] = []
  const capitalWarnings: string[] = []
  // Over the whole batch, skipped or not, so an ordinal does not move when a mapping is fixed.
  const refs = qbSourceRefs(txns, source)

  for (let i = 0; i < txns.length; i++) {
    const t = txns[i]
    const postings: Posting[] = []
    let problem: string | null = null

    for (const l of t.lines) {
      const code = mapping.get(l.account)
      if (!code) { problem = `No mapping for ${JOURNAL_SOURCES[source].label} account "${l.account}".`; break }
      const accountId = accountIds.get(code)
      if (!accountId) { problem = `Mapped code ${code} has no account in this vehicle's chart.`; break }

      const direct = capital?.targets.find(t => t.accountId === accountId)
      const isCapital = capital?.accountIds.has(accountId) || !!direct
      const named = l.name ? [l.name] : [...new Set(t.lines.map(line => line.name).filter((n): n is string => !!n))]
      const lp = direct ?? (isCapital ? matchQbLp(named, [l.memo ?? '', t.memo ?? '', ...t.lines.map(line => line.memo ?? '')], capital!.targets) : null)
      if (isCapital && !lp && (l.debit || l.credit)) {
        capitalWarnings.push(`${t.date} ${memoFor(t, source)}: ${l.account} (${round2(l.credit - l.debit)}) needs an LP match; retained in unallocated capital.`)
      }
      // QuickBooks prints two positive columns; our ledger is signed (debit +, credit −).
      postings.push({
        accountId: lp?.accountId ?? accountId,
        ...(lp ? { lpEntityId: lp.entityId } : {}),
        amount: round2(l.debit - l.credit),
        currency: 'USD',        // persistEntry restamps this with the fund's currency.
      })
    }

    if (problem) { skipped.push({ transaction: t, reason: problem }); continue }

    const vendorName = qbVendorName(t)
    entries.push({
      fundId,
      entryDate: t.date,
      memo: memoFor(t, source),
      sourceType: source,
      sourceRef: refs[i].ref,
      vendorId: vendorName && vendorIdByName ? (vendorIdByName.get(vendorName.toLowerCase()) ?? null) : null,
      // Nothing posts on import. Every entry is reviewed on the journal page and posted
      // through the existing bulk-post surface — a bad mapping is then re-runnable rather
      // than needing reversal.
      status: 'draft',
      postings,
    })
    origins.push({ transaction: t, legacyRef: refs[i].legacyRef })
  }

  return { entries, origins, skipped, capitalWarnings }
}

/** Keep the source's identity in the memo — this is how someone traces an entry back. */
function memoFor(t: QbTransaction, source: JournalSource): string {
  const id = [t.type, t.num].filter(Boolean).join(' ')
  const body = t.memo ?? t.lines.find(l => l.memo)?.memo ?? ''
  return [id, body].filter(Boolean).join(' — ') || `${JOURNAL_SOURCES[source].label} ${t.date}`
}

const round2 = (n: number) => Math.round(n * 100) / 100
