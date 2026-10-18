import { describe, it, expect } from 'vitest'
import {
  accrue, contribute, distribute, emptyState, prefLedger, replay, toWaterfallState, validateCashTerms, yearFraction,
  type CashDistribution, type CashTermsInput, type CashWaterfallTerms, type WaterfallEvent,
} from './waterfall'
import {
  F1, F2, F3, F4, F5, F6, F8, PACK_INPUTS, PACK_MANAGER, PACK_SCENARIOS, PACK_SERVERS, PACK_TERMS,
  packDistributableCash, packRate, type ExpectedYear, type PackScenarioId,
} from './fixtures/pack-v3'
import { irrOf } from '@/lib/accounting/construction-forecast'
import { roundCents } from '@/lib/accounting/ledger'

const CAPITAL = PACK_INPUTS.capital
const LP = 'lp'
const c = (n: number) => Math.round(n * 100)
const sumC = (xs: { amount: number }[]) => xs.reduce((s, x) => s + c(x.amount), 0)

/** Within ±$1, the plan's per-year tolerance. */
function near(actual: number, expected: number, label: string) {
  expect(Math.abs(actual - expected), `${label}: ${actual} vs ${expected}`).toBeLessThanOrEqual(1)
}

/** Plan §3.4 step 5, exactly: the tiers, and every line, add back to D to the cent. */
function assertIdentity(r: CashDistribution, D: number) {
  const t = r.tiers
  expect(c(t.contingencyReturn) + c(t.preferred) + c(t.returnOfCapital) + c(t.managerRocShare) + c(t.profitToLP) + c(t.carry)).toBe(c(D))
  expect(sumC(r.lines) + sumC(r.carryLines)).toBe(c(D))
  expect(c(t.toLP) + c(t.toGP)).toBe(c(D))
  expect(r.lines.reduce((s, l) => s + c(l.preferred), 0)).toBe(c(t.preferred))
  expect(r.lines.reduce((s, l) => s + c(l.roc), 0)).toBe(c(t.returnOfCapital))
  expect(r.lines.reduce((s, l) => s + c(l.profit), 0)).toBe(c(t.profitToLP))
  expect(r.lines.reduce((s, l) => s + c(l.contingencyReturn), 0)).toBe(c(t.contingencyReturn))
  for (const l of r.lines) expect(c(l.amount)).toBe(c(l.contingencyReturn) + c(l.preferred) + c(l.roc) + c(l.profit))
  expect(sumC(r.carryLines)).toBe(c(t.toGP))
}

/** Contribute at Y0, then one distribution a year on the pack's cadence (periodFraction 1). */
function runPeriodic(
  distributions: number[],
  investors: { lpEntityId: string; amount: number }[] = [{ lpEntityId: LP, amount: CAPITAL }],
  terms: CashWaterfallTerms = PACK_TERMS,
): CashDistribution[] {
  let state = emptyState(F8.contributionDate)
  for (const i of investors) state = contribute(state, { kind: 'contribution', date: F8.contributionDate, ...i })
  return distributions.map((D, k) => {
    const r = distribute(state, D, F8.distributionDates[k], terms, 1)
    assertIdentity(r, D)
    state = r.state
    return r
  })
}

function runScenario(id: PackScenarioId) {
  const years = packDistributableCash(id)
  return { years, results: runPeriodic(years.map(y => y.distributable)) }
}

function investorReturns(results: CashDistribution[]) {
  const toLP = results.map(r => r.tiers.toLP)
  const irr = irrOf([{ t: 0, amount: -CAPITAL }, ...toLP.map((amount, i) => ({ t: i + 1, amount }))])
  const total = toLP.reduce((s, x) => s + x, 0)
  return {
    total,
    irrPct: irr == null ? null : Math.round(irr * 1000) / 10,
    multiple: Math.round((total / CAPITAL) * 100) / 100,
  }
}

function assertYears(id: PackScenarioId, expected: ExpectedYear[]) {
  const { years, results } = runScenario(id)
  expected.forEach((e, k) => {
    const y = years[k]
    const t = results[k].tiers
    const at = `${id} Y${k + 1}`
    near(y.revenue, e.revenue, `${at} revenue`)
    near(y.operatingProfit, e.operatingProfit, `${at} op. profit`)
    expect(y.sale).toBe(e.sale)
    near(y.fee, e.fee, `${at} fee`)
    near(y.distributable, e.distributable, `${at} distributable`)
    near(k === 0 ? CAPITAL : results[k - 1].tiers.unreturnedAfter, e.unreturnedStart, `${at} unreturned at start`)
    near(t.preferred, e.pref, `${at} pref`)
    near(t.prefCarriedForward, e.prefCarriedForward, `${at} pref c/f`)
    near(t.returnOfCapital, e.roc, `${at} ROC`)
    near(t.profitToLP, e.profitToLP, `${at} profit to investors`)
    near(t.carry, e.carry, `${at} carry`)
    near(t.toLP, e.toLP, `${at} to investors`)
    near(roundSum(y.fee, t.toGP), e.toManager, `${at} to manager`)
  })
  return { years, results }
}
/** Five-year totals within ±$1, summed from the unrounded (cents) figures. */
function assertTotals(id: PackScenarioId, results: CashDistribution[], e: { fee: number; pref: number; roc: number; toLP: number }) {
  const total = (f: (r: CashDistribution) => number) => results.reduce((s, r) => s + f(r), 0)
  near(packDistributableCash(id).reduce((s, y) => s + y.fee, 0), e.fee, `${id} total fee`)
  near(total(r => r.tiers.preferred), e.pref, `${id} total pref`)
  near(total(r => r.tiers.returnOfCapital), e.roc, `${id} total ROC`)
  near(total(r => r.tiers.toLP), e.toLP, `${id} total to investors`)
}
const roundSum = (...xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100

describe('packDistributableCash (the pack operating model)', () => {
  it('Base: cents-level distributable cash', () => {
    expect(packDistributableCash('base').map(y => y.distributable)).toEqual(F1.distributableCents)
  })

  it('Base: revenue by type, expenses and Y5 rates match the pack', () => {
    const years = packDistributableCash('base')
    for (const s of PACK_SERVERS) {
      near(years[0].revenueByType[s], F1.revenueByType.y1[s], `Y1 ${s}`)
      near(years[4].revenueByType[s], F1.revenueByType.y5[s], `Y5 ${s}`)
      expect(Math.round(packRate(PACK_SCENARIOS.base, s, 5) * 100) / 100).toBe(F1.y5Rates[s])
    }
    years.forEach((y, k) => {
      near(y.datacenter, F1.datacenter[k], `Y${k + 1} datacenter`)
      near(y.contingency, F1.contingency[k], `Y${k + 1} contingency`)
      near(y.processing, F1.processing[k], `Y${k + 1} processing`)
      expect(y.insurance).toBe(F1.insurance)
    })
  })

  it('accepts a scenario object as well as an id', () => {
    expect(packDistributableCash(PACK_SCENARIOS.base)).toEqual(packDistributableCash('base'))
  })
})

describe('F1: Base case', () => {
  it('every per-year figure is within $1 of the pack', () => {
    assertYears('base', F1.years)
  })

  it('Y3 in cents', () => {
    const t = runScenario('base').results[2].tiers
    expect(t.preferred).toBe(F1.y3Cents.pref)
    expect(t.returnOfCapital).toBe(F1.y3Cents.roc)
    expect(t.carry).toBe(F1.y3Cents.carry)
    expect(t.profitToLP).toBe(F1.y3Cents.profitToLP)
  })

  it('five-year totals, IRR 33.6% and 2.02x, nothing unreturned, manager 220,264 + 549,824', () => {
    const { years, results } = runScenario('base')
    const total = (f: (r: CashDistribution) => number) => results.reduce((s, r) => s + f(r), 0)
    near(total(r => r.tiers.preferred), F1.totals.pref, 'pref')
    near(total(r => r.tiers.returnOfCapital), F1.totals.roc, 'ROC')
    near(total(r => r.tiers.profitToLP), F1.totals.profitToLP, 'profit')
    near(total(r => r.tiers.carry), F1.totals.carry, 'carry')
    near(total(r => r.tiers.toLP), F1.totals.toLP, 'to investors')
    near(years.reduce((s, y) => s + y.fee, 0), F1.totals.fee, 'fees')
    near(years.reduce((s, y) => s + y.revenue, 0), F1.totals.revenue, 'revenue')
    near(years.reduce((s, y) => s + y.distributable, 0), F1.totals.distributable, 'distributable')
    near(years.reduce((s, y) => s + y.fee, 0) + total(r => r.tiers.toGP), F1.totals.toManager, 'manager total')

    const ret = investorReturns(results)
    expect(ret.irrPct).toBe(F1.irrPct)
    expect(ret.multiple).toBe(F1.multiple)
    expect(results[4].tiers.unreturnedAfter).toBe(F1.unreturnedAtClose)
    expect(results[4].state.carryPaid).toBe(roundSum(...results.map(r => r.tiers.carry)))
  })

  it('carry lines go to the recipient', () => {
    const y3 = runScenario('base').results[2]
    expect(y3.carryLines).toEqual([{ lpEntityId: PACK_MANAGER, amount: F1.y3Cents.carry }])
  })
})

describe('F2 / F3: Oversupply stress cases', () => {
  it('F2 (60%): per-year within $1, $116,118 unreturned at close, 5.5%, 1.14x, no profit share ever', () => {
    const { results } = assertYears('oversupply_60', F2.years)
    near(results[4].tiers.unreturnedAfter, F2.unreturnedAtClose, 'unreturned at close')
    expect(results.every(r => r.tiers.profitToLP === 0 && r.tiers.carry === 0 && r.carryLines.length === 0)).toBe(true)
    const ret = investorReturns(results)
    near(ret.total, F2.totals.toLP, 'to investors')
    assertTotals('oversupply_60', results, F2.totals)
    expect(ret.irrPct).toBe(F2.irrPct)
    expect(ret.multiple).toBe(F2.multiple)
  })

  it('F3 (50%): per-year within $1, $584,843 unreturned at close, -5.2%, 0.87x', () => {
    const { results } = assertYears('oversupply_50', F3.years)
    near(results[4].tiers.unreturnedAfter, F3.unreturnedAtClose, 'unreturned at close')
    expect(results.every(r => r.tiers.carry === 0)).toBe(true)
    const ret = investorReturns(results)
    near(ret.total, F3.totals.toLP, 'to investors')
    assertTotals('oversupply_50', results, F3.totals)
    expect(ret.irrPct).toBe(F3.irrPct)
    expect(ret.multiple).toBe(F3.multiple)
  })
})

describe('F4: Balanced, Demand-led, Oversupply 75%', () => {
  for (const e of Object.values(F4)) {
    it(`${e.scenario}: per-year fee, pref, ROC, profit, carry and to-investors within $1`, () => {
      const { years, results } = runScenario(e.scenario)
      results.forEach((r, k) => {
        const at = `${e.scenario} Y${k + 1}`
        near(years[k].fee, e.fee[k], `${at} fee`)
        near(r.tiers.preferred, e.pref[k], `${at} pref`)
        near(r.tiers.returnOfCapital, e.roc[k], `${at} ROC`)
        near(r.tiers.profitToLP, e.profitToLP[k], `${at} profit`)
        near(r.tiers.carry, e.carry[k], `${at} carry`)
        near(r.tiers.toLP, e.toLP[k], `${at} to investors`)
        expect(r.tiers.prefCarriedForward).toBe(0)
      })
      const ret = investorReturns(results)
      near(ret.total, e.totalToLP, 'total to investors')
      assertTotals(e.scenario, results, { fee: e.totalFee, pref: e.totalPref, roc: e.totalRoc, toLP: e.totalToLP })
      near(results.reduce((s, r) => s + r.tiers.carry, 0), e.totalCarry, 'total carry')
      expect(ret.multiple).toBe(e.multiple)
      expect(ret.irrPct).toBe(e.irrPct)
    })
  }

  it('Demand-led Y2: ROC completes and the split begins inside one distribution', () => {
    const { results } = runScenario('demand_led')
    const y1 = results[0].tiers
    const y2 = results[1].tiers
    expect(y1.unreturnedAfter).toBeGreaterThan(0)
    expect(y2.returnOfCapital).toBe(y1.unreturnedAfter)
    expect(y2.unreturnedAfter).toBe(0)
    near(y2.preferred, 53_418, 'pref')
    near(y2.returnOfCapital, 667_727, 'ROC')
    near(y2.profitToLP, 222_190, 'profit')
    near(y2.carry, 95_224, 'carry')
    near(y2.profitToLP + y2.carry, 317_415, 'left after capital')
  })

  it('Oversupply Y4: ROC completes and the split begins inside one distribution', () => {
    const { results } = runScenario('oversupply')
    const y3 = results[2].tiers
    const y4 = results[3].tiers
    expect(y3.unreturnedAfter).toBeGreaterThan(0)
    expect(y3.carry).toBe(0)
    expect(y4.returnOfCapital).toBe(y3.unreturnedAfter)
    expect(y4.unreturnedAfter).toBe(0)
    near(y4.preferred, 2_183, 'pref')
    near(y4.returnOfCapital, 27_284, 'ROC')
    near(y4.profitToLP, 174_566, 'profit')
    near(y4.carry, 74_814, 'carry')
    near(y4.profitToLP + y4.carry, 249_380, 'left after capital')
  })
})

describe('F5: pref shortfall carried forward, non-compounding', () => {
  it('Y1 carries 64,840 forward; Y2 owes 179,680 (not 64,840 x 1.08); Y3 to the cent', () => {
    const results = runPeriodic(F5.distributions)
    F5.years.forEach((e, k) => {
      const t = results[k].tiers
      expect(t.prefDue).toBe(e.prefDue)
      expect(t.preferred).toBe(e.preferred)
      expect(t.prefCarriedForward).toBe(e.prefCarriedForward)
      expect(t.returnOfCapital).toBe(e.roc)
      expect(t.unreturnedAfter).toBe(e.unreturnedAfter)
      expect(t.profitToLP).toBe(e.profitToLP)
      expect(t.carry).toBe(e.carry)
    })
  })

  it('the pref ledger brings 64,840 forward into Y2, and every row ties', () => {
    const events: WaterfallEvent[] = [
      { kind: 'contribution', date: F8.contributionDate, lpEntityId: LP, amount: CAPITAL },
      ...F5.distributions.map((amount, k) => ({ kind: 'distribution' as const, date: F8.distributionDates[k], amount, periodFraction: 1 })),
    ]
    const rows = prefLedger(events, PACK_TERMS)
    expect(rows).toHaveLength(4)
    for (const r of rows) expect(c(r.broughtForward) + c(r.accrued) - c(r.paid)).toBe(c(r.carriedForward))
    expect(rows[1]).toMatchObject({ periodStart: '2027-01-01', periodEnd: '2028-01-01', unreturnedStart: CAPITAL, broughtForward: 0, accrued: 114_840, paid: 50_000, carriedForward: 64_840 })
    expect(rows[2]).toMatchObject({ broughtForward: 64_840, accrued: 114_840, paid: 179_680, carriedForward: 0 })
    expect(rows[3]).toMatchObject({ unreturnedStart: 1_315_180, broughtForward: 0, accrued: 105_214.4, paid: 105_214.4, carriedForward: 0 })
    expect(rows[1].perInvestor).toEqual([{ lpEntityId: LP, accrued: 114_840, paid: 50_000, carriedForward: 64_840, unreturnedEnd: CAPITAL }])
  })
})

describe('F6: two investors, cents placement', () => {
  it('per-investor lines exact, each year sums to D, vehicle tiers equal F1 in cents', () => {
    const two = runPeriodic(F1.distributableCents, F6.investors)
    const one = runPeriodic(F1.distributableCents)
    two.forEach((r, k) => expect(r.tiers).toEqual(one[k].tiers))
    F6.years.forEach((e, k) => {
      const r = two[k]
      expect(r.lines.map(l => l.lpEntityId)).toEqual(['A', 'B'])
      expect(r.lines.map(l => l.preferred)).toEqual(e.pref)
      expect(r.lines.map(l => l.roc)).toEqual(e.roc)
      expect(r.lines.map(l => l.profit)).toEqual(e.profit)
      expect(r.state.investors.map(i => i.unreturned)).toEqual(e.unreturnedAfter)
      expect(r.tiers.carry).toBe(e.carry)
    })
  })
})

describe('F8: dated replay equals periodic', () => {
  const events: WaterfallEvent[] = [
    { kind: 'contribution', date: F8.contributionDate, lpEntityId: LP, amount: CAPITAL },
    ...F1.distributableCents.map((amount, k) => ({ kind: 'distribution' as const, date: F8.distributionDates[k], amount })),
  ]
  const dated = (dayCount: CashWaterfallTerms['dayCount']) => {
    const terms = { ...PACK_TERMS, dayCount }
    return F8.distributionDates.map((date, k) => {
      const r = distribute(replay(events.slice(0, k + 1), terms, date), F1.distributableCents[k], date, terms)
      assertIdentity(r, F1.distributableCents[k])
      return r
    })
  }

  it("30/360 reproduces F1's tiers to the cent", () => {
    const periodic = runPeriodic(F1.distributableCents)
    dated('30_360').forEach((r, k) => expect(r.tiers).toEqual(periodic[k].tiers))
    expect(replay(events, { ...PACK_TERMS, dayCount: '30_360' }, '2032-01-01')).toEqual(periodic[4].state)
  })

  it('ACT/365: the 2028 leap year makes the Y2 pref 783,832.44 x 0.08 x 366/365', () => {
    const r = dated('act_365')
    expect(r[0].tiers.preferred).toBe(114_840)
    expect(r[0].tiers.unreturnedAfter).toBe(783_832.44)
    expect(r[1].tiers.prefDue).toBe(F8.act365Y2PrefCents)
    expect(r[1].tiers.preferred).toBe(62_878.39)
  })

  it('replay ignores events after asOf and accrues to asOf', () => {
    const terms = { ...PACK_TERMS, dayCount: '30_360' as const }
    const s = replay(events, terms, '2028-07-01')
    expect(s.asOf).toBe('2028-07-01')
    expect(s.investors[0].unreturned).toBe(783_832.44)
    expect(s.investors[0].prefAccrued - s.investors[0].prefPaid).toBeCloseTo(783_832.44 * 0.08 * 0.5, 6)
  })
})

describe('distribute: other paths', () => {
  it('R8: with no pref due and capital unreturned, the whole distribution is return of capital', () => {
    // Y1 pays the pref in full; unspent contingency returned the same day finds no pref due.
    const [y1] = runPeriodic([F1.distributableCents[0]])
    const r = distribute(y1.state, 130_500, F8.distributionDates[0], PACK_TERMS, 0)
    assertIdentity(r, 130_500)
    expect(r.tiers.prefDue).toBe(0)
    expect(r.tiers.returnOfCapital).toBe(130_500)
    expect(r.tiers.unreturnedAfter).toBe(roundSum(783_832.44, -130_500))
    expect(r.tiers.toGP).toBe(0)
  })

  it('rocLpShare < 1 gives the manager its share of the capital flow, inside the identity', () => {
    const terms: CashWaterfallTerms = { ...PACK_TERMS, prefRate: 0, rocLpShare: 0.8 }
    const [r] = runPeriodic([2_000], [{ lpEntityId: LP, amount: 1_000 }], terms)
    expect(r.tiers.returnOfCapital).toBe(1_000)
    expect(r.tiers.managerRocShare).toBe(250)
    expect(r.tiers.carry).toBe(225)
    expect(r.tiers.profitToLP).toBe(525)
    expect(r.state.managerRocPaid).toBe(250)
    expect(r.state.carryPaid).toBe(475)
  })

  it('splits the manager take across recipients by pct, the last absorbing the cent', () => {
    const terms: CashWaterfallTerms = {
      ...PACK_TERMS, recipients: [{ lpEntityId: 'gp1', pct: 33.33 }, { lpEntityId: 'gp2', pct: 66.67 }],
    }
    const r = runPeriodic(F1.distributableCents, undefined, terms)[2]
    expect(r.carryLines).toEqual([
      { lpEntityId: 'gp1', amount: 52_012.42 },
      { lpEntityId: 'gp2', amount: roundSum(156_052.87, -52_012.42) },
    ])
  })

  it('toWaterfallState projects the cumulative position', () => {
    const r = runPeriodic(F1.distributableCents)
    expect(toWaterfallState(r[1].state)).toEqual({
      contributedCapital: CAPITAL,
      returnedCapital: roundSum(CAPITAL, -132_578.96),
      preferredPaid: 177_546.6,
      preferredTarget: 177_546.6,
      gpCarryPaid: 0,
    })
    expect(toWaterfallState(r[2].state).gpCarryPaid).toBe(156_052.87)
  })

  it('refuses a periodic accrual without a fraction, a backwards accrual, and an unaccrued top-up', () => {
    const s = contribute(emptyState('2027-01-01'), { kind: 'contribution', date: '2027-01-01', lpEntityId: LP, amount: 100 })
    expect(() => accrue(s, '2028-01-01', PACK_TERMS)).toThrow(/periodFraction/)
    const later = accrue(s, '2028-01-01', { ...PACK_TERMS, dayCount: 'act_365' })
    expect(() => accrue(later, '2027-06-01', { ...PACK_TERMS, dayCount: 'act_365' })).toThrow(/backwards/)
    expect(() => contribute(s, { kind: 'contribution', date: '2027-06-01', lpEntityId: LP, amount: 1 })).toThrow(/Accrue/)
  })
})

describe('validateCashTerms', () => {
  const ok: CashTermsInput = { ...PACK_TERMS, dayCount: '30_360', catchupRate: 1, prefCompounds: false, prefBasis: 'unreturned' }

  it('accepts the pack terms, and a 60/40 recipient split', () => {
    expect(validateCashTerms(ok)).toBeNull()
    expect(validateCashTerms(PACK_TERMS)).toBeNull()
    expect(validateCashTerms({ ...ok, recipients: [{ lpEntityId: 'm', pct: 60 }, { lpEntityId: 'n', pct: 40 }] })).toBeNull()
  })

  it.each<[string, Partial<CashTermsInput>, RegExp]>([
    ['catch-up other than 1', { catchupRate: 0.8 }, /catch-up/],
    ['a compounding pref', { prefCompounds: true }, /compound/],
    ['a pref basis other than unreturned', { prefBasis: 'contributed' }, /unreturned/],
    ['an unknown day count', { dayCount: 'act_360' }, /Day count/],
    ['a pref rate of 1', { prefRate: 1 }, /Preferred return/],
    ['a negative pref rate', { prefRate: -0.01 }, /Preferred return/],
    ['a zero ROC share', { rocLpShare: 0 }, /return of capital/],
    ['a ROC share above 1', { rocLpShare: 1.1 }, /return of capital/],
    ['a zero carry rate', { carryRate: 0 }, /profit share/],
    ['a carry rate of 1', { carryRate: 1 }, /profit share/],
    ['no recipient', { recipients: [] }, /receives/],
    ['recipients not totalling 100', { recipients: [{ lpEntityId: 'm', pct: 60 }] }, /total 100/],
    ['a recipient pct above 100 offset by a negative one', { recipients: [{ lpEntityId: 'm', pct: 150 }, { lpEntityId: 'n', pct: -50 }] }, /at most 100/],
    ['a NaN recipient pct', { recipients: [{ lpEntityId: 'm', pct: NaN }, { lpEntityId: 'n', pct: 100 }] }, /at most 100/],
  ])('rejects %s', (_, over, message) => {
    expect(validateCashTerms({ ...ok, ...over })).toMatch(message)
  })
})

describe('regressions from review', () => {
  const FOUR: CashWaterfallTerms['recipients'] = [
    { lpEntityId: 'g1', pct: 30 }, { lpEntityId: 'g2', pct: 30 }, { lpEntityId: 'g3', pct: 30 }, { lpEntityId: 'g4', pct: 10 },
  ]

  it('recipient split: a 2-cent manager take across 30/30/30/10 conserves the cents, no negative line', () => {
    const terms: CashWaterfallTerms = { ...PACK_TERMS, prefRate: 0, recipients: FOUR }
    const [, r] = runPeriodic([100, 0.07], [{ lpEntityId: LP, amount: 100 }], terms)
    expect(r.tiers.carry).toBe(0.02)
    expect(r.carryLines.every(l => l.amount >= 0)).toBe(true)
    expect(sumC(r.carryLines)).toBe(2)
    assertIdentity(r, 0.07)
  })

  it('recipient split: over 100 random amounts the carry lines always sum to carry + manager ROC share', () => {
    let seed = 42
    const rand = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648
    const sets = [FOUR, [{ lpEntityId: 'g1', pct: 33 }, { lpEntityId: 'g2', pct: 33 }, { lpEntityId: 'g3', pct: 33 }, { lpEntityId: 'g4', pct: 1 }]]
    for (let k = 0; k < 100; k++) {
      const terms: CashWaterfallTerms = { ...PACK_TERMS, prefRate: 0, rocLpShare: 0.8, recipients: sets[k % 2] }
      const D = Math.round(rand() * 50_000) / 100
      const [r] = runPeriodic([D], [{ lpEntityId: LP, amount: 100 }], terms)
      expect(sumC(r.carryLines)).toBe(c(r.tiers.carry) + c(r.tiers.managerRocShare))
      expect(r.carryLines.every(l => l.amount > 0)).toBe(true)
    }
  })

  describe('30_360 is 30E/360, additive across any split of a period', () => {
    const t30: CashWaterfallTerms = { ...PACK_TERMS, dayCount: '30_360' }
    const t365: CashWaterfallTerms = { ...PACK_TERMS, dayCount: 'act_365' }
    const A: WaterfallEvent = { kind: 'contribution', date: '2027-01-01', lpEntityId: 'A', amount: 4_500 }
    const B: WaterfallEvent = { kind: 'contribution', date: '2027-01-31', lpEntityId: 'B', amount: 1_000 }
    const owedA = (s: ReturnType<typeof replay>) => {
      const a = s.investors.find(i => i.lpEntityId === 'A')!
      return a.prefAccrued - a.prefPaid
    }

    it('month-end legs that crossed the 31st no longer gain or lose a day', () => {
      expect(yearFraction('2027-02-28', '2027-03-31', '30_360') * 360).toBeCloseTo(32, 9)
      expect(yearFraction('2027-01-15', '2027-03-31', '30_360') * 360).toBeCloseTo(75, 9)
      expect(yearFraction('2027-03-30', '2027-03-31', '30_360')).toBe(0)
      expect(yearFraction('2027-01-01', '2028-01-01', '30_360')).toBe(1)
    })

    for (const [name, terms, expected] of [['30_360', t30, 30], ['act_365', t365, 4_500 * 0.08 * 31 / 365]] as const) {
      it(`${name}: B contributing on 2027-01-31, or an intermediate accrual, leaves A's pref to 2027-02-01 unchanged`, () => {
        const alone = owedA(replay([A], terms, '2027-02-01'))
        const withB = owedA(replay([A, B], terms, '2027-02-01'))
        const stepped = owedA(accrue(accrue(replay([A], terms, '2027-01-01'), '2027-01-31', terms), '2027-02-01', terms))
        expect(alone).toBeCloseTo(expected, 9)
        expect(withB).toBeCloseTo(alone, 9)
        expect(stepped).toBeCloseTo(alone, 9)
      })

      it(`${name}: twelve month-end accruals on $1,000,000 at 8% total exactly 80,000.00`, () => {
        const ends = ['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30', '2027-05-31', '2027-06-30',
          '2027-07-31', '2027-08-31', '2027-09-30', '2027-10-31', '2027-11-30', '2027-12-31']
        let s = contribute(emptyState('2026-12-31'), { kind: 'contribution', date: '2026-12-31', lpEntityId: LP, amount: 1_000_000 })
        for (const d of ends) s = accrue(s, d, terms)
        expect(roundCents(s.investors[0].prefAccrued)).toBe(80_000)
        // The reviewer's case: monthly zero distributions through the ledger carry exactly 80,000 forward.
        const rows = prefLedger([
          { kind: 'contribution', date: '2026-12-31', lpEntityId: LP, amount: 1_000_000 },
          ...ends.map(date => ({ kind: 'distribution' as const, date, amount: 0 })),
        ], terms)
        expect(rows[rows.length - 1].carriedForward).toBe(80_000)
      })
    }
  })

  it('contribute rejects a zero or negative amount', () => {
    const s = emptyState('2027-01-01')
    expect(() => contribute(s, { kind: 'contribution', date: '2027-01-01', lpEntityId: LP, amount: -500 })).toThrow(/positive/)
    expect(() => contribute(s, { kind: 'contribution', date: '2027-01-01', lpEntityId: LP, amount: 0 })).toThrow(/positive/)
  })

  it('pref ledger per-investor carried forward ties to the row total', () => {
    const events: WaterfallEvent[] = [
      ...['a', 'b', 'c'].map(id => ({ kind: 'contribution' as const, date: '2027-01-01', lpEntityId: id, amount: 1 })),
      { kind: 'distribution', date: '2027-02-01', amount: 0, periodFraction: 0.0625 },
    ]
    const row = prefLedger(events, PACK_TERMS).at(-1)!
    expect(c(row.carriedForward)).toBeGreaterThan(0)
    expect(row.perInvestor!.reduce((s, i) => s + c(i.carriedForward), 0)).toBe(c(row.carriedForward))
  })
})

describe('R8: unspent contingency returned before the tiers', () => {
  const start = () => contribute(emptyState(F8.contributionDate), { kind: 'contribution', date: F8.contributionDate, lpEntityId: LP, amount: CAPITAL })

  it('a zero contingency return leaves F1 byte-identical, through replay too', () => {
    const plain = runPeriodic(F1.distributableCents)
    let state = start()
    F1.distributableCents.forEach((D, k) => {
      const r = distribute(state, D, F8.distributionDates[k], PACK_TERMS, 1, { contingencyReturn: 0 })
      expect(r).toEqual(plain[k])
      state = r.state
    })
  })

  it('$130,500 returned at Y0 + 1 day: unreturned 1,305,000, Y1 pref 104,400, no carry', () => {
    const r0 = distribute(start(), 130_500, '2027-01-02', PACK_TERMS, 0, { contingencyReturn: 130_500 })
    assertIdentity(r0, 130_500)
    expect(r0.tiers).toMatchObject({ contingencyReturn: 130_500, preferred: 0, returnOfCapital: 0, carry: 0, toGP: 0, unreturnedAfter: 1_305_000, toLP: 130_500 })
    expect(r0.carryLines).toEqual([])
    const r1 = distribute(r0.state, F1.distributableCents[0], F8.distributionDates[0], PACK_TERMS, 1)
    assertIdentity(r1, F1.distributableCents[0])
    expect(r1.tiers.preferred).toBe(104_400)
  })

  it('caps at the capital unreturned; the excess runs through the tiers', () => {
    const [y1, y2, y3] = runPeriodic(F1.distributableCents.slice(0, 3))
    expect(y2.tiers.unreturnedAfter).toBe(132_578.96)
    const r = distribute(y2.state, 200_000, F8.distributionDates[2], PACK_TERMS, 0, { contingencyReturn: 200_000 })
    assertIdentity(r, 200_000)
    expect(r.tiers.contingencyReturn).toBe(132_578.96)
    expect(r.tiers.unreturnedAfter).toBe(0)
    expect(r.tiers.returnOfCapital).toBe(0)
    expect(r.tiers.carry).toBe(roundCents((200_000 - 132_578.96) * 0.3))
    expect(y1.tiers.contingencyReturn + y3.tiers.contingencyReturn).toBe(0)
  })

  it('refuses a contingency above the distribution or below zero', () => {
    expect(() => distribute(start(), 100, '2027-01-02', PACK_TERMS, 0, { contingencyReturn: 101 })).toThrow(/contingency/)
    expect(() => distribute(start(), 100, '2027-01-02', PACK_TERMS, 0, { contingencyReturn: -1 })).toThrow(/contingency/)
  })

  it('two investors: cents by unreturned capital, tied to the tier, and replay reproduces it', () => {
    const events: WaterfallEvent[] = [
      ...F6.investors.map(i => ({ kind: 'contribution' as const, date: F8.contributionDate, ...i })),
      { kind: 'distribution', date: '2027-01-02', amount: 130_500.01, periodFraction: 0, contingencyReturn: 130_500.01 },
      { kind: 'distribution', date: F8.distributionDates[0], amount: F1.distributableCents[0], periodFraction: 1 },
    ]
    let state = replay(events.slice(0, 2), PACK_TERMS, F8.contributionDate)
    const r = distribute(state, 130_500.01, '2027-01-02', PACK_TERMS, 0, { contingencyReturn: 130_500.01 })
    assertIdentity(r, 130_500.01)
    expect(r.lines.map(l => l.contingencyReturn)).toEqual([90_909.1, 39_590.91])
    state = r.state
    const y1 = distribute(state, F1.distributableCents[0], F8.distributionDates[0], PACK_TERMS, 1)
    expect(replay(events, PACK_TERMS, F8.distributionDates[0])).toEqual(y1.state)
  })
})
