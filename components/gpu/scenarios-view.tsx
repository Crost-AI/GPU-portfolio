'use client'

import { useCallback, useEffect, useState } from 'react'
import { Download, Loader2, Lock, Sparkles } from 'lucide-react'
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { useLedgerFetch } from '@/components/accounting-vehicle'
import { useCanWrite } from '@/components/access-context'
import { useCurrency, formatCurrency, formatCurrencyFull } from '@/components/currency-context'
import { ChartCard, AXIS, tooltipStyle } from '@/components/fund-chart-kit'
import { cn } from '@/lib/utils'
import { CADENCE_LABELS, type Cadence, type FleetAssumptions } from '@/lib/gpu/scenario'
import type { ScenarioComparison, ScenarioDetail, Table } from '@/lib/gpu/report'
import type { FleetScenariosResponse } from '@/lib/forecast/service'
import type { Fetcher } from './fleet-api'
import { ErrorAlert, GatedButton } from './fleet-ui'
import { formatReportValue, formatRow, getFleetPlan, getScenarios, scenarioExportHref, scenarioHue, seedScenarios } from './scenarios-api'
import { ShellSection } from './parts'

// ── GPU fleet (P5) ── The pitch scenarios side by side (the model pack's §1 and §4), one scenario in
// detail (§5 and the rates), and what each scenario assumes. Every figure is the scenario engine's,
// laid out on the server by lib/gpu/report.ts; manager figures are null without gp_economics and
// render as a dash with a lock, never 0. Editing the assumptions is the Forecast page's Fleet tab.

type Plan = FleetScenariosResponse['plans'][number]

const th = 'whitespace-nowrap px-3 py-2 font-medium'
const num = 'px-3 py-2 text-right tabular-nums'
const ACCOUNTING_HINT = 'Creating the pitch scenarios needs write access to Accounting.'

/** The comparison's columns are plan ids; their names come from `plans`, in that order. */
const nameOf = (plans: Plan[], id: string | number) => plans.find(p => p.id === id)?.name ?? String(id)

/** The six-way headline: one column per scenario, the primary one highlighted. */
export function HeadlineTable({ comparison, plans, primaryPlanId }: {
  comparison: ScenarioComparison
  plans: Plan[]
  primaryPlanId: string | null
}) {
  const currency = useCurrency()
  const money = (n: number) => formatCurrencyFull(n, currency)
  const { columns, rows } = comparison.headline
  const primary = (id: string | number) => id === primaryPlanId
  return (
    <div className="overflow-x-auto rounded-card border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-muted-foreground">
          <tr>
            <th scope="col" className={`${th} text-left`}><span className="sr-only">Measure</span></th>
            {columns.map(c => (
              <th key={c} scope="col" data-plan={c}
                className={cn(`${th} text-right`, primary(c) && 'bg-brand-50 text-brand-700 dark:bg-brand-950 dark:text-brand-400')}>
                {nameOf(plans, c)}{primary(c) && <span className="ml-1 text-caption font-normal">(primary)</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const { cells } = formatRow(r, money)
            return (
              <tr key={r.key} className="border-t" data-row={r.key}>
                <th scope="row" className="whitespace-nowrap px-3 py-2 text-left font-normal">
                  {r.label}
                  {r.redacted && <Lock className="ml-1.5 inline h-3 w-3 text-muted-foreground" aria-label="Needs GP economics access" />}
                </th>
                {cells.map((cell, k) => (
                  <td key={columns[k]} data-plan={columns[k]} className={cn(num, primary(columns[k]) && 'bg-brand-50 dark:bg-brand-950')}>
                    {cell}
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** One year-by-year series, one line per scenario, in the comparison's fixed column order. */
function SeriesChart({ title, table, plans }: { title: string; table: Table; plans: Plan[] }) {
  const currency = useCurrency()
  if (table.rows.every(r => r.redacted)) return null
  const data = table.columns.map((y, i) => ({
    year: `Y${y}`,
    ...Object.fromEntries(table.rows.map(r => [r.key, r.values[i]])),
  }))
  // Colour follows the scenario's place among the plans, so a scenario keeps its hue on every chart.
  const order = plans.map(p => p.id)
  return (
    <ChartCard title={title}>
      <ResponsiveContainer width="100%" height={240}>
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
          <XAxis dataKey="year" tick={AXIS} stroke="hsl(var(--muted-foreground))" />
          <YAxis tick={AXIS} stroke="hsl(var(--muted-foreground))" tickFormatter={v => formatCurrency(Number(v), currency)} />
          <Tooltip contentStyle={tooltipStyle} formatter={(v: any, n: any) => [formatCurrencyFull(Number(v), currency), nameOf(plans, n)]} />
          <Legend wrapperStyle={{ fontSize: 11 }} formatter={(v: any) => nameOf(plans, v)} />
          {table.rows.map(r => (
            <Line key={r.key} type="monotone" dataKey={r.key} name={r.key} stroke={scenarioHue(order.indexOf(r.key))} strokeWidth={1.5} dot={{ r: 2 }} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

export function SeriesCharts({ comparison, plans, cadence }: { comparison: ScenarioComparison; plans: Plan[]; cadence: Cadence | null }) {
  return (
    <div className="space-y-2">
      <div className="grid gap-4 lg:grid-cols-3">
        <SeriesChart title="Revenue by year" table={comparison.series.revenue} plans={plans} />
        <SeriesChart title="Operating profit by year" table={comparison.series.operatingProfit} plans={plans} />
        <SeriesChart title="Distributions to investors by year" table={comparison.series.toInvestors} plans={plans} />
      </div>
      <p className="text-caption text-muted-foreground">
        By year, on the pack&rsquo;s annual convention. {cadence && cadence !== 'annual' ? `The vehicle distributes on its own cadence: ${CADENCE_LABELS[cadence].toLowerCase()}.` : ''}
      </p>
    </div>
  )
}

/** A detail table: years across, rows down, a total column when any row has one. */
export function ReportTable({ table, columnLabel = c => `Y${c}` }: { table: Table; columnLabel?: (c: string | number) => string }) {
  const currency = useCurrency()
  const money = (n: number) => formatCurrencyFull(n, currency)
  const hasTotal = table.rows.some(r => r.total != null || r.redacted)
  return (
    <div className="overflow-x-auto rounded-card border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-muted-foreground">
          <tr>
            <th scope="col" className={`${th} text-left`}><span className="sr-only">Line</span></th>
            {table.columns.map(c => <th key={c} scope="col" className={`${th} text-right`}>{columnLabel(c)}</th>)}
            {hasTotal && <th scope="col" className={`${th} text-right`}>Total</th>}
          </tr>
        </thead>
        <tbody>
          {table.rows.map(r => {
            const { cells, total } = formatRow(r, money)
            return (
              <tr key={r.key} className="border-t" data-row={r.key}>
                <th scope="row" className="whitespace-nowrap px-3 py-2 text-left font-normal">
                  {r.label}
                  {r.redacted && <Lock className="ml-1.5 inline h-3 w-3 text-muted-foreground" aria-label="Needs GP economics access" />}
                </th>
                {cells.map((cell, k) => <td key={k} className={num}>{cell}</td>)}
                {hasTotal && <td className={cn(num, 'font-medium')}>{total ?? ''}</td>}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** The investor flows, one block per cadence (annual first), each labelled with its IRR and multiple. */
export function InvestorFlowBlocks({ blocks }: { blocks: ScenarioDetail['investorFlows'] }) {
  const currency = useCurrency()
  return (
    <div className={cn('grid gap-4', blocks.length > 1 && 'lg:grid-cols-2')}>
      {blocks.map(b => (
        <div key={b.cadence} className="rounded-card border p-4" data-cadence={b.cadence}>
          <h3 className="text-base font-semibold">{b.label}</h3>
          <dl className="mt-2 grid grid-cols-2 gap-2 text-sm">
            <div><dt className="text-muted-foreground">Investor IRR</dt><dd className="tabular-nums" data-irr>{formatReportValue(b.irr, 'pct', () => '')}</dd></div>
            <div><dt className="text-muted-foreground">Investor multiple</dt><dd className="tabular-nums" data-multiple>{formatReportValue(b.multiple, 'multiple', () => '')}</dd></div>
          </dl>
          <div className="mt-3 max-h-56 overflow-auto rounded-card border">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-muted text-muted-foreground">
                <tr>
                  <th scope="col" className={`${th} text-left`}>Years from close</th>
                  <th scope="col" className={`${th} text-right`}>Net cash flow</th>
                </tr>
              </thead>
              <tbody>
                {b.flows.map((f, k) => (
                  <tr key={k} className="border-t">
                    <td className="px-3 py-1.5 tabular-nums">{Number.isInteger(f.t) ? f.t : f.t.toFixed(2)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{formatCurrencyFull(f.amount, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  )
}

const pct = (n: number) => `${Math.round(n * 10000) / 100}%`

/** What one scenario assumes, read-only. Editing is the Forecast page's Fleet tab. */
export function AssumptionsSummary({ fleet }: { fleet: FleetAssumptions }) {
  const currency = useCurrency()
  const money = (n: number) => formatCurrencyFull(n, currency)
  const utilization = typeof fleet.utilization === 'number'
    ? pct(fleet.utilization)
    : Object.entries(fleet.utilization).map(([t, ys]) => `${t}: ${ys.map(pct).join(', ')}`).join('; ')
  const rows: [string, React.ReactNode][] = [
    ['Starts', fleet.startMonth],
    ['Years', `${fleet.years}, sold at book at the end of year ${fleet.saleYear}`],
    ['Assets', fleet.assets === 'register' ? 'From the fleet register' : fleet.assets.map(a => `${a.servers} × ${a.typeCode} (${a.gpusPerServer} GPUs, ${money(a.hardwareCost)})`).join('; ')],
    ['Hours per year', fleet.hoursPerYear.toLocaleString()],
    ['Utilization', utilization],
    ['Price paths', Object.entries(fleet.types).map(([t, v]) => `${t}: $${v.anchorRate}/GPU-hr, ${v.priceChanges.map(pct).join(' / ')}`).join('; ')],
    ['Price change timing', `${pct(fleet.priceChangeTiming)} of a year's change lands in that year`],
    ['Datacenter', `${money(fleet.datacenter.monthly)} a month, +${pct(fleet.datacenter.escalator)} a year from year ${fleet.datacenter.firstEscalationYear}, ${pct(fleet.datacenter.contingencyPct)} contingency`],
    ['Processing fee', pct(fleet.processingFeePct)],
    ['Insurance', `${pct(fleet.insurancePct)} of hardware a year`],
    ['Capex contingency', `${pct(fleet.capex.contingencyPct)} of hardware${fleet.capex.contingencySpent == null ? ', all spent' : `, ${money(fleet.capex.contingencySpent)} spent`}`],
    ['Salvage and life', `${pct(fleet.salvagePct)} salvage, ${fleet.lifeYears} years`],
    ['Distribution cadence', fleet.cadence ? CADENCE_LABELS[fleet.cadence] : 'The vehicle’s (quarterly unless set)'],
    ['Overrides', fleet.overrides && Object.keys(fleet.overrides).length
      ? Object.entries(fleet.overrides).map(([k, v]) => `${k} ${pct(Number(v))}`).join(', ')
      : 'None: the vehicle’s fee and waterfall terms'],
  ]
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="tabular-nums">{v}</dd>
        </div>
      ))}
    </dl>
  )
}

/** The plan the URL names (?plan=), so a shared link opens the same scenario. */
const planFromUrl = () => (typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('plan'))

export function ScenariosView({ vehicle }: { vehicle: string; vehicleId: string | null }) {
  const lf = useLedgerFetch() as Fetcher
  const canSeed = useCanWrite('accounting')
  const [data, setData] = useState<FleetScenariosResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [planId, setPlanId] = useState<string | null>(planFromUrl)
  const [fleet, setFleet] = useState<{ planId: string; fleet: FleetAssumptions | null } | null>(null)
  const [seeding, setSeeding] = useState(false)
  const [drawer, setDrawer] = useState(false)

  const load = useCallback(() => getScenarios(lf, planId), [lf, planId])
  const apply = (r: Awaited<ReturnType<typeof getScenarios>>) => {
    if (r.ok) { setData(r.data); setError(null) } else setError(r.error)
  }
  useEffect(() => {
    let cancelled = false
    void load().then(r => { if (!cancelled) apply(r) })
    return () => { cancelled = true }
  }, [load])

  // The detail plan: the one asked for, else the primary the route chose.
  const detailId = planId ?? data?.primaryPlanId ?? data?.plans[0]?.id ?? null
  useEffect(() => {
    if (!detailId) return
    let cancelled = false
    void getFleetPlan(lf, detailId).then(r => { if (!cancelled && r.ok) setFleet({ planId: detailId, fleet: r.data.plan.fleet }) })
    return () => { cancelled = true }
  }, [lf, detailId])

  function choose(id: string) {
    setPlanId(id)
    try {
      const url = new URL(window.location.href)
      url.searchParams.set('plan', id)
      window.history.replaceState(null, '', url)
    } catch { /* the URL is a convenience */ }
  }

  async function seed() {
    setSeeding(true); setError(null)
    const r = await seedScenarios(lf)
    setSeeding(false)
    if (!r.ok) { setError(r.error); return }
    apply(await load())
  }

  if (!data) {
    return error ? <ErrorAlert>{error}</ErrorAlert> : <div className="flex justify-center p-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
  }

  if (Object.keys(data.results).length === 0) {
    return (
      <div className="space-y-3">
        {error && <ErrorAlert>{error}</ErrorAlert>}
        <EmptyState
          icon={Sparkles}
          action={
            <GatedButton allowed={canSeed && !seeding} hint={canSeed ? 'Creating…' : ACCOUNTING_HINT} variant="default" onClick={seed}>
              {seeding ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Sparkles className="mr-1.5 h-4 w-4" />}Create pitch scenarios
            </GatedButton>
          }
        >
          No scenarios yet. Create the model pack&rsquo;s six pitch scenarios (Base case, Balanced, Demand-led and the three
          Oversupply cases) as forecast plans, then edit any of them on the Forecast page&rsquo;s Fleet tab.
        </EmptyState>
      </div>
    )
  }

  const selected = data.plans.find(p => p.id === detailId) ?? null
  const exportHref = selected && fleet?.planId === selected.id && fleet.fleet ? scenarioExportHref(vehicle, selected.id, fleet.fleet) : null

  return (
    <div className="space-y-4">
      {error && <ErrorAlert>{error}</ErrorAlert>}

      <ShellSection title="Headline comparison" description="The model pack's headline results, one column per scenario.">
        <HeadlineTable comparison={data.comparison} plans={data.plans} primaryPlanId={data.primaryPlanId} />
        {data.warnings.length > 0 && (
          <ul className="mt-3 space-y-1 text-sm text-muted-foreground" data-warnings>
            {data.warnings.map(w => <li key={w}>{w}</li>)}
          </ul>
        )}
      </ShellSection>

      <SeriesCharts comparison={data.comparison} plans={data.plans} cadence={data.cadence} />

      <ShellSection
        title={selected ? `${selected.name} in detail` : 'Scenario detail'}
        description="The operating cash flow, the investor waterfall, the resulting rates and the investor flows."
        action={
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="scenario-pick" className="sr-only">Scenario</label>
            <select id="scenario-pick" className="h-9 rounded-md border border-input bg-background px-2 text-sm" value={detailId ?? ''} onChange={e => choose(e.target.value)}>
              {data.plans.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <Button type="button" size="sm" variant="outline" onClick={() => setDrawer(true)} disabled={!fleet?.fleet}>Assumptions</Button>
            {exportHref
              ? <Button asChild size="sm" variant="outline"><a href={exportHref}><Download className="mr-1.5 h-4 w-4" />Export</a></Button>
              : <Button type="button" size="sm" variant="outline" disabled><Download className="mr-1.5 h-4 w-4" />Export</Button>}
          </div>
        }
      >
        {data.detail ? (
          <div className="space-y-4">
            <div className="space-y-2">
              <h3 className="text-base font-semibold">Operating cash flow</h3>
              <ReportTable table={data.detail.operating} />
            </div>
            <div className="space-y-2">
              <h3 className="text-base font-semibold">Investor waterfall</h3>
              <ReportTable table={data.detail.waterfall} />
            </div>
            <div className="space-y-2">
              <h3 className="text-base font-semibold">Resulting rate, $ per GPU-hour</h3>
              <ReportTable table={data.detail.rates} />
            </div>
            <div className="space-y-2">
              <h3 className="text-base font-semibold">Investor flows</h3>
              <InvestorFlowBlocks blocks={data.detail.investorFlows} />
            </div>
          </div>
        ) : (
          <EmptyState compact>No detail for this scenario.</EmptyState>
        )}
      </ShellSection>

      <Sheet open={drawer} onOpenChange={setDrawer}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
          <SheetTitle className="text-lg font-semibold">{selected?.name ?? 'Scenario'}: assumptions</SheetTitle>
          <p className="mb-4 mt-1 text-sm text-muted-foreground">Read-only. Change them on the Forecast page&rsquo;s Fleet tab.</p>
          {fleet?.fleet && <AssumptionsSummary fleet={fleet.fleet} />}
        </SheetContent>
      </Sheet>
    </div>
  )
}
