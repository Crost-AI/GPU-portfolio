import { describe, expect, it } from 'vitest'
import { carryOnUnrealizedForYear } from './book-tax'
import { buildFxReversalEntry, buildUnrealizedReversalEntry } from './book-tax-entries'
import { proposeAdjustments } from './book-tax'
import type { CapitalPosting } from './capital-account'
import type { VehicleCarryTerms } from './carry'

const straight20: VehicleCarryTerms = {
  kind: 'straight', carryRate: 0.2, prefRate: 0, catchupRate: 0, prefCompounds: false,
  gpEntityId: 'gp', recipients: [{ lpEntityId: 'gp', pct: 100 }],
}
const p = (lpEntityId: string, amount: number, sourceType: string, entryDate = '2026-12-31'): CapitalPosting => ({ lpEntityId, amount, sourceType, entryDate })

describe('carryOnUnrealizedForYear', () => {
  const contributed = [p('a', -1_000_000, 'capital_call', '2026-01-15')]

  it('reverses nothing when every gain was realized — the GP keeps that carry for tax', () => {
    const postings = [...contributed, p('a', -500_000, 'realized_gain'), p('a', 100_000, 'carried_interest'), p('gp', -100_000, 'carried_interest')]
    expect(carryOnUnrealizedForYear(postings, straight20, '2025-12-31', '2026-12-31').size).toBe(0)
  })

  it('reverses all of it when the gain is only a mark', () => {
    const postings = [...contributed, p('a', -500_000, 'valuation'), p('a', 100_000, 'carried_interest'), p('gp', -100_000, 'carried_interest')]
    expect(carryOnUnrealizedForYear(postings, straight20, '2025-12-31', '2026-12-31')).toEqual(new Map([['a', 100_000], ['gp', -100_000]]))
  })

  it('reverses only the unrealized share of a mixed year', () => {
    const postings = [...contributed, p('a', -300_000, 'realized_gain'), p('a', -200_000, 'valuation'), p('a', 100_000, 'carried_interest'), p('gp', -100_000, 'carried_interest')]
    expect(carryOnUnrealizedForYear(postings, straight20, '2025-12-31', '2026-12-31')).toEqual(new Map([['a', 40_000], ['gp', -40_000]]))
  })

  // The year's figure reconciles per partner, as the close does: each partner's share of this
  // year-end target less its share of last year-end's. A year-level delta split by who is in profit
  // NOW skipped the reversal when nobody was, and charged it to the wrong partner when one was.
  const marked2025 = (lp: string, mark: number) => p(lp, -mark, 'valuation', '2025-06-30')
  const carried = (lp: string, amount: number, date: string) =>
    [p(lp, amount, 'carried_interest', date), p('gp', -amount, 'carried_interest', date)]

  it('a year with nothing new posts nothing, even with carry accrued the year before', () => {
    const postings = [p('a', -1_000_000, 'capital_call', '2025-01-15'), marked2025('a', 500_000), ...carried('a', 100_000, '2025-12-31')]
    expect(carryOnUnrealizedForYear(postings, straight20, '2025-12-31', '2026-12-31').size).toBe(0)
  })

  it('reverses all of a partner’s prior unrealized carry when the mark disappears', () => {
    const postings = [
      p('a', -1_000_000, 'capital_call', '2025-01-15'), marked2025('a', 500_000), ...carried('a', 100_000, '2025-12-31'),
      p('a', 500_000, 'valuation', '2026-06-30'), ...carried('a', -100_000, '2026-06-30'),
    ]
    // Nobody is in profit at year end; the old split had no one to reverse along and returned nothing.
    expect(carryOnUnrealizedForYear(postings, straight20, '2025-12-31', '2026-12-31'))
      .toEqual(new Map([['a', -100_000], ['gp', 100_000]]))
  })

  it('gives an under-water partner its carry back while the other stays in profit', () => {
    // 2025: A +1m and B +500k on marks → 300k, A 200k and B 100k. 2026: A falls 1.2m (under water
    // by 200k), B gains another 500k → target 20% × 800k = 160k, all B's. A −200k, B +60k. The old
    // split put the whole −140k on B and left A carrying 200k on a loss.
    const postings = [
      p('a', -1_000_000, 'capital_call', '2025-01-15'), p('b', -1_000_000, 'capital_call', '2025-01-15'),
      marked2025('a', 1_000_000), marked2025('b', 500_000),
      ...carried('a', 200_000, '2025-12-31'), ...carried('b', 100_000, '2025-12-31'),
      p('a', 1_200_000, 'valuation', '2026-06-30'), p('b', -500_000, 'valuation', '2026-06-30'),
    ]
    expect(carryOnUnrealizedForYear(postings, straight20, '2025-12-31', '2026-12-31'))
      .toEqual(new Map([['a', -200_000], ['b', 60_000], ['gp', 140_000]]))
  })

  it('returns nothing for a vehicle without carry terms', () => {
    expect(carryOnUnrealizedForYear(contributed, { ...straight20, kind: 'none' }, '2025-12-31', '2026-12-31').size).toBe(0)
  })
})

describe('buildUnrealizedReversalEntry', () => {
  const accts = { unrealizedAssetId: '1200', unrealizedIncomeId: '4200' }

  it("reverses each partner's allocation in their own capital, and only the unallocated rest on 4200", () => {
    const entry = buildUnrealizedReversalEntry({ fundId: 'f', entryDate: '2026-12-31' }, 600_000, accts, 'USD', {
      allocated: new Map([['a', -300_000], ['b', -200_000]]),
      capMap: new Map([['a', 'cap-a'], ['b', 'cap-b']]),
    })
    expect(entry.postings.map(x => [x.accountId, x.amount, x.lpEntityId])).toEqual([
      ['cap-a', 300_000, 'a'],
      ['cap-b', 200_000, 'b'],
      ['4200', 100_000, null],
      ['1200', -600_000, null],
    ])
  })

  it('without a per-partner split, reverses at fund level as before', () => {
    const entry = buildUnrealizedReversalEntry({ fundId: 'f', entryDate: '2026-12-31' }, 600_000, accts)
    expect(entry.postings.map(x => [x.accountId, x.amount])).toEqual([['4200', 600_000], ['1200', -600_000]])
  })
})

describe('currency translation', () => {
  it('is proposed as its own timing difference', () => {
    const org = { monthsInYear: 0, monthsAlreadyAmortized: 0, isFirstYear: false }
    const proposals = proposeAdjustments({ unrealizedChange: 0, fxChange: 12_000, carryAccruedOnUnrealized: 0, organizationalExpense: 0, organizationalCostsToDate: 0, syndicationExpense: 0, org })
    expect(proposals.map(p => [p.kind, p.amount, p.permanent])).toEqual([['fx_translation', 12_000, false]])
  })

  it("reverses each partner's translation and each company's 1250 by its own movement", () => {
    const entry = buildFxReversalEntry({ fundId: 'f', entryDate: '2026-12-31' }, 12_000, { fxIncomeId: '4300', fxAssetId: '1250' }, 'USD', {
      allocated: new Map([['a', -9_000], ['b', -3_000]]),
      capMap: new Map([['a', 'cap-a'], ['b', 'cap-b']]),
      assetMoves: new Map([['1250-acme', 15_000], ['1250-globex', -3_000]]),
    })
    expect(entry.sourceType).toBe('tax_adj_fx')
    expect(entry.postings.map(x => [x.accountId, x.amount])).toEqual([
      ['cap-a', 9_000], ['cap-b', 3_000], ['1250-acme', -15_000], ['1250-globex', 3_000],
    ])
  })
})
