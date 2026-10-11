import { describe, expect, it } from 'vitest'
import { computeCapital, DEFAULT_CAPITAL, splitDistributions, validateCapital, CapitalError } from './capital'

const months = ['2027-01', '2027-02', '2027-03', '2027-04'] as const
const m = (o: Record<string, number>) => new Map(Object.entries(o)) as any

describe('calls and distributions, month by month', () => {
  it('calls what a month needs below the reserve, and distributes exit proceeds when they arrive', () => {
    const r = computeCapital({
      months: [...months], openingCash: 50_000, uncalled: 5_000_000,
      cashFlows: m({ '2027-01': -1_000_000, '2027-03': 3_000_000 }), proceeds: m({ '2027-03': 3_000_000 }),
      settings: validateCapital({ policy: { calls: { reserve: 100_000 } } }),
    })
    expect(r.calls.get('2027-01')).toBe(1_050_000) // back to the 100k reserve
    expect(r.distributions.get('2027-03')).toBe(3_000_000)
    expect(r.endingCash.get('2027-04')).toBe(100_000)
  })

  it('pays out after the lag, keeping the distribution reserve', () => {
    const r = computeCapital({
      months: [...months], openingCash: 0, uncalled: 0,
      cashFlows: m({ '2027-01': 1_000_000 }), proceeds: m({ '2027-01': 1_000_000 }),
      settings: validateCapital({ policy: { distributions: { lagMonths: 2, reserve: 200_000 } } }),
    })
    expect(r.distributions.get('2027-01')).toBeUndefined()
    expect(r.distributions.get('2027-03')).toBe(800_000)
    expect(r.warnings[0]).toMatch(/200,000 of exit proceeds is not distributed/)
  })

  it('a month you set wins over the policy — for that month only', () => {
    const r = computeCapital({
      months: [...months], openingCash: 0, uncalled: 1_000_000,
      cashFlows: m({ '2027-02': 2_000_000 }), proceeds: m({ '2027-02': 2_000_000 }),
      settings: validateCapital({ calls: { '2027-01': 250_000 }, distributions: { '2027-02': 500_000 } }),
    })
    expect(r.calls.get('2027-01')).toBe(250_000)
    expect(r.distributions.get('2027-02')).toBe(500_000)
    expect(r.distributions.get('2027-03')).toBe(1_500_000) // the rest of the proceeds still owed
  })

  it('never calls more than is uncalled, and says so', () => {
    const r = computeCapital({ months: ['2027-01'], openingCash: 0, uncalled: 100, cashFlows: m({ '2027-01': -1_000 }), proceeds: new Map(), settings: DEFAULT_CAPITAL })
    expect(r.calls.get('2027-01')).toBe(100)
    expect(r.warnings[0]).toMatch(/no uncalled capital left/)
  })

  it('refuses a malformed edit', () => {
    expect(() => validateCapital({ calls: { 'March': 5 } })).toThrow(CapitalError)
  })
})

describe('the waterfall on what is actually distributed', () => {
  const wf = {
    asOf: '2026-12-31', kind: 'european' as const, carryRate: 0.2, prefRate: 0, catchupRate: 1, prefCompounds: true,
    lpCommitmentShare: 0.99, lpCalledCapital: 990_000, lpDistributedCapital: 0, fundDistributedCapital: 0, lpNav: 0,
    contributions: [{ date: '2025-01-01', amount: 990_000 }],
  }

  it("returns the LPs' capital first, then takes carry on their gain only — the GP's stake bears none", () => {
    const s = splitDistributions(m({ '2027-02': 3_000_000 }), new Map(), [...months], wf)
    const feb = s.get('2027-02')!
    expect(feb.toGpStake).toBe(30_000) // 1% stake, in full
    // LPs' 2,970,000: 990,000 back, then 1,980,000 of gain split 80/20.
    expect(feb.carry).toBeCloseTo(396_000, 0)
    expect(feb.toLp + feb.carry + feb.toGpStake).toBeCloseTo(3_000_000, 2)
  })

  it('without carry terms, everything goes to the partners', () => {
    expect(splitDistributions(m({ '2027-02': 100 }), new Map(), [...months], undefined).get('2027-02')).toEqual({ toLp: 100, carry: 0, toGpStake: 0 })
  })
})

describe('capital settings are bounded', () => {
  it('refuses amounts past what the ledger can hold, and an unbounded list of month edits', () => {
    expect(() => validateCapital({ policy: { calls: { reserve: 1e17 } } })).toThrow(CapitalError)
    expect(() => validateCapital({ calls: { '2027-01': 1e15 } })).toThrow(CapitalError)
    const many = Object.fromEntries(Array.from({ length: 1201 }, (_, i) => [`${2000 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`, 1]))
    expect(() => validateCapital({ distributions: many })).toThrow(/too many/)
  })
})
