import { describe, it, expect } from 'vitest'
import { MACRS_HALF_YEAR, bookToTaxDepreciation, taxDepreciationSchedule, type TaxDepreciableAsset } from './tax-depreciation'
import { PACK_INPUTS } from './fixtures/pack-v3'

// Decision Q7: tax depreciation is its own schedule per asset. $1,435,500 is the pack's capital
// (hardware plus the 10% contingency), used here as one basis so the table is easy to read off.
const asset = (over: Partial<TaxDepreciableAsset> = {}): TaxDepreciableAsset => ({
  id: 'a', basis: PACK_INPUTS.capital, salvage: PACK_INPUTS.capital * 0.1, lifeMonths: 60,
  inServiceDate: '2027-03-01', convention: 'full_month', taxMethod: 'macrs_5', taxBonusPct: 0, taxLifeYears: null, ...over,
})

describe('MACRS', () => {
  it('5-year on $1,435,500 reproduces the IRS half-year table (20, 32, 19.2, 11.52, 11.52, 5.76%)', () => {
    const s = taxDepreciationSchedule(asset())
    expect(s.map(l => l.year)).toEqual([2027, 2028, 2029, 2030, 2031, 2032])
    expect(s.map(l => l.amount)).toEqual([287_100, 459_360, 275_616, 165_369.6, 165_369.6, 82_684.8])
    s.forEach((l, i) => expect(l.amount / PACK_INPUTS.capital).toBeCloseTo(MACRS_HALF_YEAR[5][i] / 100, 10))
    expect(s.at(-1)!.accumulated).toBe(PACK_INPUTS.capital)
  })

  it('7-year runs eight years and recovers the full basis, ignoring salvage', () => {
    const s = taxDepreciationSchedule(asset({ taxMethod: 'macrs_7' }))
    expect(s).toHaveLength(8)
    expect(s[0].amount).toBe(205_132.95)
    expect(s.at(-1)!.accumulated).toBe(PACK_INPUTS.capital)
  })

  it('bonus: the bonus share in year 1, then MACRS 5 on the remainder', () => {
    const s = taxDepreciationSchedule(asset({ taxMethod: 'bonus', taxBonusPct: 0.6 }))
    const rest = PACK_INPUTS.capital * 0.4
    expect(s[0].amount).toBe(861_300 + rest * 0.2)
    expect(s[1].amount).toBe(rest * 0.32)
    expect(s.at(-1)!.accumulated).toBe(PACK_INPUTS.capital)
    expect(taxDepreciationSchedule(asset({ taxMethod: 'bonus', taxBonusPct: 1 })).map(l => l.amount)).toEqual([PACK_INPUTS.capital, 0, 0, 0, 0, 0])
  })

  it('half-year convention on disposal: half the year’s amount, none after; none in the year placed in service', () => {
    const s = taxDepreciationSchedule(asset({ disposedOn: '2029-08-01' }))
    expect(s.map(l => l.amount)).toEqual([287_100, 459_360, 137_808])
    expect(taxDepreciationSchedule(asset({ disposedOn: '2027-11-01' }))).toEqual([])
  })

  it('a disposal in the table’s final year takes that year’s amount in full (it is already the half year)', () => {
    expect(taxDepreciationSchedule(asset({ disposedOn: '2032-05-01' })).at(-1)).toEqual({ year: 2032, amount: 82_684.8, accumulated: PACK_INPUTS.capital })
    expect(taxDepreciationSchedule(asset({ disposedOn: '2031-05-01' })).at(-1)!.amount).toBe(82_684.8)
  })
})

describe('book and straight-line methods', () => {
  it('book: the book schedule by calendar year, so the difference is zero', () => {
    const a = asset({ taxMethod: 'book' })
    expect(taxDepreciationSchedule(a)[0]).toMatchObject({ year: 2027, amount: 21_532.5 * 10 })
    expect(bookToTaxDepreciation(a, 2028)).toEqual({ book: 258_390, tax: 258_390, difference: 0 })
  })

  it('straight_line: over taxLifeYears with no salvage', () => {
    const s = taxDepreciationSchedule(asset({ taxMethod: 'straight_line', taxLifeYears: 5 }))
    expect(s[1]).toMatchObject({ year: 2028, amount: 287_100 })
    expect(s.at(-1)!.accumulated).toBe(PACK_INPUTS.capital)
  })
})

describe('bookToTaxDepreciation', () => {
  it('reports tax minus book for the year', () => {
    // Book: (1,435,500 − 143,550) / 60 = 21,532.50 a month; 10 months in 2027.
    expect(bookToTaxDepreciation(asset(), 2027)).toEqual({ book: 215_325, tax: 287_100, difference: 71_775 })
    expect(bookToTaxDepreciation(asset(), 2032)).toEqual({ book: 43_065, tax: 82_684.8, difference: 39_619.8 })
    expect(bookToTaxDepreciation(asset(), 2040)).toEqual({ book: 0, tax: 0, difference: 0 })
  })
})

describe('book versus independent tax inputs', () => {
  // 600 cost, 60 salvage, 60 months from January; 600 of capex in January; twelve posted book charges.
  const base = (over: Partial<TaxDepreciableAsset> = {}): TaxDepreciableAsset => ({
    id: 'x', basis: 600, salvage: 60, lifeMonths: 60, inServiceDate: '2027-01-01', convention: 'full_month',
    taxMethod: 'book', taxBonusPct: 0, taxLifeYears: null, capex: [{ month: '2027-01', amount: 600 }], ...over,
  })

  it('the book method follows the book schedule with its capex and postings: no book-to-tax difference', () => {
    const a = base()
    expect(bookToTaxDepreciation(a, 2027)).toEqual({ book: 228, tax: 228, difference: 0 })
    const posted = new Map(Array.from({ length: 12 }, (_, i) => [`2027-${String(i + 1).padStart(2, '0')}`, 19] as [string, number]))
    expect(bookToTaxDepreciation(base({ posted }), 2027)).toEqual({ book: 228, tax: 228, difference: 0 })
  })

  it('a non-book method ignores the book postings and capex events', () => {
    const posted = new Map(Array.from({ length: 12 }, (_, i) => [`2027-${String(i + 1).padStart(2, '0')}`, 9] as [string, number]))
    expect(taxDepreciationSchedule(base({ taxMethod: 'straight_line', taxLifeYears: 5, capex: [], posted }))[0]).toMatchObject({ year: 2027, amount: 120 })
  })
})
