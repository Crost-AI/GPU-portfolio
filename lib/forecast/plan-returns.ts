// A plan's returns — one calculation for the point forecast and every simulated run
// (plans/plan-unified-plan.md §2, steps 3–7).
//
// The plan's entries already hold everything but capital: fees, expenses and other P&L cash, hand
// entries, and the deal flows (checks written, exit proceeds) from its construction. Capital
// management (lib/forecast/capital.ts) turns those into calls and distributions month by month, the
// waterfall splits each distribution, and the LPs' cash flows — their share of calls out, their
// distributions in, their share of what is left valued through the waterfall at the end — give the
// net figures. A simulated run is the same thing with its own deal flows.
//
// A GPU SPV (waterfallKind 'distributable_cash') splits each month's distribution with
// lib/gpu/waterfall.ts instead — pref on unreturned capital, return of capital, then the profit split,
// replayed from the vehicle's own history — and has no terminal carry (Karl, R4: the manager's share
// is earned only when a distribution pays it).
//
// Pure: the service supplies the flows, the starting state and the terminal value.

import { roundCents } from '@/lib/accounting/ledger'
import { runWaterfall } from '@/lib/accounting/waterfall'
import { irrOf, type TimedFlow } from '@/lib/accounting/construction-forecast'
import type { ConstructionWaterfallProjection } from '@/lib/accounting/construction'
import type { CarryKind } from '@/lib/accounting/carry'
import { accrue, contribute, distribute, emptyState, replay, type CashWaterfallState, type CashWaterfallTerms, type WaterfallEvent } from '@/lib/gpu/waterfall'
import { computeCapital, runMonthlyWaterfall, type CapitalSettings, type MonthlySplit } from './capital'
import { addMonths, lastDay, monthDiff, type MonthKey } from './months'

export interface ReturnsInput {
  months: MonthKey[]
  /** The month the figures are measured from (IRR time 0) — the plan's cutoff. */
  asOfMonth: MonthKey
  openingCash: number
  uncalled: number
  settings: CapitalSettings
  /** Cash moved by everything other than deals and capital (P&L, settlements, hand entries). */
  otherFlows: Map<MonthKey, number>
  /** Deal cash: checks written (negative) and exit proceeds (positive). */
  invested: Map<MonthKey, number>
  proceeds: Map<MonthKey, number>
  /** The fund's NAV (gross, holdings at value) at the end of the window, plus its cash then. */
  terminalNav: number
  waterfall?: ConstructionWaterfallProjection
  /** The vehicle's waterfall kind; 'distributable_cash' (a GPU SPV) splits with `cashWaterfall`. */
  waterfallKind?: CarryKind
  cashWaterfall?: CashWaterfallInput
}

export interface CashWaterfallInput {
  /** The vehicle's terms (lib/accounting/distribution-waterfall.ts cashWaterfallTerms). */
  terms: CashWaterfallTerms
  /** The books so far: each investor's contributions and the prior distributions, with any contingency returned. */
  history: WaterfallEvent[]
  /** A pitch with nothing contributed on the books yet: the capital its scenario raises, at its start. */
  assumedContribution?: { date: string; amount: number } | null
  /** Unspent capex contingency released by month (R8): paid out that month, before the tiers. */
  contingencyReturns?: Map<MonthKey, number>
}

/** The investors the forecast's own calls are made to: the scenario is vehicle-level, like the engine. */
export const FORECAST_INVESTORS = 'forecast-investors'

/**
 * A GPU SPV's distributions, month by month, through the distributable-cash waterfall: the books'
 * history replayed to the month before the plan, then each forecast call contributed and each
 * distribution split. The manager's take is `carry` (its profit share and any return-of-capital
 * share); there is no GP stake, the manager being a recipient, not an investor.
 */
export function splitCashDistributions(
  distributions: Map<MonthKey, number>,
  calls: Map<MonthKey, number>,
  months: MonthKey[],
  input: CashWaterfallInput,
): { byMonth: Map<MonthKey, MonthlySplit>; warnings: string[] } {
  const byMonth = new Map<MonthKey, MonthlySplit>()
  const warnings: string[] = []
  const terms = datedTerms(input.terms)
  if (!months.length) return { byMonth, warnings }
  const before = lastDay(addMonths(months[0], -1))
  const events = historyEvents(input)
  let state: CashWaterfallState = replay(events.filter(e => e.date <= before), terms, before)
  // An assumed contribution dated inside the plan (a pitch starting this month) joins on its date.
  const later = events.filter(e => e.kind === 'contribution' && e.date > before)
  for (const m of months) {
    const date = lastDay(m)
    for (const e of later.filter(x => x.date.slice(0, 7) === m)) state = contribute(accrue(state, e.date, terms), e as Extract<WaterfallEvent, { kind: 'contribution' }>)
    const call = calls.get(m) ?? 0
    if (call > 0) state = contribute(accrue(state, date, terms), { kind: 'contribution', date, lpEntityId: FORECAST_INVESTORS, amount: call })
    const d = distributions.get(m) ?? 0
    if (!d) continue
    if (!state.investors.length) {
      byMonth.set(m, { toLp: d, carry: 0, toGpStake: 0 })
      if (!warnings.length) warnings.push('No investor has contributed, so distributions are shown undivided — there is no capital for the waterfall to return')
      continue
    }
    const c = Math.min(d, input.contingencyReturns?.get(m) ?? 0)
    const split = distribute(state, d, date, terms, undefined, c > 0 ? { contingencyReturn: c } : {})
    state = split.state
    byMonth.set(m, { toLp: split.tiers.toLP, carry: split.tiers.toGP, toGpStake: 0 })
  }
  return { byMonth, warnings }
}

/** A periodic day count is the scenario engine's; dated distributions accrue 30E/360. */
const datedTerms = (t: CashWaterfallTerms): CashWaterfallTerms => (t.dayCount === 'periodic' ? { ...t, dayCount: '30_360' } : t)

/** The books' history, with a pitch's assumed contribution when nothing is contributed yet. */
function historyEvents(input: CashWaterfallInput): WaterfallEvent[] {
  const events = [...input.history]
  const a = input.assumedContribution
  if (a && a.amount > 0 && !events.some(e => e.kind === 'contribution' && e.amount > 0)) {
    events.push({ kind: 'contribution', date: a.date, lpEntityId: FORECAST_INVESTORS, amount: a.amount })
  }
  return events
}

/**
 * The investors' own history: each contribution out, and of each prior distribution only what the
 * replay gives THEM (tiers.toLP) — the manager's profit share and return-of-capital share already
 * paid are not investor cash.
 */
export function investorHistory(input: CashWaterfallInput): { date: string; amount: number }[] {
  const terms = datedTerms(input.terms)
  const sorted = historyEvents(input).sort((a, b) => a.date.localeCompare(b.date) || (a.kind === b.kind ? 0 : a.kind === 'contribution' ? -1 : 1))
  let state = emptyState(sorted[0]?.date ?? '')
  const out: { date: string; amount: number }[] = []
  for (const e of sorted) {
    if (e.kind === 'contribution') {
      state = contribute(accrue(state, e.date, terms), e)
      out.push({ date: e.date, amount: -e.amount })
    } else if (!state.investors.length) {
      out.push({ date: e.date, amount: e.amount })
    } else {
      const d = distribute(state, e.amount, e.date, terms, undefined, { contingencyReturn: e.contingencyReturn })
      state = d.state
      out.push({ date: e.date, amount: d.tiers.toLP })
    }
  }
  return out
}

export interface YearRow { calendarYear: number; called: number; distributed: number; carry: number; toLp: number; invested: number; proceeds: number; lpCalled: number; endingCash: number }

export interface PlanReturns {
  years: YearRow[]
  totals: { called: number; distributed: number; carry: number; toLp: number; invested: number; proceeds: number }
  /** The LPs' net figures (their share; carry deducted). */
  lp: { called: number; distributed: number; terminal: number; tvpi: number | null; dpi: number | null; irr: number | null }
  /** The calendar year half of the forecast distributions have been paid. */
  halfBackYear: number | null
  /** Distributions paid (carry included) from the plan's start through each month's end. */
  distributedToDate: number[]
  /** Cash in the bank at each month's end, after calls and distributions. */
  cash: { month: MonthKey; ending: number }[]
  /** The plan's lowest month-end cash. */
  lowestCash: { month: MonthKey; amount: number } | null
  warnings: string[]
}

const sumMap = (m: Map<string, number>) => roundCents([...m.values()].reduce((s, v) => s + v, 0))

export function planReturns(input: ReturnsInput): PlanReturns {
  const cashFlows = new Map<MonthKey, number>()
  for (const m of input.months) {
    cashFlows.set(m, roundCents((input.otherFlows.get(m) ?? 0) + (input.invested.get(m) ?? 0) + (input.proceeds.get(m) ?? 0)))
  }
  const cap = computeCapital({
    months: input.months, openingCash: input.openingCash, cashFlows, proceeds: input.proceeds, uncalled: input.uncalled, settings: input.settings,
  })
  const cash = input.waterfallKind === 'distributable_cash' && input.cashWaterfall
    ? splitCashDistributions(cap.distributions, cap.calls, input.months, input.cashWaterfall) : null
  const wf = cash ? { byMonth: cash.byMonth, state: null, terms: null, lpShare: 1 } : runMonthlyWaterfall(cap.distributions, cap.calls, input.months, input.waterfall)
  // The cash waterfall's split is already the investors' net; it carries nothing to the end (R4).
  const carryOn = cash ? true : !!wf.state
  const share = wf.lpShare

  const byYear = new Map<number, YearRow>()
  const row = (m: MonthKey) => {
    const y = Number(m.slice(0, 4))
    return byYear.get(y) ?? (byYear.set(y, { calendarYear: y, called: 0, distributed: 0, carry: 0, toLp: 0, invested: 0, proceeds: 0, lpCalled: 0, endingCash: 0 }), byYear.get(y)!)
  }
  const lpFlows: TimedFlow[] = []
  const t = (m: MonthKey) => monthDiff(input.asOfMonth, m) / 12
  // The LPs' history (dated), so the IRR runs since inception.
  let cashPriorCalled = 0, cashPriorDistributed = 0
  if (cash && input.cashWaterfall) {
    for (const f of investorHistory(input.cashWaterfall)) {
      lpFlows.push({ t: t(f.date.slice(0, 7) as MonthKey), amount: f.amount })
      if (f.amount < 0) cashPriorCalled = roundCents(cashPriorCalled - f.amount)
      else cashPriorDistributed = roundCents(cashPriorDistributed + f.amount)
    }
  } else if (input.waterfall) {
    for (const c of input.waterfall.contributions) lpFlows.push({ t: t(c.date.slice(0, 7) as MonthKey), amount: -c.amount })
    for (const d of input.waterfall.distributions ?? []) lpFlows.push({ t: t(d.date.slice(0, 7) as MonthKey), amount: d.amount })
  }
  let lpCalled = 0, lpDistributed = 0
  for (const m of input.months) {
    const r = row(m)
    const call = cap.calls.get(m) ?? 0
    const split = wf.byMonth.get(m)
    const dist = split ? roundCents(split.toLp + split.toGpStake + split.carry) : 0
    // Without carry terms the split is all "to partners"; the LPs' part is their share of it.
    const toLp = split ? (carryOn ? split.toLp : roundCents(split.toLp * share)) : 0
    r.called = roundCents(r.called + call)
    r.distributed = roundCents(r.distributed + dist)
    r.carry = roundCents(r.carry + (split?.carry ?? 0))
    r.toLp = roundCents(r.toLp + toLp)
    r.invested = roundCents(r.invested + -(input.invested.get(m) ?? 0))
    r.proceeds = roundCents(r.proceeds + (input.proceeds.get(m) ?? 0))
    r.endingCash = cap.endingCash.get(m) ?? r.endingCash
    if (call) r.lpCalled = roundCents(r.lpCalled + call * share)
    if (call) { lpCalled = roundCents(lpCalled + call * share); lpFlows.push({ t: t(m), amount: -roundCents(call * share) }) }
    if (toLp) { lpDistributed = roundCents(lpDistributed + toLp); lpFlows.push({ t: t(m), amount: toLp }) }
  }
  // What the LPs would get for what is left: their share of the end NAV and cash, through the waterfall.
  const endCash = cap.endingCash.get(input.months[input.months.length - 1]) ?? 0
  const leftGross = Math.max(0, roundCents((input.terminalNav + endCash) * share))
  const terminal = carryOn && wf.state && wf.terms ? runWaterfall(leftGross, wf.terms, wf.state).toLP : leftGross
  const last = input.months[input.months.length - 1]
  if (terminal > 0 && last) lpFlows.push({ t: t(last), amount: terminal })

  const priorCalled = cash ? cashPriorCalled : input.waterfall?.lpCalledCapital ?? 0
  const priorDistributed = cash ? cashPriorDistributed : input.waterfall?.lpDistributedCapital ?? 0
  const paidIn = priorCalled + lpCalled
  const outBack = priorDistributed + lpDistributed
  const years = [...byYear.values()].sort((a, b) => a.calendarYear - b.calendarYear)
  const totalDist = years.reduce((s, y) => s + y.distributed, 0)
  let running = 0
  const half = totalDist > 0 ? years.find(y => (running += y.distributed) >= totalDist / 2)?.calendarYear ?? null : null

  return {
    years,
    totals: {
      called: sumMap(cap.calls), distributed: roundCents(totalDist), carry: roundCents(years.reduce((s, y) => s + y.carry, 0)),
      toLp: roundCents(lpDistributed), invested: roundCents(years.reduce((s, y) => s + y.invested, 0)), proceeds: roundCents(years.reduce((s, y) => s + y.proceeds, 0)),
    },
    lp: {
      called: lpCalled, distributed: lpDistributed, terminal: roundCents(terminal),
      tvpi: paidIn > 0 ? (outBack + terminal) / paidIn : null,
      dpi: paidIn > 0 ? outBack / paidIn : null,
      irr: irrOf(lpFlows),
    },
    halfBackYear: half,
    cash: input.months.map(m => ({ month: m, ending: cap.endingCash.get(m) ?? 0 })),
    distributedToDate: input.months.reduce<number[]>((acc, m) => [...acc, roundCents((acc[acc.length - 1] ?? 0) + (cap.distributions.get(m) ?? 0))], []),
    lowestCash: input.months.reduce<{ month: MonthKey; amount: number } | null>((low, m) => {
      const v = cap.endingCash.get(m) ?? 0
      return !low || v < low.amount ? { month: m, amount: v } : low
    }, null),
    warnings: cash ? [...cap.warnings, ...cash.warnings] : cap.warnings,
  }
}
