import { describe, it, expect } from 'vitest'
import { investorPosition, quarterlyReportData, scenarioComparison, scenarioDetail, type ReportRow, type Table } from './report'
import { resolveFleet, runFleetScenario, type FleetAssumptions, type FleetScenarioResult } from './scenario'
import type { WaterfallEvent } from './waterfall'
import { F1, F5, PACK_INPUTS, PACK_SCENARIOS, PACK_TERMS, type PackScenarioId } from './fixtures/pack-v3'
import { PACK_SCENARIO_TERMS, packAssumptions } from './fixtures/pack-v3-fleet'

const IDS = Object.keys(PACK_SCENARIOS) as PackScenarioId[]

function run(id: PackScenarioId, patch: Partial<FleetAssumptions> = {}): FleetScenarioResult {
  const a = packAssumptions(id, patch)
  return runFleetScenario(a, resolveFleet(a, null), PACK_SCENARIO_TERMS)
}
const all = (patch: Partial<FleetAssumptions> = {}) => Object.fromEntries(IDS.map(id => [id, run(id, patch)]))
const byKey = (t: Table, key: string) => t.rows.find(r => r.key === key) as ReportRow

/** Every row of `hidden` equals `shown` except the manager rows, which are all-null and flagged. */
function assertRedaction(shown: Table, hidden: Table, managerKeys: string[]) {
  expect(hidden.columns).toEqual(shown.columns)
  expect(hidden.rows.map(r => r.key)).toEqual(shown.rows.map(r => r.key))
  hidden.rows.forEach((r, k) => {
    if (managerKeys.includes(r.key)) {
      expect(r.redacted, r.key).toBe(true)
      expect(r.values.every(v => v === null), r.key).toBe(true)
      expect(r.total).toBeNull()
      expect(shown.rows[k].values.some(v => v !== null), `${r.key} shown`).toBe(true)
    } else {
      expect(r, r.key).toEqual(shown.rows[k])
    }
  })
}

describe('scenarioComparison', () => {
  it('the headline carries the pack §1 rows, one column per scenario', () => {
    const cmp = scenarioComparison(all({ cadence: 'annual' }), { showCarry: true })
    expect(cmp.headline.columns).toEqual(IDS)
    const base = IDS.indexOf('base')
    expect(byKey(cmp.headline, 'investorMultiple').values[base]).toBeCloseTo(2.0248, 3)
    expect(byKey(cmp.headline, 'capitalRecoveredYear').values).toEqual([2, 2, 2, 3, 4, null])
    expect(byKey(cmp.headline, 'capitalRecoveredYear').redacted).toBe(false)
    expect(Math.abs((byKey(cmp.headline, 'totalToInvestors').values[base] as number) - F1.totals.toLP)).toBeLessThanOrEqual(1)
    expect(Math.abs((byKey(cmp.headline, 'managerTotal').values[base] as number) - F1.totals.toManager)).toBeLessThanOrEqual(1)
    expect(cmp.headline.rows.some(r => r.key.includes(':quarterly'))).toBe(false)
  })

  it('a quarterly vehicle adds labelled quarterly rows beside the annual ones (Karl Q4)', () => {
    const cmp = scenarioComparison(all({ cadence: 'quarterly' }), { showCarry: true })
    const q = byKey(cmp.headline, 'investorIrr:quarterly')
    expect(q.label).toBe('Investor IRR (after fees), quarterly distributions')
    expect(q.values[0]).toBeGreaterThan(byKey(cmp.headline, 'investorIrr').values[0] as number)
  })

  it('series: revenue, operating profit, net cash flow (Y0..Y5), to investors, to manager', () => {
    const cmp = scenarioComparison(all({ cadence: 'annual' }), { showCarry: true })
    expect(cmp.series.revenue.columns).toEqual([1, 2, 3, 4, 5])
    expect(cmp.series.netCashFlow.columns).toEqual([0, 1, 2, 3, 4, 5])
    expect(byKey(cmp.series.netCashFlow, 'base').values[0]).toBe(-PACK_INPUTS.capital)
    expect(Math.abs((byKey(cmp.series.revenue, 'base').total as number) - F1.totals.revenue)).toBeLessThanOrEqual(1)
    byKey(cmp.series.toInvestors, 'base').values.forEach((v, k) => expect(Math.abs((v as number) - F1.years[k].toLP)).toBeLessThanOrEqual(1))
    byKey(cmp.series.toManager, 'base').values.forEach((v, k) => expect(Math.abs((v as number) - F1.years[k].toManager)).toBeLessThanOrEqual(1))
  })

  it('series line up across different sale years, in either order', () => {
    const short = run('base', { saleYear: 3 })
    const long = run('base')
    for (const results of [{ short, long }, { long, short }]) {
      const cmp = scenarioComparison(results, { showCarry: true })
      for (const t of [cmp.series.revenue, cmp.series.operatingProfit, cmp.series.toInvestors, cmp.series.toManager]) {
        expect(t.columns).toEqual([1, 2, 3, 4, 5])
        t.rows.forEach(r => expect(r.values).toHaveLength(5))
      }
      expect(cmp.series.netCashFlow.columns).toEqual([0, 1, 2, 3, 4, 5])
      const s = byKey(cmp.series.netCashFlow, 'short')
      expect(s.values.slice(4)).toEqual([null, null])
      expect(s.total).toBe(Math.round(short.operating.reduce((a, o) => a + o.netCashFlow, 0) * 100) / 100)
      expect(byKey(cmp.series.toInvestors, 'long').values).toEqual(long.waterfall.map(w => w.toInvestors))
      expect(byKey(cmp.series.toInvestors, 'short').values.slice(3)).toEqual([null, null])
    }
  })

  it('without gp_economics, every manager figure is null and nothing else changes', () => {
    const results = all({ cadence: 'quarterly' })
    const shown = scenarioComparison(results, { showCarry: true })
    const hidden = scenarioComparison(results, { showCarry: false })
    assertRedaction(shown.headline, hidden.headline, ['managerProfitShare', 'managerTotal'])
    assertRedaction(shown.series.toManager, hidden.series.toManager, IDS)
    for (const k of ['revenue', 'operatingProfit', 'netCashFlow', 'toInvestors'] as const) {
      expect(hidden.series[k]).toEqual(shown.series[k])
    }
  })
})

describe('scenarioDetail', () => {
  it('lays the Base case out as the pack §5', () => {
    const d = scenarioDetail(run('base'), { showCarry: true })
    expect(d.operating.columns).toEqual([0, 1, 2, 3, 4, 5])
    expect(d.waterfall.columns).toEqual([1, 2, 3, 4, 5])
    expect(d.operating.rows.map(r => r.key)).toEqual([
      'revenue:h200_nvl', 'revenue:b200', 'revenue:b300', 'revenue', 'datacenter', 'processing', 'insurance',
      'contingency', 'expenses', 'operatingProfit', 'saleProceeds', 'netCashFlow', 'cumulative',
    ])
    expect(d.waterfall.rows.map(r => r.key)).toEqual([
      'fee', 'distributable', 'unreturnedStart', 'preferred', 'prefCarriedForward', 'returnOfCapital',
      'afterCapital', 'profitToLP', 'carry', 'toInvestors', 'toManager',
    ])
    expect(Math.abs((byKey(d.operating, 'netCashFlow').total as number) - 2_241_164)).toBeLessThanOrEqual(1)
    expect(Math.abs((byKey(d.waterfall, 'carry').total as number) - F1.totals.carry)).toBeLessThanOrEqual(1)
    expect(byKey(d.waterfall, 'unreturnedStart').total).toBeNull()
    expect(byKey(d.rates, 'rate:b300').values).toHaveLength(5)
    expect(d.investorFlows.map(f => f.cadence)).toEqual(['annual'])
    expect(d.investorFlows[0].flows[0]).toEqual({ t: 0, amount: -PACK_INPUTS.capital })
  })

  it('shows the R8 lines only when the scenario returns contingency, and both cadences when quarterly', () => {
    const d = scenarioDetail(run('oversupply_50', { cadence: undefined, capex: { contingencyPct: 0.1, contingencySpent: 100_000 } }), { showCarry: true })
    expect(byKey(d.waterfall, 'contingencyReturn').values).toEqual([0, 0, 0, 0, 30_500])
    expect(byKey(d.operating, 'unspentContingency').total).toBe(30_500)
    expect(d.investorFlows.map(f => f.label)).toEqual(['Annual distributions (pack convention)', 'Quarterly distributions'])
  })

  it('without gp_economics: carry and total to manager null, everything else identical', () => {
    const r = run('base')
    const shown = scenarioDetail(r, { showCarry: true })
    const hidden = scenarioDetail(r, { showCarry: false })
    assertRedaction(shown.waterfall, hidden.waterfall, ['carry', 'toManager'])
    expect(hidden.operating).toEqual(shown.operating)
    expect(hidden.rates).toEqual(shown.rates)
    expect(hidden.investorFlows).toEqual(shown.investorFlows)
  })

  it("without gp_economics: the manager's return-of-capital share is null too", () => {
    const r = run('oversupply_50', { overrides: { rocLpShare: 0.9 } })
    const shown = scenarioDetail(r, { showCarry: true })
    const hidden = scenarioDetail(r, { showCarry: false })
    expect(byKey(shown.waterfall, 'managerRocShare').values[4]).toBe(13_150.35)
    assertRedaction(shown.waterfall, hidden.waterfall, ['managerRocShare', 'carry', 'toManager'])
  })
})

describe('investorPosition', () => {
  const dates = ['2027-01-01', '2028-01-01', '2029-01-01', '2030-01-01']
  const events: WaterfallEvent[] = [
    { kind: 'contribution', date: dates[0], lpEntityId: 'lp', amount: PACK_INPUTS.capital },
    ...F5.distributions.map((amount, k): WaterfallEvent => ({ kind: 'distribution', date: dates[k + 1], amount, periodFraction: 1 })),
  ]

  it('F5: 64,840 carried forward after Y1, 0 after Y2', () => {
    const y1 = investorPosition(events, PACK_TERMS, dates[1])
    expect(y1.prefCarriedForward).toBe(64_840)
    expect(y1.prefPaid).toBe(50_000)
    expect(y1.capitalReturned).toBe(0)
    expect(y1.unreturned).toBe(PACK_INPUTS.capital)
    const y2 = investorPosition(events, PACK_TERMS, dates[2])
    expect(y2.prefCarriedForward).toBe(0)
    expect(y2.prefPaid).toBe(229_680)
    expect(y2.unreturned).toBe(F5.years[1].unreturnedAfter)
    expect(y2.managerProfitSharePaid).toBe(0)
  })

  it('F5 Y3: profit share PAID, DPI, and nothing before the first event', () => {
    const y3 = investorPosition(events, PACK_TERMS, dates[3])
    expect(y3.managerProfitSharePaid).toBe(F5.years[2].carry)
    expect(y3.profitPaidToInvestors).toBe(F5.years[2].profitToLP)
    expect(y3.capitalReturned).toBe(PACK_INPUTS.capital)
    expect(y3.distributedToInvestors).toBe(2_350_000 - F5.years[2].carry)
    expect(y3.dpi).toBeCloseTo((2_350_000 - F5.years[2].carry) / PACK_INPUTS.capital, 12)
    const before = investorPosition(events, PACK_TERMS, '2026-12-31')
    expect(before).toMatchObject({ contributed: 0, prefCarriedForward: 0, managerProfitSharePaid: 0, dpi: null })
  })

  it('Karl Q8: there is no accrued or hypothetical profit-share field', () => {
    const keys = Object.keys(investorPosition(events, PACK_TERMS, dates[3]))
    expect(keys.filter(k => /accru|hypothetical|target|unrealized/i.test(k))).toEqual([])
  })
})

describe('quarterlyReportData', () => {
  const position = investorPosition([
    { kind: 'contribution', date: '2027-01-01', lpEntityId: 'lp', amount: 1_000 },
  ], PACK_TERMS, '2027-03-31')

  it('derives utilisation, realized rate and variance from the manual KPIs', () => {
    const d = quarterlyReportData({
      position,
      kpis: { periodStart: '2027-01-01', periodEnd: '2027-03-31', revenue: 243_000, gpuHoursAvailable: 51_840, gpuHoursRented: 38_880, downtimeHours: null },
      planVsActual: { revenue: { plan: 250_000, actual: 243_000 }, distributions: { plan: 0, actual: 0 } },
    })
    expect(d.position).toBe(position)
    expect(d.kpis?.utilization).toBe(0.75)
    expect(d.kpis?.realizedRatePerGpuHour).toBeCloseTo(6.25, 10)
    expect(d.planVsActual?.revenue).toEqual({ plan: 250_000, actual: 243_000, variance: -7_000, variancePct: -0.028 })
    expect(d.planVsActual?.distributions.variancePct).toBeNull()
  })

  it('KPIs and plan-vs-actual are seams: null passes through (P3 fills them)', () => {
    expect(quarterlyReportData({ position, kpis: null, planVsActual: null })).toEqual({ position, kpis: null, planVsActual: null })
  })
})
