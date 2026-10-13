/**
 * Which incoming transactions are already in the book. Pure; importQbJournal does the reads.
 *
 * TWO GENERATIONS OF REF. Entries imported before payees were hashed carry the first-version ref
 * (qbLegacySourceRef), which several different transactions can share — the two LPs who wired the
 * same amount on the same day. Those entries are never rewritten, so an incoming transaction is
 * already present if:
 *
 *   1. its current ref is in the book (the ordinary re-import), or
 *   2. it is paired with a book entry carrying its first-version ref.
 *
 * Step 2 is MULTISET matching: N incoming transactions sharing a first-version ref against M
 * entries holding it means M are present and N − M are new. Without the count, either the old
 * bug survives (one entry hides all N) or every old file re-imports in full.
 *
 * WHICH of the N are the M. An old entry records the payee as a vendor and the LP on its capital
 * postings, when it had them. Pairing prefers a transaction that agrees on those, then one that
 * cannot be told apart (the old entry recorded neither), and never one that disagrees — an entry
 * for one LP is not evidence that another LP's contribution was imported. That last rule is also
 * what catches the case a batch boundary splits: one LP's deposit in this batch, the other's in
 * the next, each seeing the same single old entry.
 *
 * STATUS IS NOT FILTERED. A voided entry still counts as imported, as it always has: voiding an
 * imported transaction should not bring it back on the next run. The reason says so.
 */

export interface DedupeCandidate {
  ref: string
  legacyRef: string
  entryDate: string
  memo: string | null
  payee: string | null
  /** The existing vendor the payee name resolves to, if any. Never created here. */
  vendorId: string | null
  lpEntityIds: string[]
}

export interface BookEntry {
  id: string
  sourceRef: string
  status: string
  vendorId: string | null
  lpEntityIds: string[]
}

export interface DuplicateTransaction {
  entryDate: string
  memo: string | null
  sourceRef: string
  existingEntryId: string
  existingRef: string
  existingStatus: string
  reason: string
}

/** Imported although an entry with its first-version ref is in the book. */
export interface RecoveredTransaction {
  entryDate: string
  memo: string | null
  sourceRef: string
  legacyRef: string
  reason: string
}

export interface DedupeResult {
  /** Aligned with the candidates. */
  present: boolean[]
  duplicates: DuplicateTransaction[]
  recovered: RecoveredTransaction[]
}

type Agreement = 'same' | 'unknown' | 'different'

function compare(c: DedupeCandidate, b: BookEntry): Agreement {
  let agreed = false
  if (c.vendorId && b.vendorId) {
    if (c.vendorId !== b.vendorId) return 'different'
    agreed = true
  }
  if (c.lpEntityIds.length && b.lpEntityIds.length) {
    if ([...new Set(c.lpEntityIds)].sort().join() !== [...new Set(b.lpEntityIds)].sort().join()) return 'different'
    agreed = true
  }
  return agreed ? 'same' : 'unknown'
}

const VOIDED = ' That entry is voided; a voided entry still blocks re-import, so a voided transaction is not brought back.'
const entries = (n: number) => `${n} entr${n === 1 ? 'y' : 'ies'}`

export function matchImported(cands: DedupeCandidate[], book: BookEntry[]): DedupeResult {
  const byRef = new Map<string, BookEntry[]>()
  for (const b of book) byRef.set(b.sourceRef, [...(byRef.get(b.sourceRef) ?? []), b])

  const present = cands.map(() => false)
  const found: { i: number; d: DuplicateTransaction }[] = []
  const recovered: { i: number; r: RecoveredTransaction }[] = []
  const duplicate = (i: number, b: BookEntry, reason: string) => {
    present[i] = true
    const c = cands[i]
    found.push({ i, d: {
      entryDate: c.entryDate, memo: c.memo, sourceRef: c.ref,
      existingEntryId: b.id, existingRef: b.sourceRef, existingStatus: b.status,
      reason: reason + (b.status === 'void' ? VOIDED : ''),
    } })
  }

  const groups = new Map<string, number[]>()
  cands.forEach((c, i) => {
    const same = byRef.get(c.ref)?.[0]
    if (same) return duplicate(i, same, 'Already imported: same date, accounts, amounts, payee and memo.')
    groups.set(c.legacyRef, [...(groups.get(c.legacyRef) ?? []), i])
  })

  for (const [legacyRef, idx] of Array.from(groups)) {
    const olds = [...(byRef.get(legacyRef) ?? [])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    if (!olds.length) continue

    const pair = new Map<number, BookEntry>()
    const used = new Set<BookEntry>()
    for (const pass of ['same', 'unknown'] as const) for (const b of olds) {
      if (used.has(b)) continue
      const i = idx.find(i => !pair.has(i) && compare(cands[i], b) === pass)
      if (i !== undefined) { pair.set(i, b); used.add(b) }
    }

    const shared = `${idx.length} transaction${idx.length === 1 ? '' : 's'} in this import share an older reference (from before payees were part of it) with ${entries(olds.length)} in the book`
    for (const i of idx) {
      const c = cands[i]
      const b = pair.get(i)
      if (b && compare(c, b) === 'same') {
        duplicate(i, b, 'Imported earlier, before payees were part of the reference; that entry has the same payee or LP.')
      } else if (b && idx.length === 1) {
        duplicate(i, b, 'Imported earlier, before payees were part of the reference: same date, accounts and amounts.')
      } else if (b) {
        duplicate(i, b, `${shared}, which record no payee or LP to tell them apart, so they were paired by count. Check that entry is for ${c.payee ?? 'this transaction'}.`)
      } else {
        const reason = olds.every(o => compare(c, o) === 'different')
          ? `Imported: an entry with the same date, accounts and amounts is in the book under an older reference, but for a different payee or LP, so this is a separate transaction an earlier import skipped.`
          : `Imported: ${shared}; this is one of the ${idx.length - pair.size} not there yet.`
        recovered.push({ i, r: { entryDate: c.entryDate, memo: c.memo, sourceRef: c.ref, legacyRef, reason } })
      }
    }
  }

  return {
    present,
    duplicates: found.sort((a, b) => a.i - b.i).map(x => x.d),
    recovered: recovered.sort((a, b) => a.i - b.i).map(x => x.r),
  }
}
