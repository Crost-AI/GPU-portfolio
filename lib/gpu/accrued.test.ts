import { describe, expect, it } from 'vitest'
import { accruedProfitShare } from './accrued'
import { F1, PACK_INPUTS, PACK_TERMS } from './fixtures/pack-v3'
import type { WaterfallEvent } from './waterfall'

// The pack's Base case as events: 1,435,500 in, then each year's distributable cash, periodic.
const DATES = ['2027-12-31', '2028-12-31', '2029-12-31', '2030-12-31', '2031-12-31']
const events = (years: number): WaterfallEvent[] => [
  { kind: 'contribution', date: '2027-01-01', lpEntityId: 'lp1', amount: PACK_INPUTS.capital, periodFraction: 0 },
  ...F1.distributableCents.slice(0, years).map((amount, k): WaterfallEvent => ({ kind: 'distribution', date: DATES[k], amount, periodFraction: 1 })),
]

describe('accruedProfitShare: the manager share if book NAV were distributed today (memo, never booked)', () => {
  it('F7: after Base Y1–Y2, 1,000,000 of NAV pays no pref, returns 132,578.96 and the split gives 260,226.31', () => {
    const m = accruedProfitShare({ events: events(2), terms: PACK_TERMS, bookNav: 1_000_000, asOf: DATES[1] })
    expect(m.tiers.prefDue).toBe(0)
    expect(m.tiers.returnOfCapital).toBe(132_578.96)
    expect(m.carryMemo).toBe(260_226.31)
    expect(m.investorMemo).toBe(739_773.69)
    expect(m.paidToDate).toBe(0)
    expect(m).toMatchObject({ asOf: DATES[1], bookNav: 1_000_000 })
  })

  it("end of Y3, NAV = the equipment's NBV (600,300): capital is back, so 30% of all of it", () => {
    // 1,305,000 − 3 × 234,900 = 600,300.
    const nbv = PACK_INPUTS.hardwareCost - 3 * (PACK_INPUTS.hardwareCost - PACK_INPUTS.salePrice) / 5
    expect(nbv).toBe(600_300)
    const m = accruedProfitShare({ events: events(3), terms: PACK_TERMS, bookNav: nbv, asOf: DATES[2] })
    expect(m.tiers.returnOfCapital).toBe(0)
    expect(m.carryMemo).toBe(180_090)
    // The profit share Y3 actually paid stays the paid figure, beside the memo.
    expect(m.paidToDate).toBe(F1.y3Cents.carry)
  })

  it('is zero when NAV does not reach past the pref due and the capital unreturned', () => {
    const m = accruedProfitShare({ events: events(1), terms: PACK_TERMS, bookNav: 500_000, asOf: DATES[0] })
    expect(m.carryMemo).toBe(0)
    expect(m.tiers.carry).toBe(0)
    expect(m.investorMemo).toBe(500_000)
    expect(accruedProfitShare({ events: events(1), terms: PACK_TERMS, bookNav: -10, asOf: DATES[0] })).toMatchObject({ bookNav: 0, carryMemo: 0, investorMemo: 0 })
    expect(accruedProfitShare({ events: [], terms: PACK_TERMS, bookNav: 1_000, asOf: DATES[0] }).carryMemo).toBe(0)
  })

  it('is a function of its inputs only: the same replay gives the same memo', () => {
    const a = accruedProfitShare({ events: events(2), terms: { ...PACK_TERMS, dayCount: '30_360' }, bookNav: 1_000_000, asOf: '2029-03-31' })
    const b = accruedProfitShare({ events: [...events(2)].reverse(), terms: { ...PACK_TERMS, dayCount: '30_360' }, bookNav: 1_000_000, asOf: '2029-03-31' })
    expect(a).toEqual(b)
    // Dated: the quarter's pref on the 132,578.96 still unreturned is due first.
    expect(a.tiers.prefDue).toBeGreaterThan(0)
  })
})
