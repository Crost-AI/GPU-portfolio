import { describe, it, expect } from 'vitest'
import { summarizeOpenRows, type FirmBankRow } from './bank-firm'

const r = (vehicleId: string, txnDate: string, amount: number): FirmBankRow => ({
  id: `${vehicleId}-${txnDate}-${amount}`, vehicleId, txnDate, amount,
  description: 'x', counterparty: null, status: 'unmatched', suggestedAccountCode: null,
})

describe('summarizeOpenRows', () => {
  it('counts each entity\'s open rows, keeps money in and out apart, and finds the oldest', () => {
    const out = summarizeOpenRows(
      [{ id: 'a', name: 'A', kind: 'fund' }, { id: 'b', name: 'B', kind: 'associate' }, { id: 'c', name: 'C', kind: null }],
      [r('a', '2026-03-02', 500), r('a', '2026-01-15', -200), r('a', '2026-05-01', -50), r('b', '2026-09-01', 10)],
      new Map([['a', { last: '2026-09-30', any: true }], ['c', { last: '2026-06-30', any: true }]]),
    )
    expect(out).toEqual([
      { id: 'a', name: 'A', kind: 'fund', openRows: 3, openIn: 500, openOut: 250, oldestOpen: '2026-01-15', lastImported: '2026-09-30', everImported: true },
      { id: 'b', name: 'B', kind: 'associate', openRows: 1, openIn: 10, openOut: 0, oldestOpen: '2026-09-01', lastImported: null, everImported: false },
      { id: 'c', name: 'C', kind: null, openRows: 0, openIn: 0, openOut: 0, oldestOpen: null, lastImported: '2026-06-30', everImported: true },
    ])
  })
})
