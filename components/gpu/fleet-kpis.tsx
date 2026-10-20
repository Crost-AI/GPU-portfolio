'use client'

import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Metric } from '@/components/ui/metric'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useCurrency, formatCurrencyFull, formatCurrencyPrice } from '@/components/currency-context'
import type { Kpi } from '@/lib/gpu/kpis'
import { ErrorAlert, Field } from './fleet-ui'
import { todayIso } from './fleet-math'
import type { Fetcher } from './fleet-api'
import { getKpis, kpiCaption, type FleetKpis } from './revenue-api'

// ── GPU fleet (P5) ── Fleet KPIs from GET /api/fleet/kpis: utilization, revenue, realized rate and
// uptime, for a month and the trailing twelve. Figures count staged rows as well as posted ones, and
// every tile that does says so ("includes staged rows").

/** The current month, in the user's own zone: what the LTM tiles end with. */
export const currentMonth = () => todayIso().slice(0, 7)

export const pct = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? '—' : `${n.toFixed(1)}%`)
const hours = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 0 })

/** The two LTM tiles the lead page, the /fleet overview and the register share. */
export function LtmTiles({ ltm, error, base }: {
  ltm: Pick<Kpi, 'grossRevenue' | 'utilizationPct' | 'includesStaged'> | null
  /** Why there is no figure: still loading, or the route's refusal. */
  error?: string | null
  /** The caption before the staged note, e.g. "Last 12 months". */
  base?: string
}) {
  const currency = useCurrency()
  const sub = ltm ? kpiCaption(ltm, base) : error ?? 'Loading…'
  return (
    <>
      <Metric label="LTM revenue" value={ltm ? formatCurrencyFull(ltm.grossRevenue, currency) : '—'} sub={sub} data-kpi="ltm-revenue" />
      <Metric label="Utilization" value={ltm ? pct(ltm.utilizationPct) : '—'} sub={sub} data-kpi="ltm-utilization" />
    </>
  )
}

/** One KPI as a row of tiles: utilization, rented hours, gross, net, realized rate, uptime. */
export function KpiRow({ kpi, label }: { kpi: Kpi; label: string }) {
  const currency = useCurrency()
  const sub = kpiCaption(kpi, label)
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6" data-kpi-row={label}>
      <Metric label="Utilization" value={pct(kpi.utilizationPct)} sub={sub} />
      <Metric label="Rented GPU-hours" value={hours(kpi.rentedHours)} sub={`of ${hours(kpi.availableHours)} available`} />
      <Metric label="Gross revenue" value={formatCurrencyFull(kpi.grossRevenue, currency)} sub={sub} />
      <Metric label="Net of fees" value={formatCurrencyFull(kpi.net, currency)} sub={sub} />
      <Metric label="Realized rate" value={kpi.realizedRate == null ? '—' : `${formatCurrencyPrice(kpi.realizedRate, currency)}/GPU-hr`} sub={sub} data-kpi="realized-rate" />
      <Metric label="Uptime" value={pct(kpi.uptimePct)} sub={`${hours(kpi.downtimeHours)} GPU-hours down`} />
    </div>
  )
}

/**
 * Publishing a month's KPIs to the fleet company's metrics arrives with P3 PR B (#98: POST
 * /api/fleet/kpis { action: 'publish' }). Until that is on main the button is shown disabled with why.
 */
export function PublishPlaceholder() {
  return (
    <div className="flex flex-col items-end gap-1" data-placeholder="publish">
      <Button size="sm" variant="outline" disabled title="Publishing arrives with the fleet company metrics">Publish month to metrics</Button>
      <p className="text-caption text-muted-foreground">Arrives with the fleet company metrics.</p>
    </div>
  )
}

/** The asset page's card: one server's month, with a month picker, and the fleet's trailing twelve. */
export function AssetKpiCard({ fetcher, assetId }: { fetcher: Fetcher; assetId: string }) {
  const [month, setMonth] = useState(() => currentMonth())
  const [kpis, setKpis] = useState<{ state: 'loading' } | { state: 'ok'; data: FleetKpis } | { state: 'error'; error: string }>({ state: 'loading' })
  useEffect(() => {
    let cancelled = false
    void getKpis(fetcher, month).then(r => { if (!cancelled) setKpis(r.ok ? { state: 'ok', data: r.data } : { state: 'error', error: r.error }) })
    return () => { cancelled = true }
  }, [fetcher, month])
  return (
    <div className="space-y-3">
      <Field id="asset-kpi-month" label="Month">
        <Input id="asset-kpi-month" type="month" value={month} onChange={e => /^\d{4}-\d{2}$/.test(e.target.value) && setMonth(e.target.value)} className="h-9 w-40 tabular-nums" />
      </Field>
      {kpis.state === 'loading' ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        : kpis.state === 'error' ? <ErrorAlert>{kpis.error}</ErrorAlert>
        : <AssetKpis kpis={kpis.data} assetId={assetId} />}
    </div>
  )
}

/** The figures, from a KPI reply. Rendered statically by the tests. */
export function AssetKpis({ kpis, assetId }: { kpis: FleetKpis; assetId: string }) {
  const mine = kpis.byAsset[assetId]
  return (
    <div className="space-y-3">
      {mine ? <KpiRow kpi={mine} label={kpis.month} /> : <p className="text-sm text-muted-foreground">Nothing entered for this server in {kpis.month}.</p>}
      <div>
        <p className="mb-1 text-xs text-muted-foreground">The whole fleet, last 12 months to {kpis.month} (the route reports the trailing twelve for the fleet only)</p>
        <KpiRow kpi={kpis.ltm} label="Fleet, last 12 months" />
      </div>
    </div>
  )
}
