import { describe, it, expect } from 'vitest'
import { DEFAULT_FEE_REVENUE_SUBTYPES, grossRevenueFee, type VehicleFeeTerms } from './fee'
import { F1, packDistributableCash } from './fixtures/pack-v3'
import { monthKey } from '@/lib/forecast/months'
import { roundCents } from '@/lib/accounting/ledger'

const terms: VehicleFeeTerms = {
  basis: 'gross_revenue',
  annualRate: 0.05,
  revenueSubtypes: DEFAULT_FEE_REVENUE_SUBTYPES,
  frequency: 'monthly',
  payeeVehicleId: 'manco',
}

describe('grossRevenueFee', () => {
  it('is 5% of each month of Base revenue, and sums to the pack fee each year within $1', () => {
    packDistributableCash('base').forEach((y, k) => {
      // Spread evenly by month (R7), the cents placed on the last month so the year ties.
      const revenue = new Map<string, number>()
      const monthly = roundCents(y.revenue / 12)
      for (let m = 1; m <= 12; m++) {
        revenue.set(monthKey(2027 + k, m), m === 12 ? roundCents(y.revenue - monthly * 11) : monthly)
      }
      const fees = grossRevenueFee(terms, revenue)
      expect(fees.get(monthKey(2027 + k, 1))).toBe(roundCents(0.05 * monthly))
      const year = Array.from(fees.values()).reduce((s, f) => s + f, 0)
      expect(Math.abs(year - F1.years[k].fee)).toBeLessThanOrEqual(1)
    })
  })

  it('gives 0 for a month with no revenue', () => {
    const fees = grossRevenueFee(terms, new Map([['2027-01', 0], ['2027-02', 81_139.5]]))
    expect(fees.get('2027-01')).toBe(0)
    expect(fees.get('2027-02')).toBe(4_056.98)
  })

  it('returns no months for no revenue', () => {
    expect(grossRevenueFee(terms, new Map()).size).toBe(0)
  })
})
