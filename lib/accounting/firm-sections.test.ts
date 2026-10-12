import { describe, it, expect } from 'vitest'
import { closeCell, recentQuarterEnds } from './close-grid'
import { draftTotals } from './drafts-firm'
import { mergeHoldings } from './holdings-firm'
import { pairIntercompany } from './intercompany-firm'
import type { SoiRow } from './statements'

describe('recentQuarterEnds', () => {
  it('ends at the latest quarter-end that has passed, oldest first', () => {
    expect(recentQuarterEnds(new Date('2026-10-12T12:00:00Z'), 4)).toEqual(['2025-12-31', '2026-03-31', '2026-06-30', '2026-09-30'])
  })
  it('counts today when today is a quarter-end', () => {
    expect(recentQuarterEnds(new Date('2026-06-30T12:00:00Z'), 2)).toEqual(['2026-03-31', '2026-06-30'])
  })
})

describe('closeCell', () => {
  const expected = '2026-06-30'
  it('is closed when a closed period covers the quarter-end, monthly or annual', () => {
    expect(closeCell([{ start: '2026-06-01', end: '2026-06-30', status: 'closed' }], '2024-01-01', '2026-06-30', expected)).toBe('closed')
    expect(closeCell([{ start: '2026-01-01', end: '2026-12-31', status: 'closed' }], '2024-01-01', '2026-06-30', expected)).toBe('closed')
  })
  it('does not let a later close close an earlier quarter', () => {
    expect(closeCell([{ start: '2026-04-01', end: '2026-06-30', status: 'closed' }], '2024-01-01', '2026-03-31', expected)).toBe('late')
  })
  it('says reopened for a period that exists but is open', () => {
    expect(closeCell([{ start: '2026-04-01', end: '2026-06-30', status: 'open' }], '2024-01-01', '2026-06-30', expected)).toBe('reopened')
  })
  it('is due inside the grace, none before the books start', () => {
    expect(closeCell([], '2024-01-01', '2026-09-30', expected)).toBe('due')
    expect(closeCell([], '2026-07-15', '2026-06-30', expected)).toBe('none')
    expect(closeCell([], null, '2026-06-30', expected)).toBe('none')
  })
})

describe('draftTotals', () => {
  it('sizes an entry by its debits and reports any imbalance', () => {
    expect(draftTotals([{ amount: 100 }, { amount: '-100' }])).toEqual({ amount: 100, imbalance: 0 })
    expect(draftTotals([{ amount: 100 }, { amount: -90.5 }])).toEqual({ amount: 100, imbalance: 9.5 })
  })
})

describe('mergeHoldings', () => {
  const row = (name: string, cost: number, fairValue: number, companyId?: string): SoiRow => ({ name, cost, fairValue, pctOfNetAssets: 0, companyId })
  it('merges a company held by several entities, largest value first', () => {
    const out = mergeHoldings([
      { vehicleId: 'a', rows: [row('Acme', 100, 300, 'c1'), row('Beta', 50, 50, 'c2')] },
      { vehicleId: 'b', rows: [row('Acme', 40, 60, 'c1')] },
    ])
    expect(out.map(h => [h.name, h.cost, h.fairValue, h.holders.map(x => x.vehicleId)])).toEqual([
      ['Acme', 140, 360, ['a', 'b']],
      ['Beta', 50, 50, ['a']],
    ])
  })
  it('matches a ledger-only row by name when it has no company id', () => {
    const out = mergeHoldings([{ vehicleId: 'a', rows: [row('Gamma ', 1, 1)] }, { vehicleId: 'b', rows: [row('gamma', 2, 2)] }])
    expect(out).toHaveLength(1)
    expect(out[0].holders).toHaveLength(2)
  })
})

describe('pairIntercompany', () => {
  const bal = (cp: string, net: number) => ({ counterpartyVehicleId: cp, counterpartyName: cp.toUpperCase(), dueFrom: Math.max(net, 0), dueTo: Math.max(-net, 0), net })
  it('lists a pair inside the family once, and says whether both books agree', () => {
    const out = pairIntercompany(new Map([['gp', [bal('lp', 500)]], ['lp', [bal('gp', -500)]]]), ['gp', 'lp'])
    expect(out).toEqual([{ vehicleId: 'gp', counterpartyVehicleId: 'lp', counterpartyName: 'LP', net: 500, counterpartyNet: 500, ties: true }])
  })
  it('flags books that disagree', () => {
    const out = pairIntercompany(new Map([['gp', [bal('lp', 500)]], ['lp', [bal('gp', -450)]]]), ['gp', 'lp'])
    expect(out[0].ties).toBe(false)
  })
  it('catches a balance only the second entity carries', () => {
    const out = pairIntercompany(new Map([['gp', []], ['lp', [bal('gp', -200)]]]), ['gp', 'lp'])
    expect(out).toEqual([{ vehicleId: 'gp', counterpartyVehicleId: 'lp', counterpartyName: '', net: 0, counterpartyNet: 200, ties: false }])
  })
  it('reports a counterparty outside the family with no other side to check', () => {
    const out = pairIntercompany(new Map([['gp', [bal('manco', -75)]]]), ['gp'])
    expect(out).toEqual([{ vehicleId: 'gp', counterpartyVehicleId: 'manco', counterpartyName: 'MANCO', net: -75, counterpartyNet: null, ties: null }])
  })
})
