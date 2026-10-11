'use client'

import { createPortal } from 'react-dom'
import type { HeadlinePeriod, PlanCashFlows } from './forecast-charts'
import { useDeferredValue, useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type { ConstructionActuals, ConstructionAssumptions, ConstructionResult, PacingAssumptions, SimulationAssumptions } from '@/lib/accounting/construction'
import { constructionBaseline, applyLpWaterfall, forecastSchedule, type ForecastBaseline } from '@/lib/accounting/construction-forecast'
import { simulateFund } from '@/lib/accounting/construction-simulation'
import type { FundTimeseriesPoint } from '@/lib/accounting/fund-timeseries'
import { JCurveChart, CashFlowChart, OutcomeHistogram, ExitOutcomesChart, type ActualCashFlow, type ActualPoint } from './forecast-charts'

type Fmt = (v: number | null) => string

/**
 * The forward half of the construction page: one set of understandable return assumptions,
 * followed by the deterministic forecast and its simulated range.
 *
 * Both sections read the same model the rest of the page computes and add only what they ask for:
 * pacing turns the plan into a yearly schedule (lib/accounting/construction-forecast.ts); the
 * simulation spreads that schedule's outcomes (lib/accounting/construction-simulation.ts). Every
 * Technical engine settings (seed, run count and log-normal dispersion) use documented industry
 * defaults rather than asking a GP to tune simulation internals.
 *
 * The baseline the schedule starts from is the fund's actual growth series when the vehicle has
 * one (dated, so the IRR is since inception); the capital accounts otherwise.
 */
export function ForecastSection({ model, actuals, a, setA, vehicle, fmt, fmtFull, multiple, planFlows, chartsSlot, outcomesSlot, headline, assumptionsOpen, onAssumptionsClose }: {
  /** The Return assumptions dialog, opened from the Forecast page's settings menu. */
  assumptionsOpen?: boolean
  onAssumptionsClose?: () => void
  model: ConstructionResult
  actuals: ConstructionActuals
  a: ConstructionAssumptions
  setA: (update: (prev: ConstructionAssumptions) => ConstructionAssumptions) => void
  vehicle: string
  fmt: Fmt
  fmtFull: Fmt
  multiple: (v: number | null) => string
  /** The plan's own yearly flows and range, when this construction belongs to a plan. */
  planFlows?: PlanCashFlows | null
  /** The Forecast page's periods and date range, so the headline charts follow its timescale. */
  headline?: { periods: HeadlinePeriod[]; years: { first: number; last: number } } | null
  /** Where the cash-flow and multiples charts go — above the Forecast page's tabs. Inline without one. */
  chartsSlot?: HTMLElement | null
  /** Where the outcome histogram renders (the Charts tab). */
  outcomesSlot?: HTMLElement | null
}) {
  const [points, setPoints] = useState<FundTimeseriesPoint[] | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/accounting/fund-timeseries?group=${encodeURIComponent(vehicle)}`)
      .then(r => (r.ok ? r.json() : { points: [] }))
      .then(d => { if (!cancelled) setPoints(Array.isArray(d.points) ? d.points : []) })
      .catch(() => { if (!cancelled) setPoints([]) })
    return () => { cancelled = true }
  }, [vehicle])

  const today = useMemo(() => new Date().toISOString().slice(0, 10), [])
  const todayYear = useMemo(() => decimalYear(today), [today])
  const accounting = actuals.capitalAvailable === true
  const carryConfigured = !!actuals.waterfall && actuals.waterfall.kind !== 'none' && actuals.waterfall.carryRate > 0

  // The baseline and the actual curve, from the dated series when there is one.
  const { baseline, actual, actualCashFlows } = useMemo(() => {
    // Never feed missing capital observations to the forecast as zero cash flows.
    type CompletePoint = FundTimeseriesPoint & { calledCapital: number; distributed: number; nav: number }
    const pts: CompletePoint[] = accounting
      ? (points ?? []).filter((p): p is CompletePoint => p.calledCapital != null && p.distributed != null && p.nav != null && p.calledCapital > 0)
      : (points ?? []).filter(p => p.investedCapital > 0).map(p => ({ ...p, calledCapital: 0, distributed: 0, nav: 0, expenses: 0 }))
    if (pts.length === 0) {
      const baseline = constructionBaseline(actuals, model, today)
      return { baseline, actual: [] as ActualPoint[], actualCashFlows: [] as ActualCashFlow[] }
    }
    const last = pts[pts.length - 1]
    const baseline = constructionBaseline(actuals, model, today)
    const actual: ActualPoint[] = pts.map(p => ({
      x: decimalYear(p.period),
      label: p.label,
      tvpi: accounting
        ? (p.calledCapital > 0 ? (p.distributed + p.nav) / p.calledCapital : null)
        : (p.investedCapital > 0 ? (p.proceeds + p.portfolioValue) / p.investedCapital : null),
      dpi: accounting
        ? (p.calledCapital > 0 ? p.distributed / p.calledCapital : null)
        : (p.investedCapital > 0 ? p.proceeds / p.investedCapital : null),
      paidIn: accounting ? p.calledCapital : p.investedCapital,
    }))
    // The source series is cumulative and quarterly. Convert its known deltas to annual bars,
    // reconciling them to the LP-only baseline when the waterfall separates LPs from the GP.
    const sourceCalledToDate = accounting ? last.calledCapital : last.investedCapital
    const sourceDistributedToDate = accounting ? last.distributed : last.proceeds
    const lpCalledToDate = accounting ? (actuals.waterfall?.lpCalledCapital ?? sourceCalledToDate) : sourceCalledToDate
    const lpDistributedToDate = accounting ? (actuals.waterfall?.lpDistributedCapital ?? sourceDistributedToDate) : sourceDistributedToDate
    const calledScale = sourceCalledToDate > 0 ? lpCalledToDate / sourceCalledToDate : 1
    const distributedScale = sourceDistributedToDate > 0 ? lpDistributedToDate / sourceDistributedToDate : 1
    const annual = new Map<number, ActualCashFlow>()
    let priorCalled = 0
    let priorDistributed = 0
    let priorInvested = 0
    let priorExpenses = 0
    let priorCapitalDistributed = 0
    const lpDistributionScale = last.distributed > 0
      ? (actuals.waterfall?.lpDistributedCapital ?? last.distributed) / last.distributed
      : 1
    for (const p of pts) {
      const year = Number(p.period.slice(0, 4))
      const cumulativeCalled = accounting ? p.calledCapital : p.investedCapital
      const cumulativeDistributed = accounting ? p.distributed : p.proceeds
      const fundCalled = Math.max(0, cumulativeCalled - priorCalled)
      const fundDistributed = Math.max(0, cumulativeDistributed - priorDistributed)
      const invested = Math.max(0, p.investedCapital - priorInvested)
      const expenses = Math.max(0, -((p.expenses ?? 0) - priorExpenses))
      const capitalDistributed = Math.max(0, p.distributed - priorCapitalDistributed)
      const lpCapitalDistributed = capitalDistributed * lpDistributionScale
      const lpCalled = fundCalled * calledScale
      const lpDistributed = fundDistributed * distributedScale
      const row = annual.get(year) ?? { year, called: 0, invested: 0, expenses: 0, distributed: 0, lpDistributed: 0, carriedInterest: 0 }
      row.called += lpCalled
      row.invested += invested
      row.expenses += expenses
      row.distributed += lpDistributed
      row.lpDistributed += lpCapitalDistributed
      row.carriedInterest += Math.max(0, capitalDistributed - lpCapitalDistributed)
      annual.set(year, row)
      priorCalled = cumulativeCalled
      priorDistributed = cumulativeDistributed
      priorInvested = p.investedCapital
      priorExpenses = p.expenses ?? 0
      priorCapitalDistributed = p.distributed
    }
    const actualCashFlows = Array.from(annual.values()).filter(row => row.called > 0.005 || row.distributed > 0.005 || row.lpDistributed > 0.005 || row.carriedInterest > 0.005)
    return { baseline, actual, actualCashFlows: pts.some(p => p.expenses == null) ? [] : actualCashFlows }
  }, [points, actuals, model, today, todayYear, accounting])

  const grossSchedule = useMemo(() => forecastSchedule(model, a, a.pacing, baseline), [model, a, baseline])
  const waterfallSchedule = useMemo(() => carryConfigured && actuals.waterfall ? applyLpWaterfall(grossSchedule, actuals.waterfall) : null, [grossSchedule, actuals.waterfall, carryConfigured])
  // Net forecasts require supported capital figures; gross forecasts use investment records.
  const schedule = accounting && waterfallSchedule ? waterfallSchedule : grossSchedule

  // The simulation is the expensive part: run it on the deferred assumptions so typing in a field
  // stays responsive, and only once something beyond the forecast is stated.
  const deferredA = useDeferredValue(a)
  const simulation = useMemo(() => {
    const s = deferredA.simulation
    const fundWide = s.lossRate > 0 || s.dispersion > 0 || s.holdSpreadYears > 0
    const perDeal = schedule.deals.some(d => (d.lossRate ?? 0) > 0 || (d.dispersion ?? 0) > 0 || (d.exitSpreadYears ?? 0) > 0)
    if (!schedule.stated || !(fundWide || perDeal)) return null
    return simulateFund(model, deferredA, deferredA.pacing, s, baseline, carryConfigured ? actuals.waterfall : undefined)
  }, [model, deferredA, schedule.stated, schedule.deals, baseline, actuals.waterfall, carryConfigured])

  const setPacing = (patch: Partial<PacingAssumptions>) => setA(prev => ({ ...prev, pacing: { ...prev.pacing, ...patch } }))
  const setSim = (patch: Partial<SimulationAssumptions>) => setA(prev => ({ ...prev, simulation: { ...prev.simulation, ...patch } }))

  // The page's headline charts: cash flows by year (with the simulated range of distributions) and
  // the multiples by year (with the simulated TVPI range). They sit above the tabs, so a change on
  // any tab shows in them at once.
  const charts = schedule.stated ? (
    <div className="grid gap-6 lg:grid-cols-2">
      <CashFlowChart actual={actualCashFlows} schedule={schedule} accounting={accounting} fmt={fmt} fmtFull={fmtFull} plan={planFlows} periods={headline?.periods} />
      <JCurveChart years={headline?.years} committed={actuals.committedCapital} actual={carryConfigured ? [] : actual} schedule={schedule} simulation={simulation} netOfCarry={carryConfigured} multiple={multiple} />
    </div>
  ) : null
  // Return assumptions — hold, default exit multiple, write-off rate, exit timing range — in a
  // dialog the Forecast page opens from its settings menu.
  const assumptionsDialog = (
    <Dialog open={!!assumptionsOpen} onOpenChange={o => { if (!o) onAssumptionsClose?.() }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Return assumptions</DialogTitle>
          <DialogDescription>Used where a deal has no figure of its own, and to vary exits in the simulation.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <YearsField label="Hold period" hint="Years from investment to exit" value={a.pacing.holdYears} onChange={v => setPacing({ holdYears: v, existingHoldYears: v })} />
          <NumField label="Default exit multiple" hint="Used when a company has no override" value={a.simulation.defaultExitMultiple} onChange={v => setSim({ defaultExitMultiple: v })} suffix="x" step="0.1" />
          <NumField label="Write-off rate" hint="Share of planned deals returning zero" value={a.simulation.lossRate * 100} onChange={v => setSim({ lossRate: Math.min(99, v) / 100 })} suffix="%" step="1" />
          <NumField label="Exit timing range" hint="Years either side of the expected exit" value={a.simulation.holdSpreadYears} onChange={v => setSim({ holdSpreadYears: v })} suffix="yrs" step="0.5" />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onAssumptionsClose?.()}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
  const histogram = outcomesSlot && simulation ? createPortal(<div className="space-y-4"><OutcomeHistogram simulation={simulation} target={a.simulation.targetMultiple} multiple={multiple} /><ExitOutcomesChart simulation={simulation} netOfCarry={carryConfigured} target={a.simulation.targetMultiple} multiple={multiple} /></div>, outcomesSlot) : null
  const portal = <>{chartsSlot && charts ? createPortal(charts, chartsSlot) : null}{histogram}</>
  // The Forecast page draws these elsewhere: the charts above, the outcomes on its Charts tab, the
  // assumptions from its settings menu. The deals themselves are edited on Investments.
  return <>{portal}{assumptionsDialog}</>
}

function decimalYear(iso: string): number {
  const d = new Date(iso + 'T00:00:00Z')
  const y = d.getUTCFullYear()
  const start = Date.UTC(y, 0, 1)
  const end = Date.UTC(y + 1, 0, 1)
  return y + (d.getTime() - start) / (end - start)
}

export function InlineNumber({ label, value, placeholder, suffix, onChange }: { label: string; value: number | null | undefined; placeholder?: string; suffix?: string; onChange: (value: number | null) => void }) {
  return <label className="relative inline-block"><span className="sr-only">{label}</span><Input type="number" min="0" step="0.5" value={value ?? ''} placeholder={placeholder} onChange={event => onChange(event.target.value === '' ? null : Math.max(0, Number(event.target.value)))} className={cn('h-8 w-24 text-right tabular-nums', NO_SPINNERS, suffix && 'pr-7')} />{suffix && <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-[10px] text-muted-foreground">{suffix}</span>}</label>
}

const NO_SPINNERS = '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none'

function NumField({ label, hint, value, onChange, suffix, step = 'any' }: { label: string; hint: string; value: number; onChange: (v: number) => void; suffix?: string; step?: string }) {
  return (
    <label className="text-xs text-muted-foreground">
      <span className="block">{label}</span>
      <div className="relative mt-1">
        <Input type="number" min="0" step={step} value={value || ''} onChange={e => onChange(Math.max(0, Number(e.target.value)))} className={cn('h-9 tabular-nums', NO_SPINNERS, suffix && 'pr-8')} />
        {suffix && <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-xs">{suffix}</span>}
      </div>
      <span className="mt-0.5 block text-[11px] text-muted-foreground/80">{hint}</span>
    </label>
  )
}

function YearsField(props: { label: string; hint: string; value: number; onChange: (v: number) => void }) {
  return <NumField {...props} suffix="yrs" step="0.5" />
}
