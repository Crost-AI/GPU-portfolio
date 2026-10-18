import { describe, it, expect } from 'vitest'
import {
  CADENCE_LABELS, FleetRegisterUnavailableError, ScenarioInputError, resolveFleet, runFleetScenario,
  type FleetAssumptions, type FleetScenarioResult, type PeriodRow, type WaterfallRow,
} from './scenario'
import {
  F1, F2, F3, F4, PACK_INPUTS, PACK_SCENARIOS, PACK_SERVERS, packDistributableCash,
  type ExpectedYear, type PackScenarioId,
} from './fixtures/pack-v3'
import { PACK_FLEET, PACK_SCENARIO_TERMS, packAssumptions } from './fixtures/pack-v3-fleet'

const CAPITAL = PACK_INPUTS.capital
const IDS = Object.keys(PACK_SCENARIOS) as PackScenarioId[]
const c = (n: number) => Math.round(n * 100)

/** Within ±$1, the plan's per-year and total tolerance (§3.10). */
function near(actual: number, expected: number, label: string) {
  expect(Math.abs(actual - expected), `${label}: ${actual} vs ${expected}`).toBeLessThanOrEqual(1)
}
const pct1 = (irr: number | null) => (irr == null ? null : Math.round(irr * 1000) / 10)
const x2 = (m: number) => Math.round(m * 100) / 100

function run(id: PackScenarioId, patch: Partial<FleetAssumptions> = {}): FleetScenarioResult {
  const a = packAssumptions(id, patch)
  return runFleetScenario(a, resolveFleet(a, null), PACK_SCENARIO_TERMS)
}

/**
 * The pack's §1 headline and §4 totals, verbatim. `recovered` is the project-basis year; null is
 * "not within fund life".
 */
const HEADLINE: Record<PackScenarioId, {
  utilization: number; multiple: number; irrPct: number; projectMultiple: number; projectIrrPct: number
  recovered: number | null; toInvestors: number; revenue: number; operatingProfit: number
  fees: number; carry: number; managerTotal: number; unreturnedAtClose: number
}> = {
  base: { utilization: 0.75, multiple: 2.02, irrPct: 33.6, projectMultiple: 2.56, projectIrrPct: 44.3, recovered: 2, toInvestors: 2_906_576, revenue: 4_405_272, operatingProfit: 3_546_164, fees: 220_264, carry: 549_824, managerTotal: 770_088, unreturnedAtClose: 0 },
  balanced: { utilization: 0.75, multiple: 2.29, irrPct: 39.4, projectMultiple: 2.97, projectIrrPct: 51.2, recovered: 2, toInvestors: 3_290_599, revenue: 4_993_200, operatingProfit: 4_128_212, fees: 249_660, carry: 718_453, managerTotal: 968_113, unreturnedAtClose: 0 },
  demand_led: { utilization: 0.75, multiple: 2.94, irrPct: 53.0, projectMultiple: 3.94, projectIrrPct: 68.1, recovered: 2, toInvestors: 4_214_544, revenue: 6_402_136, operatingProfit: 5_523_059, fees: 320_107, carry: 1_118_908, managerTotal: 1_439_015, unreturnedAtClose: 0 },
  oversupply: { utilization: 0.75, multiple: 1.43, irrPct: 17.2, projectMultiple: 1.65, projectIrrPct: 23.9, recovered: 3, toInvestors: 2_048_228, revenue: 3_088_181, operatingProfit: 2_242_243, fees: 154_409, carry: 170_106, managerTotal: 324_515, unreturnedAtClose: 0 },
  oversupply_60: { utilization: 0.6, multiple: 1.14, irrPct: 5.5, projectMultiple: 1.23, projectIrrPct: 8.7, recovered: 4, toInvestors: 1_637_756, revenue: 2_470_545, operatingProfit: 1_630_783, fees: 123_527, carry: 0, managerTotal: 123_527, unreturnedAtClose: 116_118 },
  oversupply_50: { utilization: 0.5, multiple: 0.87, irrPct: -5.2, projectMultiple: 0.94, projectIrrPct: -2.3, recovered: null, toInvestors: 1_250_704, revenue: 2_058_787, operatingProfit: 1_223_143, fees: 102_939, carry: 0, managerTotal: 102_939, unreturnedAtClose: 584_843 },
}

/** Pack §3, "Resulting rate in Year 5", $/GPU-hour to the cent. */
const Y5_RATES: Record<'base' | 'balanced' | 'demand_led' | 'oversupply', Record<string, number>> = {
  base: F1.y5Rates,
  balanced: { h200_nvl: 4.5, b200: 5.5, b300: 9 },
  demand_led: { h200_nvl: 5.69, b200: 6.96, b300: 12.94 },
  oversupply: { h200_nvl: 2.05, b200: 2.03, b300: 3.32 },
}

/** Pack §5, Base cumulative cash flow Y0..Y5. */
const F1_CUMULATIVE = [-1_435_500, -620_309, 139_901, 847_199, 1_503_520, 2_241_164]

function assertYears(r: FleetScenarioResult, expected: ExpectedYear[], id: string) {
  expected.forEach((e, k) => {
    const o = r.operating[k + 1]
    const w = r.waterfall[k]
    const at = `${id} Y${k + 1}`
    near(o.revenue, e.revenue, `${at} revenue`)
    near(o.operatingProfit, e.operatingProfit, `${at} op. profit`)
    expect(o.saleProceeds, `${at} sale`).toBe(e.sale)
    near(w.fee, e.fee, `${at} fee`)
    near(w.distributable, e.distributable, `${at} distributable`)
    near(w.unreturnedStart, e.unreturnedStart, `${at} unreturned at start`)
    near(w.preferred, e.pref, `${at} pref`)
    near(w.prefCarriedForward, e.prefCarriedForward, `${at} pref c/f`)
    near(w.returnOfCapital, e.roc, `${at} ROC`)
    near(w.afterCapital, e.profitToLP + e.carry, `${at} after capital`)
    near(w.profitToLP, e.profitToLP, `${at} profit to investors`)
    near(w.carry, e.carry, `${at} carry`)
    near(w.toInvestors, e.toLP, `${at} to investors`)
    near(w.toManager, e.toManager, `${at} to manager`)
    expect(w.contingencyReturn).toBe(0)
  })
}

/** contingencyReturn + preferred + roc + managerRocShare + profitToLP + carry === D, to the cent. */
function assertIdentity(rows: (PeriodRow | WaterfallRow)[], label: string) {
  for (const p of rows) {
    const tiers = c(p.contingencyReturn) + c(p.preferred) + c(p.returnOfCapital) + c(p.managerRocShare) + c(p.profitToLP) + c(p.carry)
    expect(tiers, `${label} ${'period' in p ? `P${p.period}` : `Y${p.year}`}`).toBe(c(p.distributable))
  }
}

describe('F1: Base case through the scenario engine', () => {
  const r = run('base')

  it('every column of the §3.10 table, per year within $1', () => {
    assertYears(r, F1.years, 'base')
  })

  it('per-type revenue Y1 and Y5, expenses Y1→Y5, Y5 rates', () => {
    for (const s of PACK_SERVERS) {
      near(r.operating[1].revenueByType[s], F1.revenueByType.y1[s], `Y1 ${s}`)
      near(r.operating[5].revenueByType[s], F1.revenueByType.y5[s], `Y5 ${s}`)
      expect(Math.round(r.rates[s][4] * 100) / 100).toBe(F1.y5Rates[s])
    }
    F1.datacenter.forEach((v, k) => near(r.operating[k + 1].datacenter, v, `Y${k + 1} datacenter`))
    F1.contingency.forEach((v, k) => near(r.operating[k + 1].contingency, v, `Y${k + 1} contingency`))
    F1.processing.forEach((v, k) => near(r.operating[k + 1].processing, v, `Y${k + 1} processing`))
    r.operating.slice(1).forEach(o => expect(o.insurance).toBe(F1.insurance))
  })

  it('cents-level distributable, Y3 tiers in cents', () => {
    expect(r.waterfall.map(w => w.distributable)).toEqual(F1.distributableCents)
    expect(r.waterfall[2].preferred).toBe(F1.y3Cents.pref)
    expect(r.waterfall[2].returnOfCapital).toBe(F1.y3Cents.roc)
    expect(r.waterfall[2].carry).toBe(F1.y3Cents.carry)
    expect(r.waterfall[2].profitToLP).toBe(F1.y3Cents.profitToLP)
  })

  it('Y0 row, net and cumulative cash flow, depreciation to salvage', () => {
    expect(r.operating[0]).toMatchObject({ year: 0, revenue: 0, netCashFlow: -CAPITAL, cumulative: -CAPITAL })
    r.operating.forEach((o, k) => near(o.cumulative, F1_CUMULATIVE[k], `Y${k} cumulative`))
    near(r.operating[5].netCashFlow, 737_644, 'Y5 net cash flow')
    r.operating.slice(1).forEach(o => expect(o.depreciation).toBe(234_900))
    expect(r.operating[5].nbv).toBe(PACK_INPUTS.salePrice)
  })

  it('totals, IRR 33.6% / 2.02x, project 2.56x / 44.3%, recovered Y2, manager 770,088', () => {
    const total = (f: (w: WaterfallRow) => number) => r.waterfall.reduce((s, w) => s + f(w), 0)
    near(total(w => w.fee), F1.totals.fee, 'fees')
    near(total(w => w.distributable), F1.totals.distributable, 'distributable')
    near(total(w => w.preferred), F1.totals.pref, 'pref')
    near(total(w => w.returnOfCapital), F1.totals.roc, 'ROC')
    near(total(w => w.profitToLP), F1.totals.profitToLP, 'profit')
    near(total(w => w.carry), F1.totals.carry, 'carry')
    near(total(w => w.toManager), F1.totals.toManager, 'to manager')
    near(r.operating.reduce((s, o) => s + o.revenue, 0), F1.totals.revenue, 'revenue')
    near(r.operating.reduce((s, o) => s + o.operatingProfit, 0), F1.totals.operatingProfit, 'op. profit')
    expect(r.returns.capitalRaised).toBe(CAPITAL)
    near(r.returns.investor.total, F1.totals.toLP, 'to investors')
    expect(pct1(r.returns.investor.irr)).toBe(F1.irrPct)
    expect(x2(r.returns.investor.multiple)).toBe(F1.multiple)
    expect(x2(r.returns.project.multiple)).toBe(2.56)
    expect(pct1(r.returns.project.irr)).toBe(44.3)
    expect(r.returns.capitalRecoveredYear).toBe(2)
    expect(r.returns.unreturnedAtClose).toBe(F1.unreturnedAtClose)
    near(r.returns.managerFees, 220_264, 'manager fees')
    near(r.returns.managerCarry, 549_824, 'manager carry')
    near(r.returns.managerTotal, 770_088, 'manager total')
  })
})

describe('F2 / F3: Oversupply stress cases', () => {
  it('F2 (60%): every row, $116,118 unreturned at close, 5.5% / 1.14x, recovered Y4', () => {
    const r = run('oversupply_60')
    assertYears(r, F2.years, 'oversupply_60')
    near(r.returns.unreturnedAtClose, F2.unreturnedAtClose, 'unreturned at close')
    near(r.returns.investor.total, F2.totals.toLP, 'to investors')
    near(r.waterfall.reduce((s, w) => s + w.preferred, 0), F2.totals.pref, 'pref')
    near(r.waterfall.reduce((s, w) => s + w.returnOfCapital, 0), F2.totals.roc, 'ROC')
    near(r.returns.managerFees, F2.totals.fee, 'fees')
    expect(r.returns.managerCarry).toBe(0)
    expect(pct1(r.returns.investor.irr)).toBe(F2.irrPct)
    expect(x2(r.returns.investor.multiple)).toBe(F2.multiple)
    expect(r.returns.capitalRecoveredYear).toBe(4)
  })

  it('F3 (50%): every row, $584,843 unreturned at close, -5.2% / 0.87x, never recovered', () => {
    const r = run('oversupply_50')
    assertYears(r, F3.years, 'oversupply_50')
    near(r.returns.unreturnedAtClose, F3.unreturnedAtClose, 'unreturned at close')
    near(r.returns.investor.total, F3.totals.toLP, 'to investors')
    near(r.waterfall.reduce((s, w) => s + w.preferred, 0), F3.totals.pref, 'pref')
    near(r.waterfall.reduce((s, w) => s + w.returnOfCapital, 0), F3.totals.roc, 'ROC')
    near(r.returns.managerFees, F3.totals.fee, 'fees')
    expect(pct1(r.returns.investor.irr)).toBe(F3.irrPct)
    expect(x2(r.returns.investor.multiple)).toBe(F3.multiple)
    expect(r.returns.capitalRecoveredYear).toBeNull()
  })
})

describe('F4: Balanced, Demand-led, Oversupply 75%', () => {
  for (const e of Object.values(F4)) {
    it(`${e.scenario}: every listed row within $1, totals, multiple and IRR`, () => {
      const r = run(e.scenario)
      r.waterfall.forEach((w, k) => {
        const at = `${e.scenario} Y${k + 1}`
        near(w.fee, e.fee[k], `${at} fee`)
        near(w.preferred, e.pref[k], `${at} pref`)
        near(w.returnOfCapital, e.roc[k], `${at} ROC`)
        near(w.profitToLP, e.profitToLP[k], `${at} profit`)
        near(w.carry, e.carry[k], `${at} carry`)
        near(w.toInvestors, e.toLP[k], `${at} to investors`)
        expect(w.prefCarriedForward).toBe(0)
      })
      const total = (f: (w: WaterfallRow) => number) => r.waterfall.reduce((s, w) => s + f(w), 0)
      near(total(w => w.fee), e.totalFee, 'fees')
      near(total(w => w.preferred), e.totalPref, 'pref')
      near(total(w => w.returnOfCapital), e.totalRoc, 'ROC')
      near(total(w => w.carry), e.totalCarry, 'carry')
      near(r.returns.investor.total, e.totalToLP, 'to investors')
      expect(x2(r.returns.investor.multiple)).toBe(e.multiple)
      expect(pct1(r.returns.investor.irr)).toBe(e.irrPct)
    })
  }

  it('Demand-led Y2: ROC completes and the split begins in one distribution', () => {
    const w = run('demand_led').waterfall[1]
    near(w.returnOfCapital, 667_727, 'ROC')
    expect(w.unreturnedStart - w.returnOfCapital).toBe(0)
    near(w.afterCapital, 317_415, 'left after capital')
    near(w.profitToLP, 222_190, 'profit to investors')
    near(w.carry, 95_224, 'carry')
  })

  it('Oversupply Y4: ROC completes and the split begins in one distribution', () => {
    const w = run('oversupply').waterfall[3]
    near(w.returnOfCapital, 27_284, 'ROC')
    expect(w.unreturnedStart - w.returnOfCapital).toBe(0)
    near(w.afterCapital, 249_380, 'left after capital')
    near(w.profitToLP, 174_566, 'profit to investors')
    near(w.carry, 74_814, 'carry')
  })

  it('Y5 rate table (pack §3)', () => {
    for (const [id, rates] of Object.entries(Y5_RATES)) {
      const r = run(id as PackScenarioId)
      for (const s of PACK_SERVERS) expect(Math.round(r.rates[s][4] * 100) / 100, `${id} ${s}`).toBe(rates[s])
    }
  })
})

describe('the pack headline table (§1) and five-year totals (§4)', () => {
  for (const id of IDS) {
    it(`${PACK_SCENARIOS[id].label}: every row`, () => {
      const r = run(id)
      const h = HEADLINE[id]
      expect(r.utilization).toBeCloseTo(h.utilization, 9)
      expect(x2(r.returns.investor.multiple)).toBe(h.multiple)
      expect(pct1(r.returns.investor.irr)).toBe(h.irrPct)
      expect(x2(r.returns.project.multiple)).toBe(h.projectMultiple)
      expect(pct1(r.returns.project.irr)).toBe(h.projectIrrPct)
      expect(r.returns.capitalRecoveredYear).toBe(h.recovered)
      near(r.returns.investor.total, h.toInvestors, 'to investors')
      near(r.operating.reduce((s, o) => s + o.revenue, 0), h.revenue, 'revenue')
      near(r.operating.reduce((s, o) => s + o.operatingProfit, 0), h.operatingProfit, 'op. profit')
      near(r.returns.managerFees, h.fees, 'fees')
      near(r.returns.managerCarry, h.carry, 'carry')
      near(r.returns.managerTotal, h.managerTotal, 'manager total')
      near(r.returns.unreturnedAtClose, h.unreturnedAtClose, 'unreturned at close')
      expect(r.returns.capitalRaised).toBe(CAPITAL)
      expect(r.operating[5].saleProceeds).toBe(PACK_INPUTS.salePrice)
    })
  }
})

describe('the engine and the P2 fixture agree', () => {
  for (const id of IDS) {
    it(`${id}: distributable equals packDistributableCash to the cent`, () => {
      const r = run(id)
      const pack = packDistributableCash(id)
      pack.forEach((y, k) => {
        expect(r.waterfall[k].distributable).toBe(y.distributable)
        expect(r.waterfall[k].fee).toBe(y.fee)
        expect(r.operating[k + 1].operatingProfit).toBe(y.operatingProfit)
        expect(r.operating[k + 1].revenue).toBe(y.revenue)
      })
    })
  }
})

describe('the tier identity, exactly, on every cadence', () => {
  const variants: [string, Partial<FleetAssumptions>][] = [
    ['annual', { cadence: 'annual' }],
    ['quarterly', { cadence: 'quarterly' }],
    ['monthly', { cadence: 'monthly' }],
    ['quarterly + contingency return', { cadence: 'quarterly', capex: { contingencyPct: 0.1, contingencySpent: 100_000 } }],
    ['annual + contingency return in Y1', { cadence: 'annual', capex: { contingencyPct: 0.1, contingencySpent: 100_000, returnYear: 1 } }],
  ]
  for (const id of IDS) {
    for (const [name, patch] of variants) {
      it(`${id}, ${name}`, () => {
        const r = run(id, patch)
        assertIdentity(r.waterfall, `${id} ${name} annual rows`)
        for (const block of Object.values(r.returns.byCadence)) {
          assertIdentity(block.periods, `${id} ${name} ${block.cadence}`)
          for (const p of block.periods) expect(c(p.toInvestors) + c(p.toManager)).toBe(c(p.distributable))
        }
      })
    }
  }
})

describe('cadence (Karl Q4)', () => {
  it('defaults to quarterly; annual and quarterly blocks both present and labelled', () => {
    const r = run('base', { cadence: undefined })
    expect(r.cadence).toBe('quarterly')
    const { annual, quarterly, monthly } = r.returns.byCadence
    expect(annual).toMatchObject({ cadence: 'annual', label: CADENCE_LABELS.annual })
    expect(quarterly).toMatchObject({ cadence: 'quarterly', label: 'Quarterly distributions' })
    expect(monthly).toBeUndefined()
    expect(annual.label).toBe('Annual distributions (pack convention)')
  })

  it('annual cadence carries only the annual block; monthly adds the monthly block', () => {
    expect(Object.keys(run('base', { cadence: 'annual' }).returns.byCadence)).toEqual(['annual'])
    const m = run('base', { cadence: 'monthly' }).returns.byCadence
    expect(Object.keys(m).sort()).toEqual(['annual', 'monthly'])
    expect(m.monthly?.periods).toHaveLength(60)
    expect(m.monthly?.label).toBe('Monthly distributions')
  })

  it('quarterly: each year’s periods sum to that year’s distributable, exactly', () => {
    for (const id of IDS) {
      const r = run(id, { cadence: 'quarterly' })
      const q = r.returns.byCadence.quarterly!
      expect(q.periods).toHaveLength(20)
      r.waterfall.forEach(w => {
        const ps = q.periods.filter(p => p.year === w.year)
        expect(ps.reduce((s, p) => s + c(p.toInvestors) + c(p.toManager), 0), `${id} Y${w.year}`).toBe(c(w.distributable))
      })
    }
  })

  it('quarterly: sale proceeds land in the last quarter, t = q/4, and the IRR differs from annual', () => {
    const r = run('base', { cadence: 'quarterly' })
    const q = r.returns.byCadence.quarterly!
    const y5 = q.periods.filter(p => p.year === 5)
    expect(c(y5[3].distributable) - c(y5[2].distributable)).toBeGreaterThanOrEqual(c(PACK_INPUTS.salePrice) - 1)
    expect(q.flows[0]).toEqual({ t: 0, amount: -CAPITAL })
    expect(q.flows.slice(1).map(f => f.t)).toEqual(Array.from({ length: 20 }, (_, k) => (k + 1) / 4))
    expect(q.periods[0].date).toBe('2027-03-31')
    expect(q.periods[19].date).toBe('2031-12-31')
    // Same cash, paid earlier: a higher IRR than the pack's 33.6%, the same pack total within $1.
    expect(q.investor.irr!).toBeGreaterThan(r.returns.byCadence.annual.investor.irr! + 0.001)
    expect(r.returns.investor.irr).toBe(r.returns.byCadence.annual.investor.irr)
    expect(pct1(r.returns.investor.irr)).toBe(33.6)
  })
})

describe('R8: unspent contingency returned to investors', () => {
  const spent = { contingencyPct: 0.1, contingencySpent: 100_000 }

  it('Oversupply 50%: 30,500 returned in Y5 as its own line, unreturned at close 554,343, no fee, no carry', () => {
    const pack = run('oversupply_50')
    const r = run('oversupply_50', { capex: spent })
    const w5 = r.waterfall[4]
    expect(w5.contingencyReturn).toBe(30_500)
    expect(r.waterfall.slice(0, 4).every(w => w.contingencyReturn === 0)).toBe(true)
    near(r.returns.unreturnedAtClose, 554_343, 'unreturned at close')
    expect(r.returns.contingencyReturned).toBe(30_500)
    // Pref for Y5 is earned on the capital outstanding during Y5, as in the pack.
    expect(w5.preferred).toBe(pack.waterfall[4].preferred)
    expect(w5.returnOfCapital).toBe(pack.waterfall[4].returnOfCapital)
    expect(c(w5.distributable)).toBe(c(pack.waterfall[4].distributable) + c(30_500))
    expect(c(w5.toInvestors)).toBe(c(pack.waterfall[4].toInvestors) + c(30_500))
    r.waterfall.forEach((w, k) => {
      expect(w.fee).toBe(pack.waterfall[k].fee)
      expect(w.toManager).toBe(pack.waterfall[k].toManager)
      expect(w.carry).toBe(0)
    })
    expect(r.operating[5].unspentContingency).toBe(30_500)
  })

  it('Oversupply 50% with returnYear 1: 30,500 in Y1, the pref base from Y2 is 30,500 lower', () => {
    const pack = run('oversupply_50')
    const r = run('oversupply_50', { capex: { ...spent, returnYear: 1 } })
    expect(r.waterfall[0].contingencyReturn).toBe(30_500)
    expect(r.waterfall[0].preferred).toBe(pack.waterfall[0].preferred)
    expect(r.waterfall.slice(1).every(w => w.contingencyReturn === 0)).toBe(true)
    expect(c(r.waterfall[1].unreturnedStart)).toBe(c(pack.waterfall[1].unreturnedStart) - c(30_500))
    expect(r.waterfall[1].preferred).toBe(Math.round(r.waterfall[1].unreturnedStart * 0.08 * 100) / 100)
    expect(r.waterfall[1].preferred).toBeLessThan(pack.waterfall[1].preferred)
  })

  it('quarterly: the contingency is paid in the first quarter of its return year', () => {
    const r = run('oversupply_50', { cadence: 'quarterly', capex: spent })
    const q = r.returns.byCadence.quarterly!
    const paid = q.periods.filter(p => p.contingencyReturn > 0)
    expect(paid.map(p => [p.year, p.period, p.contingencyReturn])).toEqual([[5, 17, 30_500]])
  })

  it('Base: capital is back by Y3, so the cap is 0 and the 30,500 falls into the Y5 70/30 split', () => {
    const pack = run('base')
    const r = run('base', { capex: spent })
    expect(r.waterfall.every(w => w.contingencyReturn === 0)).toBe(true)
    expect(r.returns.contingencyReturned).toBe(0)
    near(r.waterfall[4].profitToLP - pack.waterfall[4].profitToLP, 21_350, 'Y5 profit to investors')
    near(r.waterfall[4].carry - pack.waterfall[4].carry, 9_150, 'Y5 carry')
    expect(r.waterfall[4].fee).toBe(pack.waterfall[4].fee)
  })

  it('the pack (contingencySpent null) returns nothing, and overspend returns nothing', () => {
    for (const id of IDS) {
      const r = run(id)
      expect(r.returns.contingencyReturned).toBe(0)
      expect(r.waterfall.every(w => w.contingencyReturn === 0)).toBe(true)
    }
    expect(run('oversupply_50', { capex: { contingencyPct: 0.1, contingencySpent: 200_000 } }).returns.contingencyReturned).toBe(0)
  })
})

describe('resolveFleet and inputs', () => {
  it("throws the typed error for 'register' with no register, returns the register when given", () => {
    const a = packAssumptions('base', { assets: 'register' })
    expect(() => resolveFleet(a, null)).toThrow(FleetRegisterUnavailableError)
    try { resolveFleet(a, null) } catch (e) { expect((e as FleetRegisterUnavailableError).code).toBe('fleet_register_unavailable') }
    expect(resolveFleet(a, PACK_FLEET)).toBe(PACK_FLEET)
    expect(resolveFleet(packAssumptions('base'), null)).toBe(PACK_FLEET)
  })

  it('a register fleet runs the same as the planned one', () => {
    const a = packAssumptions('base', { assets: 'register' })
    const r = runFleetScenario(a, resolveFleet(a, PACK_FLEET), PACK_SCENARIO_TERMS)
    expect(r).toEqual(run('base'))
  })

  it('per-type utilisation arrays reproduce a flat figure', () => {
    const flat = run('oversupply_60')
    const perType = run('oversupply_60', { utilization: Object.fromEntries(PACK_SERVERS.map(s => [s, [0.6, 0.6, 0.6, 0.6, 0.6]])) })
    expect(perType.waterfall).toEqual(flat.waterfall)
  })

  it('a fractional life charges its final part-year and the sale lands on salvage', () => {
    const r = run('base', { lifeYears: 2.5 })
    expect(r.operating.slice(1).map(o => o.depreciation)).toEqual([469_800, 469_800, 234_900, 0, 0])
    expect(r.operating[3].nbv).toBe(PACK_INPUTS.salePrice)
    expect(r.operating[5].saleProceeds).toBe(PACK_INPUTS.salePrice)
    expect(r.waterfall).toEqual(run('base').waterfall)
  })

  it('overrides replace the vehicle terms', () => {
    const r = run('base', { overrides: { feeRate: 0, carryRate: 0.2 } })
    expect(r.waterfall.every(w => w.fee === 0)).toBe(true)
    expect(r.waterfall[3].carry).toBe(Math.round(r.waterfall[3].afterCapital * 0.2 * 100) / 100)
  })

  it('rejects invalid effective terms from overrides with ScenarioInputError', () => {
    for (const overrides of [{ carryRate: 2 }, { carryRate: -0.1 }, { prefRate: 1.5 }, { rocLpShare: 0 }, { rocLpShare: 1.2 }, { feeRate: -0.01 }, { feeRate: 1 }]) {
      expect(() => run('base', { overrides }), JSON.stringify(overrides)).toThrow(ScenarioInputError)
    }
    expect(() => runFleetScenario(packAssumptions('base'), PACK_FLEET, { ...PACK_SCENARIO_TERMS, waterfall: { ...PACK_SCENARIO_TERMS.waterfall, recipients: [] } }))
      .toThrow(ScenarioInputError)
  })

  it('rejects unrunnable assumptions with ScenarioInputError', () => {
    expect(() => run('base', { saleYear: 6 })).toThrow(ScenarioInputError)
    expect(() => run('base', { capex: { contingencyPct: 0.1, contingencySpent: 0, returnYear: 6 } })).toThrow(ScenarioInputError)
    expect(() => runFleetScenario(packAssumptions('base'), [{ typeCode: 'gb300', servers: 1, gpusPerServer: 8, hardwareCost: 1 }], PACK_SCENARIO_TERMS))
      .toThrow(ScenarioInputError)
    expect(() => run('base', { datacenter: { monthly: 1_000_000, escalator: 0, firstEscalationYear: 2, contingencyPct: 0 } }))
      .toThrow(ScenarioInputError)
  })
})
