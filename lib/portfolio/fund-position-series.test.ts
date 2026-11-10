import { describe, expect, it } from 'vitest'
import { fundPositionSeries } from './fund-position-series'

const call = (event_date: string, amount: number, status: 'draft' | 'confirmed' = 'confirmed') =>
  ({ kind: 'call' as const, event_date, amount, status })
const dist = (event_date: string, amount: number) => ({ kind: 'distribution' as const, event_date, amount, status: 'confirmed' as const })
const nav = (as_of_date: string, reported_nav: number) => ({ as_of_date, reported_nav, basis: 'final' })

describe('fundPositionSeries', () => {
  it('is empty with no confirmed notices and no statements', () => {
    expect(fundPositionSeries([], [])).toEqual([])
    expect(fundPositionSeries([call('2026-01-15', 100_000, 'draft')], [])).toEqual([])
  })

  it('accumulates calls and distributions, and reports NAV only on statement dates', () => {
    const s = fundPositionSeries(
      [call('2026-01-15', 100_000), call('2026-04-15', 50_000), dist('2026-08-01', 30_000)],
      [nav('2026-03-31', 110_000), nav('2026-06-30', 180_000)],
    )
    expect(s.map(p => p.date)).toEqual(['2026-01-15', '2026-03-31', '2026-04-15', '2026-06-30', '2026-08-01'])
    expect(s.map(p => p.contributed)).toEqual([100_000, 100_000, 150_000, 150_000, 150_000])
    expect(s.map(p => p.distributed)).toEqual([0, 0, 0, 0, 30_000])
    expect(s.map(p => p.reportedNav)).toEqual([null, 110_000, null, 180_000, null])
  })

  it('carries cost before the first statement, then rolls the last NAV forward — as the register does', () => {
    const s = fundPositionSeries(
      [call('2026-01-15', 100_000), call('2026-04-15', 50_000), dist('2026-08-01', 30_000)],
      [nav('2026-03-31', 110_000), nav('2026-06-30', 180_000)],
    )
    expect(s.map(p => p.carryingValue)).toEqual([100_000, 110_000, 160_000, 180_000, 150_000])
    expect(s[0].tvpi).toBe(1)
    expect(s[4].dpi).toBeCloseTo(0.2)
    expect(s[4].tvpi).toBeCloseTo((30_000 + 150_000) / 150_000)
  })

  it('leaves the multiples null while nothing is contributed', () => {
    const [p] = fundPositionSeries([], [nav('2026-03-31', 10_000)])
    expect(p.tvpi).toBeNull()
    expect(p.dpi).toBeNull()
    expect(p.reportedNav).toBe(10_000)
  })
})
