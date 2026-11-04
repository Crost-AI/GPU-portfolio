'use client'

import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Metric } from '@/components/ui/metric'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useCurrency, formatCurrencyFull, formatCurrencyPrice } from '@/components/currency-context'
import type { Kpi } from '@/lib/gpu/kpis'
import { monthBounds } from '@/lib/gpu/kpis'
import Link from 'next/link'
import { ErrorAlert, Field, FormDialog } from './fleet-ui'
import { todayIso } from './fleet-math'
import type { Fetcher } from './fleet-api'
import {
  fleetCompanyHref, getKpis, kpiCaption, listEarnings, monthRowCounts, previousMonth, publishKpis, stagedOnlyHint,
  type FleetKpis, type PublishReply,
} from './revenue-api'

// ── GPU fleet (P5) ── Fleet KPIs from GET /api/fleet/kpis: utilization, revenue, realized rate and
// uptime, for a month and the trailing twelve. Figures count staged rows as well as posted ones, and
// every tile that does says so ("includes staged rows").

/**
 * The last COMPLETE calendar month before `today` (local), the month the entry form defaults to.
 * The LTM tiles end here: ending at the current month would count its capacity with nothing yet
 * entered, understating utilization by about a twelfth and covering only eleven months of revenue.
 */
export const lastCompleteMonth = (today: string = todayIso()) => previousMonth(today).start.slice(0, 7)

/** The tiles' caption: the twelve complete months they cover. */
export const ltmCaption = (month: string) => `12 months to ${month}`

export const pct = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? '—' : `${n.toFixed(1)}%`)
const hours = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 0 })

/** The two LTM tiles the lead page, the /fleet overview and the register share. */
export function LtmTiles({ ltm, error, base }: {
  ltm: Pick<Kpi, 'grossRevenue' | 'utilizationPct' | 'includesStaged'> | null
  /** Why there is no figure: still loading, or the route's refusal. */
  error?: string | null
  /** The caption before the staged note, e.g. "12 months to 2026-09". */
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
      <Metric label="Rented GPU-hours" value={hours(kpi.rentedHours)} sub={kpiCaption(kpi, `of ${hours(kpi.availableHours)} available`)} />
      <Metric label="Gross revenue" value={formatCurrencyFull(kpi.grossRevenue, currency)} sub={sub} />
      <Metric label="Net of fees" value={formatCurrencyFull(kpi.net, currency)} sub={sub} />
      <Metric label="Realized rate" value={kpi.realizedRate == null ? '—' : `${formatCurrencyPrice(kpi.realizedRate, currency)}/GPU-hr`} sub={sub} data-kpi="realized-rate" />
      <Metric label="Uptime" value={pct(kpi.uptimePct)} sub={kpiCaption(kpi, `${hours(kpi.downtimeHours)} GPU-hours down`)} />
    </div>
  )
}

export const PUBLISH_HINT = 'Publishing to the fleet company needs write access to the GPU fleet.'

/**
 * Whether any of the month's figures is non-zero. Not a gate: an all-zero month is a real idle period
 * or a correction, and publishing it overwrites the month and removes a rate published earlier
 * (publishFleetKpis). It only changes what the confirmation says.
 */
export const monthHasFigures = (k: Pick<Kpi, 'rentedHours' | 'grossRevenue' | 'fee' | 'downtimeHours'> | null | undefined) =>
  !!k && (k.rentedHours > 0 || k.grossRevenue > 0 || k.fee > 0 || k.downtimeHours > 0)

/** What a publish did, and where to see it. Rendered statically by the tests. */
export function PublishOutcome({ reply }: { reply: PublishReply }) {
  const n = Object.keys(reply.written).length
  return (
    <p role="status" className="text-sm text-success" data-published={reply.month}>
      Published {reply.month}: {n} {n === 1 ? 'metric' : 'metrics'} written{reply.removed.length ? `, ${reply.removed.length} removed` : ''}.{' '}
      <Link href={fleetCompanyHref(reply.companyId)} className="underline underline-offset-2" data-link="fleet-company">Open fleet company metrics</Link>
    </p>
  )
}

/**
 * Publish a month's KPIs to the fleet company's metrics (POST /api/fleet/kpis, fleet write). The
 * route publishes POSTED rows only, so a staged row waits until it is posted. The fleet company's
 * link comes from the reply: no route on main names it beforehand.
 */
export function PublishMonth({ fetcher, month, fleet, canWrite }: {
  fetcher: Fetcher
  month: string
  /** The month's fleet KPI, to tell whether anything was entered; null while loading. */
  fleet: Kpi | null
  canWrite: boolean
}) {
  const [open, setOpen] = useState(false)
  const [reply, setReply] = useState<PublishReply | null>(null)
  // The month's entered rows: publishing writes POSTED rows only, so a month whose rows are all still
  // staged would publish zeros. Read for this month only (the route bounds by period end).
  const [rows, setRows] = useState<{ state: 'loading' } | { state: 'ok'; posted: number; pending: number } | { state: 'error'; error: string }>({ state: 'loading' })
  useEffect(() => {
    let cancelled = false
    const { start, end } = monthBounds(month)
    void listEarnings(fetcher, start, end).then(r => {
      if (!cancelled) setRows(r.ok ? { state: 'ok', ...monthRowCounts(r.data.rows, month) } : { state: 'error', error: r.error })
    })
    return () => { cancelled = true }
  }, [fetcher, month])
  const zero = fleet != null && !monthHasFigures(fleet)
  // Disabled without the grant, while the month is loading, and for a month with only unposted rows.
  // An all-zero month that is posted (an idle period, a correction) publishes.
  const hint = !canWrite ? PUBLISH_HINT
    : fleet == null || rows.state === 'loading' ? `Loading ${month}\u2019s figures\u2026`
    : rows.state === 'ok' ? stagedOnlyHint(rows, month)
    : null
  return (
    <div className="flex flex-col items-end gap-1" data-region="publish">
      <Button size="sm" variant="outline" data-action="publish" disabled={hint != null} title={hint ?? undefined} onClick={() => { setReply(null); setOpen(true) }}>
        Publish {month} to metrics
      </Button>
      {hint && <p className="text-caption text-muted-foreground" data-hint="publish">{hint}</p>}
      {rows.state === 'error' && <p className="text-caption text-muted-foreground" data-hint="rows">Could not check which of {month}&rsquo;s rows are posted ({rows.error}); only posted rows are published.</p>}
      {reply && <PublishOutcome reply={reply} />}
      <FormDialog open={open} onOpenChange={setOpen} title={`Publish ${month} to the fleet company's metrics?`}
        submitLabel="Publish"
        onSubmit={async () => {
          const r = await publishKpis(fetcher, month)
          if (!r.ok) return r.error
          setReply(r.data)
          return null
        }}>
        <p className="text-sm text-muted-foreground" data-confirm="publish">
          Writes {month}&rsquo;s utilization, revenue and rate figures to the fleet company, from posted rows only
          {fleet?.includesStaged ? '; the staged rows counted on this page are left out until they are posted' : ''}. Publishing the month again overwrites it.
        </p>
        {zero && (
          <p className="text-sm text-muted-foreground" data-confirm="zero">
            Every figure for {month} is zero on this page: publishing writes zeros, and removes a rate published for the month
            earlier (an idle month, or a correction to one already published).
          </p>
        )}
      </FormDialog>
    </div>
  )
}

/** The asset page's card: one server's month, with a month picker, and the fleet's trailing twelve. */
export function AssetKpiCard({ fetcher, assetId, canWrite }: { fetcher: Fetcher; assetId: string; canWrite: boolean }) {
  const [month, setMonth] = useState(() => lastCompleteMonth())
  const [kpis, setKpis] = useState<{ state: 'loading' } | { state: 'ok'; data: FleetKpis } | { state: 'error'; error: string }>({ state: 'loading' })
  useEffect(() => {
    let cancelled = false
    void getKpis(fetcher, month).then(r => { if (!cancelled) setKpis(r.ok ? { state: 'ok', data: r.data } : { state: 'error', error: r.error }) })
    return () => { cancelled = true }
  }, [fetcher, month])
  // The reply for the month picked, or null while that month is still loading: a reply for the month
  // before is never taken for this one (it would judge the new month by the old month's figures).
  const current = kpis.state === 'ok' && kpis.data.month === month ? kpis.data : null
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Field id="asset-kpi-month" label="Month">
          <Input id="asset-kpi-month" type="month" value={month} onChange={e => /^\d{4}-\d{2}$/.test(e.target.value) && setMonth(e.target.value)} className="h-9 w-40 tabular-nums" />
        </Field>
        <PublishMonth key={month} fetcher={fetcher} month={month} fleet={current ? current.fleet : null} canWrite={canWrite} />
      </div>
      {kpis.state === 'loading' || (kpis.state === 'ok' && !current) ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
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
