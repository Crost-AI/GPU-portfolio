import { describe, it, expect } from 'vitest'
import { bookForTransaction, lockedTaxYear, taxAccountHit } from './book-routing'
import { bookConflicts, matchImported, type BookEntry, type DedupeCandidate } from './dedupe'
import type { QbTransaction } from './parse-journal'

const txn = (accounts: string[], date = '2025-12-31'): QbTransaction => ({
  date, type: 'Journal Entry', num: null, memo: null,
  lines: accounts.map((account, i) => ({ account, name: null, memo: null, debit: i === 0 ? 100 : 0, credit: i === 0 ? 0 : 100 })),
})

describe('bookForTransaction', () => {
  const tax = new Set(['K-1 attributes'])

  it('routes a transaction touching any tax-book account to the tax book', () => {
    expect(bookForTransaction(txn(['K-1 attributes', 'Investments']), tax)).toBe('tax')
    expect(bookForTransaction(txn(['Investments', 'K-1 attributes']), tax)).toBe('tax')
    expect(taxAccountHit(txn(['Investments', 'K-1 attributes']), tax)).toBe('K-1 attributes')
  })

  it('leaves everything else in the actual book, and everything when nothing is flagged', () => {
    expect(bookForTransaction(txn(['Bank', 'Investments']), tax)).toBe('actual')
    expect(bookForTransaction(txn(['K-1 attributes', 'Investments']), new Set())).toBe('actual')
    expect(taxAccountHit(txn(['Bank', 'Investments']), tax)).toBeNull()
  })
})

describe('lockedTaxYear', () => {
  it('names the closed calendar tax year an entry falls in', () => {
    expect(lockedTaxYear('2024-12-31', new Set([2024]))).toBe(2024)
    expect(lockedTaxYear('2025-01-01', new Set([2024]))).toBeNull()
    expect(lockedTaxYear('2025-01-01', new Set())).toBeNull()
  })
})

describe('dedupe across books', () => {
  const cand = (ref: string, book: 'actual' | 'tax'): DedupeCandidate =>
    ({ ref, legacyRef: `${ref}-legacy`, entryDate: '2025-12-31', memo: 'K-1', payee: null, vendorId: null, lpEntityIds: [], book })
  const entry = (ref: string, book: 'actual' | 'tax', status = 'draft'): BookEntry =>
    ({ id: `e-${ref}-${book}`, sourceRef: ref, status, vendorId: null, lpEntityIds: [], book })

  it('an entry in either book makes the transaction present', () => {
    const cands = [cand('a', 'tax'), cand('b', 'actual')]
    const { present, duplicates } = matchImported(cands, [entry('a', 'actual'), entry('b', 'tax')])
    expect(present).toEqual([true, true])
    expect(duplicates.map(d => d.existingBook)).toEqual(['actual', 'tax'])
    expect(bookConflicts(cands, duplicates).map(c => [c.sourceRef, c.existingBook, c.mappedBook])).toEqual([['a', 'actual', 'tax'], ['b', 'tax', 'actual']])
  })

  it('no conflict when the entry is already in the book the mapping chooses', () => {
    const cands = [cand('a', 'tax')]
    const { duplicates } = matchImported(cands, [entry('a', 'tax')])
    expect(bookConflicts(cands, duplicates)).toEqual([])
  })

  it('a voided entry blocks in its own book but not in the other', () => {
    expect(matchImported([cand('a', 'tax')], [entry('a', 'actual', 'void')]).present).toEqual([false])
    expect(matchImported([cand('a', 'tax')], [entry('a', 'tax', 'void')]).present).toEqual([true])
    // A candidate without a book is an actual-book one, as before.
    expect(matchImported([{ ...cand('a', 'actual'), book: undefined }], [{ ...entry('a', 'actual', 'void'), book: undefined }]).present).toEqual([true])
  })

  it('a live entry in the other book wins over a voided one in this book', () => {
    const cands = [cand('a', 'tax')]
    const { duplicates } = matchImported(cands, [entry('a', 'tax', 'void'), entry('a', 'actual', 'posted')])
    expect(duplicates[0]).toMatchObject({ existingStatus: 'posted', existingBook: 'actual' })
    expect(bookConflicts(cands, duplicates)).toHaveLength(1)
  })
})
