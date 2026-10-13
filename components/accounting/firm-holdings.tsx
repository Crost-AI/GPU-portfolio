'use client'

import { Fragment, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Loader2, Search, X } from 'lucide-react'
import { useCurrency, formatCurrencyFull } from '@/components/currency-context'
import { Metric as MetricBox } from '@/components/ui/metric'
import { EmptyState } from '@/components/ui/empty-state'
import type { FirmHoldings, FirmHolding } from '@/lib/accounting/holdings-firm'

// THE /funds/schedule-of-investments LANDING: holdings across the firm, one row per company, with
// the entities that hold it and what each holds. It replaced a list of entities with an at-cost
// and at-value total each — which answered "how big is each schedule" and not "who holds what".
// A holder links to that entity's own schedule of investments.

const TYPE_LABEL: Record<FirmHolding['holdingType'], string> = { company: 'Companies', fund: 'Funds', crypto: 'Digital assets' }

export function FirmHoldingsView() {
  const currency = useCurrency()
  const money = (n: number) => formatCurrencyFull(n, currency)
  const [data, setData] = useState<FirmHoldings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [entity, setEntity] = useState('')

  useEffect(() => {
    let live = true
    fetch('/api/accounting/firm/holdings')
      .then(async r => {
        const body = await r.json().catch(() => null)
        if (!r.ok) throw new Error(body?.error ?? 'Could not load the holdings.')
        return body as FirmHoldings
      })
      .then(d => { if (live) setData(d) })
      .catch(e => { if (live) setError((e as Error).message) })
    return () => { live = false }
  }, [])

  const names = useMemo(() => new Map((data?.entities ?? []).map(e => [e.id, e.name])), [data])

  if (error) return <p className="text-sm text-destructive">{error}</p>
  if (!data) return (
    <div className="rounded-card border p-6 flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" /> Building every entity&rsquo;s schedule of investments&hellip;
    </div>
  )
  if (data.entities.length === 0) return <EmptyState>No entity holds investments yet.</EmptyState>

  const q = search.trim().toLowerCase()
  const shown = data.holdings
    .filter(h => !entity || h.holders.some(x => x.vehicleId === entity))
    .filter(h => !q || h.name.toLowerCase().includes(q))
  const cost = data.holdings.reduce((s, h) => s + h.cost, 0)
  const value = data.holdings.reduce((s, h) => s + h.fairValue, 0)
  const shared = data.holdings.filter(h => h.holders.length > 1).length
  const types = (['company', 'fund', 'crypto'] as const).filter(t => shown.some(h => h.holdingType === t))
  const sectioned = types.length > 1

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <MetricBox label="Holdings" value={data.holdings.length} sub={shared > 0 ? `${shared} held by more than one entity` : undefined} />
        <MetricBox label="At cost" value={money(cost)} />
        <MetricBox label="At value" value={money(value)} />
        <MetricBox label="Value / cost" value={cost > 0 ? `${(value / cost).toFixed(2)}x` : '—'} />
      </div>

      <div className="flex flex-wrap gap-2">
        {data.entities.map(e => (
          <Link key={e.id} href={`/funds/${e.id}/schedule-of-investments`} className="rounded-lg border px-3 py-1.5 text-sm hover:bg-accent">
            {e.name}<span className="ml-2 tabular-nums text-muted-foreground">{money(e.fairValue)}</span>
          </Link>
        ))}
      </div>

      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <select value={entity} onChange={e => setEntity(e.target.value)} aria-label="Entity" className="h-8 rounded-md border border-input bg-background px-2 text-sm">
            <option value="">All entities</option>
            {data.entities.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <input
              type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search holdings…"
              className="h-8 w-56 pl-8 pr-8 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            />
            {search && (
              <button onClick={() => setSearch('')} aria-label="Clear search" className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        <div className="overflow-x-auto rounded-card border">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground bg-muted/40">
              <tr>
                <th className="text-left px-3 py-2 font-medium">Holding</th>
                <th className="text-left px-3 py-2 font-medium">Held by</th>
                <th className="text-right px-3 py-2 font-medium">At cost</th>
                <th className="text-right px-3 py-2 font-medium">At value</th>
                <th className="text-right px-3 py-2 font-medium">Value / cost</th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 && (
                <tr><td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">No holdings match.</td></tr>
              )}
              {(sectioned ? types : [null]).map(t => {
                const items = t ? shown.filter(h => h.holdingType === t) : shown
                return (
                  <Fragment key={t ?? 'all'}>
                    {t && (
                      <tr className="border-t bg-muted/20">
                        <td colSpan={5} className="px-3 pt-3 pb-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                          {TYPE_LABEL[t]}<span className="ml-1.5 font-normal normal-case tracking-normal tabular-nums">· {items.length}</span>
                        </td>
                      </tr>
                    )}
                    {items.map(h => (
                      <tr key={h.key} className="border-t align-top hover:bg-muted/30">
                        <td className="px-3 py-2 font-medium">
                          {h.companyId ? <Link href={`/companies/${h.companyId}`} className="hover:underline">{h.name}</Link> : h.name}
                        </td>
                        <td className="px-3 py-2">
                          <ul className="space-y-0.5">
                            {h.holders.map(x => (
                              <li key={x.vehicleId} className="flex justify-between gap-3 text-xs">
                                <Link href={`/funds/${x.vehicleId}/schedule-of-investments`} className="text-muted-foreground hover:underline hover:text-foreground">
                                  {names.get(x.vehicleId) ?? '—'}
                                </Link>
                                {h.holders.length > 1 && <span className="tabular-nums text-muted-foreground">{money(x.fairValue)}</span>}
                              </li>
                            ))}
                          </ul>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{money(h.cost)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{money(h.fairValue)}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{h.cost > 0 ? `${(h.fairValue / h.cost).toFixed(2)}x` : '—'}</td>
                      </tr>
                    ))}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
