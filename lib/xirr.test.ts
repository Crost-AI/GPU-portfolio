import { describe, it, expect } from 'vitest'
import { xirr, type CashFlow } from './xirr'

const d = (s: string) => new Date(s + 'T00:00:00')

describe('xirr', () => {
  it('returns null when all flows are on the same date (no time spread)', () => {
    // A single cutover position: contributed = NAV, no distributions, one date. IRR is undefined —
    // must NOT return the internal 0.1 first guess as a spurious ~10%.
    const flows: CashFlow[] = [
      { date: d('2026-03-31'), amount: -1_000_000 }, // called
      { date: d('2026-03-31'), amount: 1_000_000 },  // terminal NAV = called
    ]
    expect(xirr(flows)).toBeNull()
  })

  it('is ~0% when NAV equals cost across a real time spread', () => {
    const flows: CashFlow[] = [
      { date: d('2025-01-01'), amount: -1_000_000 },
      { date: d('2026-01-01'), amount: 1_000_000 }, // no gain over a year
    ]
    const r = xirr(flows)!
    expect(r).not.toBeNull()
    expect(Math.abs(r)).toBeLessThan(1e-4)
  })

  it('computes a positive IRR for a genuine gain', () => {
    const flows: CashFlow[] = [
      { date: d('2025-01-01'), amount: -1_000_000 },
      { date: d('2026-01-01'), amount: 1_100_000 }, // +10% over one year
    ]
    const r = xirr(flows)!
    expect(r).toBeCloseTo(0.1, 2)
  })

  it('counts a year as 365 days, as Excel XIRR does', () => {
    // 2025-01-01 → 2026-01-01 is 365 days: exactly one year, so +10% is exactly 10%.
    const r = xirr([
      { date: d('2025-01-01'), amount: -1_000_000 },
      { date: d('2026-01-01'), amount: 1_100_000 },
    ])!
    expect(r).toBeCloseTo(0.1, 8)
  })

  it('returns null rather than a ~1e6 rate when Newton runs out of range', () => {
    // No root: a zero seed row first, and the later flows never net to zero at any rate. Past
    // 1e6 the npv collapses to the zero t=0 term and used to be accepted as converged.
    const flows: CashFlow[] = [
      { date: d('2025-01-01'), amount: 0 },
      { date: d('2025-06-01'), amount: 100 },
      { date: d('2026-01-01'), amount: -50 },
      { date: d('2026-06-01'), amount: 100 },
    ]
    expect(xirr(flows)).toBeNull()
  })

  it('returns null rather than a rate where the derivative went flat', () => {
    // Flows years apart: dnpv drops under 1e-12 at rates in the hundreds, long before 1e6, and
    // npv has decayed to the zero t=0 term there. No root exists. Used to return ~5438.7 and ~297.
    const flows = (years: number[]): CashFlow[] => [
      { date: d(`${years[0]}-01-01`), amount: 0 },
      { date: d(`${years[1]}-01-01`), amount: 100 },
      { date: d(`${years[2]}-01-01`), amount: -50 },
      { date: d(`${years[3]}-01-01`), amount: 100 },
    ]
    expect(xirr(flows([2010, 2013, 2016, 2019]))).toBeNull()
    expect(xirr(flows([2000, 2005, 2010, 2015]))).toBeNull()
  })

  it('keeps looking past a guess that runs out of range and finds the real root', () => {
    // +100 at year 1, -10 at year 2: 1 + r = 0.1, so r = -90%. The first guess runs off past 1e6.
    const r = xirr([
      { date: d('2025-01-01'), amount: 0 },
      { date: d('2026-01-01'), amount: 100 },
      { date: d('2027-01-01'), amount: -10 },
    ])!
    expect(r).toBeCloseTo(-0.9, 6)
  })

  it('returns null without both a positive and negative flow', () => {
    expect(xirr([{ date: d('2025-01-01'), amount: -100 }, { date: d('2026-01-01'), amount: -50 }])).toBeNull()
  })
})
