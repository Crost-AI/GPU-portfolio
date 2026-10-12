import { describe, it, expect } from 'vitest'
import { attentionFor, expectedClosedThrough, firmAttention, quarterLabel } from './attention'
import type { FirmVehicleRow } from './firm-load'

const row = (over: Partial<FirmVehicleRow> = {}): FirmVehicleRow => ({
  id: 'v1', name: 'Fund I', kind: 'fund',
  closedThrough: '2026-06-30', lastEntryDate: '2026-09-15', firstEntryDate: '2024-01-10',
  postedEntries: 40, draftEntries: 0, openBankRows: 0,
  trialBalanced: true, totalDebits: 1000, empty: false, cash: 100,
  investmentsAtCost: 0, investmentsAtValue: 0, underivedTransactions: 0,
  ...over,
})

const oct12 = new Date('2026-10-12T12:00:00Z')

describe('expectedClosedThrough', () => {
  it('does not expect the quarter that only just ended', () => {
    expect(expectedClosedThrough(oct12)).toBe('2026-06-30')
  })
  it('expects it once the grace has passed', () => {
    expect(expectedClosedThrough(new Date('2026-11-14T00:00:00Z'))).toBe('2026-09-30')
  })
  it('crosses a year boundary', () => {
    expect(expectedClosedThrough(new Date('2026-01-20T00:00:00Z'))).toBe('2025-09-30')
    expect(expectedClosedThrough(new Date('2026-02-20T00:00:00Z'))).toBe('2025-12-31')
  })
})

describe('quarterLabel', () => {
  it('names the quarter a period end falls in', () => {
    expect(quarterLabel('2026-06-30')).toBe('Q2 2026')
    expect(quarterLabel('2025-12-31')).toBe('Q4 2025')
  })
})

describe('attentionFor', () => {
  it('is empty for books that are up to date', () => {
    expect(attentionFor(row(), oct12)).toEqual([])
  })

  it('lists each waiting item with the page that clears it', () => {
    const items = attentionFor(row({ trialBalanced: false, openBankRows: 14, draftEntries: 1, underivedTransactions: 2, closedThrough: null }), oct12)
    expect(items.map(i => [i.kind, i.label, i.href])).toEqual([
      ['ties', 'Trial balance does not tie', '/statements'],
      ['bank', '14 bank rows to reconcile', '/bank'],
      ['drafts', '1 draft waiting', '/journal?status=draft'],
      ['backlog', '2 investment transactions not on the ledger', '/status#book-investments'],
      ['close', 'Q2 2026 not closed', '/periods'],
    ])
  })

  it('does not ask an empty entity to tie or close', () => {
    expect(attentionFor(row({ empty: true, trialBalanced: false, closedThrough: null, firstEntryDate: null, lastEntryDate: null }), oct12)).toEqual([])
  })

  it('does not ask for a close of a quarter the books do not reach', () => {
    expect(attentionFor(row({ closedThrough: null, firstEntryDate: '2026-08-01' }), oct12)).toEqual([])
  })

  it('flags a close that is behind', () => {
    expect(attentionFor(row({ closedThrough: '2026-03-31' }), oct12).map(i => i.kind)).toEqual(['close'])
  })
})

describe('firmAttention', () => {
  it('keeps only entities with something waiting, in order', () => {
    const out = firmAttention([row({ id: 'a' }), row({ id: 'b', draftEntries: 3 }), row({ id: 'c', openBankRows: 1 })], oct12)
    expect(out.map(e => e.row.id)).toEqual(['b', 'c'])
  })
})
