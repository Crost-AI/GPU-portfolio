// Pure report shapes for a GPU SPV: the Scenarios page, the workbook sheets and the quarterly LP
// letter all read these, so the three can never lay the same figures out differently (plan §5.3).
//
// REDACTION. Members without `gp_economics` must not see the manager's profit share. Following the
// `redactCarryEntry` precedent, the carry figures (the 30% tier and total to manager) are NULLED,
// never zeroed: a 0 would read as "the manager earned nothing", and the UI renders null as a dash.
// Every redacted row is flagged `redacted`, so a null that means "not within fund life" (capital
// recovered) is never confused with a hidden figure. The management fee is an expense of the SPV
// shown on the operating statement, so it is not redacted.
//
// PAID, NEVER ACCRUED (Karl Q8 / R4 rejected). `investorPosition` reports the profit share the
// manager has actually been paid. There is deliberately no accrued or hypothetical field.

import type { Cadence, FleetScenarioResult } from './scenario'
import { prefLedger, replay, type CashWaterfallTerms, type WaterfallEvent } from './waterfall'
import { roundCents } from '@/lib/accounting/ledger'

export type ReportFormat = 'usd' | 'pct' | 'multiple' | 'year'

export interface ReportRow {
  key: string
  label: string
  format: ReportFormat
  /** One per column; null is "nothing" (or, when `redacted`, hidden). */
  values: (number | null)[]
  total: number | null
  redacted: boolean
}

export interface Table {
  /** Column headers: scenario ids, or year numbers. */
  columns: (string | number)[]
  rows: ReportRow[]
}

export interface ScenarioComparison {
  /** Pack §1 headline and §4 totals; one column per scenario. */
  headline: Table
  /** Pack §4 year-by-year series; columns are years, one row per scenario. */
  series: {
    revenue: Table
    operatingProfit: Table
    /** Y0..Yn: Y0 is the capital raised. */
    netCashFlow: Table
    toInvestors: Table
    toManager: Table
  }
}

export interface ScenarioDetail {
  cadence: Cadence
  /** Pack §5 operating cash flow, Y0..Yn. */
  operating: Table
  /** Pack §5 investor waterfall, Y1..Yn (annual, pack convention). */
  waterfall: Table
  /** Investor net cash flows per cadence block, annual first, each labelled. */
  investorFlows: { cadence: Cadence; label: string; flows: { t: number; amount: number }[]; irr: number | null; multiple: number }[]
  /** $/GPU-hour per type per year; the last column is the pack's Year-5 table. */
  rates: Table
}

const sum = (xs: number[]) => roundCents(xs.reduce((s, x) => s + x, 0))

function row(key: string, label: string, format: ReportFormat, values: (number | null)[], total: number | null, redact = false): ReportRow {
  return redact
    ? { key, label, format, values: values.map(() => null), total: null, redacted: true }
    : { key, label, format, values, total, redacted: false }
}

/** A flow row with its sum as the total. */
const flow = (key: string, label: string, values: number[], redact = false) => row(key, label, 'usd', values, sum(values), redact)

/** All scenarios side by side: the pack's §1/§4 rows, in the pack's order, and the §4 series. */
export function scenarioComparison(results: Record<string, FleetScenarioResult>, opts: { showCarry: boolean }): ScenarioComparison {
  const ids = Object.keys(results)
  const rs = ids.map(id => results[id])
  const hide = !opts.showCarry
  const each = (f: (r: FleetScenarioResult) => number | null) => rs.map(f)

  const headline: ReportRow[] = [
    row('utilization', 'Utilization', 'pct', each(r => r.utilization), null),
    row('capitalRaised', 'Total capital invested (Year 0)', 'usd', each(r => r.returns.capitalRaised), null),
    row('investorMultiple', 'Investor multiple (after fees)', 'multiple', each(r => r.returns.investor.multiple), null),
    row('investorIrr', 'Investor IRR (after fees)', 'pct', each(r => r.returns.investor.irr), null),
  ]
  // Karl Q4: the pack's annual figures stay the headline, the vehicle's cadence sits beside them.
  for (const cadence of ['quarterly', 'monthly'] as const) {
    if (!rs.some(r => r.returns.byCadence[cadence])) continue
    const label = rs.find(r => r.returns.byCadence[cadence])!.returns.byCadence[cadence]!.label
    headline.push(
      row(`investorMultiple:${cadence}`, `Investor multiple (after fees), ${label.toLowerCase()}`, 'multiple',
        each(r => r.returns.byCadence[cadence]?.investor.multiple ?? null), null),
      row(`investorIrr:${cadence}`, `Investor IRR (after fees), ${label.toLowerCase()}`, 'pct',
        each(r => r.returns.byCadence[cadence]?.investor.irr ?? null), null),
    )
  }
  headline.push(
    row('projectMultiple', 'Project multiple (before fees)', 'multiple', each(r => r.returns.project.multiple), null),
    row('projectIrr', 'Project IRR (before fees)', 'pct', each(r => r.returns.project.irr), null),
    row('capitalRecoveredYear', 'Capital recovered (project basis)', 'year', each(r => r.returns.capitalRecoveredYear), null),
    row('totalToInvestors', 'Total cash to investors', 'usd', each(r => r.returns.investor.total), null),
    row('totalRevenue', 'Total revenue', 'usd', each(r => sum(r.operating.map(o => o.revenue))), null),
    row('totalOperatingProfit', 'Total operating profit', 'usd', each(r => sum(r.operating.map(o => o.operatingProfit))), null),
    row('saleProceeds', 'Sale proceeds', 'usd', each(r => sum(r.operating.map(o => o.saleProceeds))), null),
    row('unreturnedAtClose', 'Unreturned capital at close', 'usd', each(r => r.returns.unreturnedAtClose), null),
    row('managementFees', 'Management fees', 'usd', each(r => r.returns.managerFees), null),
    row('managerProfitShare', 'Manager profit share', 'usd', each(r => r.returns.managerCarry), null, hide),
    row('managerTotal', 'Total manager earnings', 'usd', each(r => r.returns.managerTotal), null, hide),
  )

  // Scenarios can sell in different years: the columns run to the longest horizon, and a year after
  // a scenario's sale is null (the SPV has closed), so every row lines up with the columns.
  const years = Array.from({ length: Math.max(0, ...rs.map(r => r.waterfall.length)) }, (_, k) => k + 1)
  const aligned = (values: number[], length: number, redact: boolean, id: string) =>
    row(id, id, 'usd', Array.from({ length }, (_, k) => values[k] ?? null), sum(values), redact)
  const series = (f: (r: FleetScenarioResult) => number[], redact = false): Table => ({
    columns: years,
    rows: ids.map((id, k) => aligned(f(rs[k]), years.length, redact, id)),
  })
  const netCashFlow: Table = {
    columns: [0, ...years],
    rows: ids.map((id, k) => aligned(rs[k].operating.map(o => o.netCashFlow), years.length + 1, false, id)),
  }

  return {
    headline: { columns: ids, rows: headline },
    series: {
      revenue: series(r => r.operating.slice(1).map(o => o.revenue)),
      operatingProfit: series(r => r.operating.slice(1).map(o => o.operatingProfit)),
      netCashFlow,
      toInvestors: series(r => r.waterfall.map(w => w.toInvestors)),
      toManager: series(r => r.waterfall.map(w => w.toManager), hide),
    },
  }
}

/** One scenario laid out as the pack's §5 (operating, waterfall, investor flows) plus the rates. */
export function scenarioDetail(result: FleetScenarioResult, opts: { showCarry: boolean }): ScenarioDetail {
  const hide = !opts.showCarry
  const op = result.operating
  const wf = result.waterfall
  const types = Object.keys(result.rates)
  const opFlow = (key: string, label: string, f: (o: FleetScenarioResult['operating'][number]) => number) =>
    flow(key, label, op.map(f))
  const wfFlow = (key: string, label: string, f: (w: FleetScenarioResult['waterfall'][number]) => number, redact = false) =>
    flow(key, label, wf.map(f), redact)
  const wfBalance = (key: string, label: string, f: (w: FleetScenarioResult['waterfall'][number]) => number) =>
    row(key, label, 'usd', wf.map(f), null)

  const operating = [
    ...types.map(t => opFlow(`revenue:${t}`, `Revenue, ${t}`, o => o.revenueByType[t] ?? 0)),
    opFlow('revenue', 'Total revenue', o => o.revenue),
    opFlow('datacenter', 'Datacenter hosting incl. internet', o => o.datacenter),
    opFlow('processing', 'Marketplace processing fee', o => o.processing),
    opFlow('insurance', 'Insurance', o => o.insurance),
    opFlow('contingency', 'Contingency on datacenter expense', o => o.contingency),
    opFlow('expenses', 'Total expenses', o => o.expenses),
    opFlow('operatingProfit', 'Operating profit', o => o.operatingProfit),
    opFlow('saleProceeds', 'Hardware sale proceeds (book value)', o => o.saleProceeds),
    opFlow('unspentContingency', 'Unspent capex contingency released', o => o.unspentContingency),
    opFlow('netCashFlow', 'Net cash flow', o => o.netCashFlow),
    row('cumulative', 'Cumulative cash flow', 'usd', op.map(o => o.cumulative), null),
  ].filter(r => r.key !== 'unspentContingency' || op.some(o => o.unspentContingency !== 0))

  // R8 and the manager's ROC share are zero in the pack; their rows appear only when they are not.
  const waterfall = [
    wfFlow('fee', 'Management fee → manager', w => w.fee),
    wfFlow('distributable', 'Distributable cash', w => w.distributable),
    wfBalance('unreturnedStart', 'Capital still unreturned at start of year', w => w.unreturnedStart),
    wfFlow('contingencyReturn', 'Unspent contingency returned → investors', w => w.contingencyReturn),
    wfFlow('preferred', 'Preferred return → investors', w => w.preferred),
    wfBalance('prefCarriedForward', 'Unpaid pref carried forward', w => w.prefCarriedForward),
    wfFlow('returnOfCapital', 'Return of capital → investors', w => w.returnOfCapital),
    wfFlow('managerRocShare', 'Return of capital → manager', w => w.managerRocShare, hide),
    wfBalance('afterCapital', 'Cash left after capital returned', w => w.afterCapital),
    wfFlow('profitToLP', 'Profit share → investors', w => w.profitToLP),
    wfFlow('carry', 'Profit share → manager (carry)', w => w.carry, hide),
    wfFlow('toInvestors', 'Total to investors', w => w.toInvestors),
    wfFlow('toManager', 'Total to manager (fee + carry)', w => w.toManager, hide),
  ].filter(r => (r.key !== 'contingencyReturn' || wf.some(w => w.contingencyReturn !== 0))
    && (r.key !== 'managerRocShare' || wf.some(w => w.managerRocShare !== 0)))

  const blocks = result.returns.byCadence
  const investorFlows = [blocks.annual, blocks.quarterly, blocks.monthly]
    .filter(b => b != null)
    .map(b => ({ cadence: b.cadence, label: b.label, flows: b.flows, irr: b.investor.irr, multiple: b.investor.multiple }))

  const years = wf.map(w => w.year)
  return {
    cadence: result.cadence,
    operating: { columns: op.map(o => o.year), rows: operating },
    waterfall: { columns: years, rows: waterfall },
    investorFlows,
    rates: { columns: years, rows: types.map(t => row(`rate:${t}`, t, 'usd', result.rates[t], null)) },
  }
}

export interface InvestorPositionReport {
  asOf: string
  contributed: number
  capitalReturned: number
  unreturned: number
  prefPaid: number
  /** Unpaid pref at the last distribution, carried forward without compounding. */
  prefCarriedForward: number
  /** Everything investors have received: pref, capital and their share of profit. */
  distributedToInvestors: number
  /** Investors' 70% of the split, received. */
  profitPaidToInvestors: number
  /** The manager's profit share actually PAID (Karl Q8); never an accrual. */
  managerProfitSharePaid: number
  /** Distributions to investors ÷ contributed; null before any capital. */
  dpi: number | null
}

/** The waterfall position as at `asOf`, replayed from the events (plan §5.4). */
export function investorPosition(events: WaterfallEvent[], terms: CashWaterfallTerms, asOf: string): InvestorPositionReport {
  const live = events.filter(e => e.date <= asOf)
  const state = replay(live, terms, asOf)
  const ledger = prefLedger(live, terms)
  const contributed = sum(state.investors.map(i => i.contributed))
  const unreturned = sum(state.investors.map(i => i.unreturned))
  const capitalReturned = roundCents(contributed - unreturned)
  const prefPaid = sum(state.investors.map(i => i.prefPaid))
  const distributed = sum(live.filter(e => e.kind === 'distribution').map(e => e.amount))
  // `carryPaid` is the manager's whole take; its return-of-capital share is not profit.
  const distributedToInvestors = roundCents(distributed - state.carryPaid)
  return {
    asOf,
    contributed,
    capitalReturned,
    unreturned,
    prefPaid,
    prefCarriedForward: ledger.length ? ledger[ledger.length - 1].carriedForward : 0,
    distributedToInvestors,
    profitPaidToInvestors: roundCents(distributedToInvestors - prefPaid - capitalReturned),
    managerProfitSharePaid: roundCents(state.carryPaid - state.managerRocPaid),
    dpi: contributed > 0 ? distributedToInvestors / contributed : null,
  }
}

/**
 * Fleet KPIs for the quarter, entered by hand (Karl Q1). P3 owns the entry form and fills this
 * seam; until then the letter renders without the KPI block.
 */
export interface FleetKpiInput {
  periodStart: string
  periodEnd: string
  revenue: number
  gpuHoursAvailable: number
  gpuHoursRented: number
  /** Manual uptime field (Karl Q9); null when not entered. */
  downtimeHours: number | null
}

/** Actuals against the published Base case for the quarter. */
export interface PlanVsActualInput {
  revenue: { plan: number; actual: number }
  distributions: { plan: number; actual: number }
}

export interface VarianceLine {
  plan: number
  actual: number
  variance: number
  /** Variance ÷ plan; null when the plan is 0. */
  variancePct: number | null
}

export interface QuarterlyReportData {
  position: InvestorPositionReport
  kpis: (FleetKpiInput & { utilization: number | null; realizedRatePerGpuHour: number | null }) | null
  planVsActual: { revenue: VarianceLine; distributions: VarianceLine } | null
}

function variance(l: { plan: number; actual: number }): VarianceLine {
  const v = roundCents(l.actual - l.plan)
  return { plan: l.plan, actual: l.actual, variance: v, variancePct: l.plan !== 0 ? v / l.plan : null }
}

/** The data block of the quarterly GPU investor letter (plan §5.4); B2's template renders it. */
export function quarterlyReportData(input: {
  position: InvestorPositionReport
  kpis: FleetKpiInput | null
  planVsActual: PlanVsActualInput | null
}): QuarterlyReportData {
  const k = input.kpis
  return {
    position: input.position,
    kpis: k && {
      ...k,
      utilization: k.gpuHoursAvailable > 0 ? k.gpuHoursRented / k.gpuHoursAvailable : null,
      realizedRatePerGpuHour: k.gpuHoursRented > 0 ? k.revenue / k.gpuHoursRented : null,
    },
    planVsActual: input.planVsActual && {
      revenue: variance(input.planVsActual.revenue),
      distributions: variance(input.planVsActual.distributions),
    },
  }
}
