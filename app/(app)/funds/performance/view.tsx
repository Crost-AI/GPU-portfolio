'use client'

import { useEffect, useMemo, useState } from 'react'
import { Loader2, AlertTriangle, FileDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { EmptyState } from '@/components/ui/empty-state'
import { useCurrency } from '@/components/currency-context'
import { useLedgerFetch, useVehicle } from '@/components/accounting-vehicle'
import {
  lastQuarterEnd, periodLabel, performanceMoney, performanceMultiple, performancePct,
  type FundPerformanceReport, type PerformanceGrouping,
} from '@/lib/accounting/fund-performance-format'
import { todayLocalIso } from '@/lib/local-date'

/** The last `n` calendar quarter ends, newest first. */
function recentQuarterEnds(n: number): string[] {
  const out: string[] = []
  let d = lastQuarterEnd(todayLocalIso())
  for (let i = 0; i < n; i++) {
    out.push(d)
    // Step back one day, then to that day's quarter end.
    const prev = new Date(`${d}T00:00:00Z`)
    prev.setUTCDate(prev.getUTCDate() - 1)
    d = lastQuarterEnd(prev.toISOString().slice(0, 10))
  }
  return out
}

export function FundPerformanceView() {
  const currency = useCurrency()
  const lf = useLedgerFetch()
  const { group } = useVehicle()
  const quarters = useMemo(() => recentQuarterEnds(24), [])
  const [asOf, setAsOf] = useState(quarters[0])
  const [grouping, setGrouping] = useState<PerformanceGrouping>('month')
  const [report, setReport] = useState<FundPerformanceReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return
    setLoading(true)
    setError(null)
    lf(`/api/accounting/fund-performance?${new URLSearchParams({ asOf, groupBy: grouping })}`)
      .then(async r => {
        const body = await r.json().catch(() => null)
        if (!r.ok) { setReport(null); setError(body?.error ?? 'The report could not be built.'); return }
        setReport(body)
      })
      .finally(() => setLoading(false))
  }, [lf, asOf, grouping])

  const m = (v: number | null | undefined, dp = 0) => performanceMoney(v, currency, dp)
  const pdfQs = new URLSearchParams({ asOf, groupBy: grouping })
  if (group) pdfQs.set('group', group)

  const summary = (label: string, value: string) => (
    <div className="flex items-baseline justify-between gap-4 py-1.5 border-b last:border-b-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-medium tabular-nums">{value}</span>
    </div>
  )

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">Through</span>
        <select
          value={quarters.includes(asOf) ? asOf : ''}
          onChange={e => e.target.value && setAsOf(e.target.value)}
          aria-label="Quarter end"
          className="h-9 rounded-md border border-input bg-background px-2 text-sm"
        >
          {!quarters.includes(asOf) && <option value="">Custom date</option>}
          {quarters.map(q => <option key={q} value={q}>{periodLabel(q)}</option>)}
        </select>
        <Input
          type="date"
          value={asOf}
          onChange={e => setAsOf(e.target.value)}
          aria-label="As of date"
          className="h-9 w-auto"
        />
        <select
          value={grouping}
          onChange={e => setGrouping(e.target.value as PerformanceGrouping)}
          aria-label="Rows"
          title="How the dated cash flows are listed. The IRR always uses the exact dates."
          className="h-9 rounded-md border border-input bg-background px-2 text-sm"
        >
          <option value="month">By month</option>
          <option value="quarter">By quarter</option>
          <option value="date">Every date</option>
        </select>
        <div className="ml-auto">
          <Button size="sm" variant="outline" asChild disabled={!report}>
            <a href={`/api/accounting/fund-performance/pdf?${pdfQs}`} target="_blank" rel="noreferrer">
              <FileDown className="h-4 w-4 mr-1.5" />PDF
            </a>
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground text-sm"><Loader2 className="h-4 w-4 animate-spin" />Loading…</div>
      ) : error ? (
        <p className="text-sm text-warning">{error}</p>
      ) : !report || (report.rows.length === 0 && !report.metrics.nav) ? (
        <EmptyState>No limited partner contributions are on the books through {asOf}.</EmptyState>
      ) : (
        <>
          {report.notes.map(n => (
            <div key={n} className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{n}</span>
            </div>
          ))}

          <div>
            <h2 className="text-heading font-normal">Fund Performance Report</h2>
            <p className="text-sm">{report.vehicle}</p>
            <p className="text-sm text-muted-foreground">Through {report.periodLabel}</p>
          </div>

          <div className="border rounded-lg overflow-x-auto">
            <table className="w-full text-sm whitespace-nowrap">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="text-left px-3 py-2 font-medium">Date</th>
                  <th className="text-right px-3 py-2 font-medium">Contribution</th>
                  <th className="text-right px-3 py-2 font-medium">Distribution</th>
                  <th className="text-right px-3 py-2 font-medium">Net</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.map(r => (
                  <tr key={r.label} className="border-b">
                    <td className="px-3 py-2">{r.label}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{m(r.contributions)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{m(r.distributions)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{m(r.net)}</td>
                  </tr>
                ))}
                <tr className="border-b">
                  <td className="px-3 py-2">{report.asOf} <span className="text-muted-foreground">net asset value</span></td>
                  <td className="px-3 py-2" />
                  <td className="px-3 py-2" />
                  <td className="px-3 py-2 text-right tabular-nums">{m(report.totals.nav)}</td>
                </tr>
                <tr className="bg-muted/50 font-medium">
                  <td className="px-3 py-2">Total</td>
                  <td className="px-3 py-2 text-right tabular-nums">{m(report.totals.contributions)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{m(report.totals.distributions)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{m(report.totals.net)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="grid gap-5 md:grid-cols-2">
            <div className="rounded-card border px-4 py-2">
              {summary('Net IRR (LP only)', performancePct(report.metrics.irr))}
              {summary('TVPI (LP only)', performanceMultiple(report.metrics.tvpi))}
              {summary('DPI (LP only)', performanceMultiple(report.metrics.dpi))}
              {summary('RVPI (LP only)', performanceMultiple(report.metrics.rvpi))}
            </div>
            <div className="rounded-card border px-4 py-2">
              {summary('Total Value (LP only)', m(report.metrics.totalValue, 2))}
              {summary('Net Asset Value (LP only)', m(report.metrics.nav, 2))}
              {summary('Distributions (LP only)', m(report.metrics.distributions, 2))}
              {summary('Capital Contributions (LP only)', m(report.metrics.contributions, 2))}
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            Limited partners only; the general partner&apos;s capital is excluded. Net asset value is the limited
            partners&apos; capital on the books at {report.asOf}, so it carries investments at whatever value is booked.
            The IRR uses the exact transaction dates, with the net asset value as the final inflow; grouping the rows
            does not change it.
          </p>
        </>
      )}
    </div>
  )
}
