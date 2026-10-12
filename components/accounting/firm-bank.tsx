'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Loader2, Check, Search, X, ArrowRight } from 'lucide-react'
import { useCurrency, formatCurrencyFull } from '@/components/currency-context'
import { useVehicleGroups } from '@/components/vehicle-groups'
import { groupBySection, isGrouped } from '@/lib/vehicle-groups'
import { EmptyState } from '@/components/ui/empty-state'
import type { FirmBank, FirmBankEntity } from '@/lib/accounting/bank-firm'

// THE /funds/bank LANDING: what is waiting to be reconciled, across every entity, on one page.
//
// It replaced a picker — one row per entity with its open count and an Open button — which
// answered "which entity's bank?" and nothing else, so seeing what was waiting took a visit per
// entity. Now the entities are cards (open rows, money in and out, oldest open row, last feed),
// grouped by entity group, and every open row is in one queue under them. A row is still booked
// on its entity's own bank page; the queue links there with the row's description as the search,
// so it opens on that row. See lib/accounting/bank-firm.ts for why the actions stay there.

const STATUS_LABEL: Record<string, string> = { unmatched: 'Unmatched', drafted: 'Draft entry' }

export function FirmBankView() {
  const currency = useCurrency()
  const money = (n: number) => formatCurrencyFull(n, currency)
  const vehicleGroups = useVehicleGroups()

  const [data, setData] = useState<FirmBank | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [entity, setEntity] = useState('')
  const [search, setSearch] = useState('')
  const [newestFirst, setNewestFirst] = useState(false)

  useEffect(() => {
    let live = true
    fetch('/api/accounting/bank/firm')
      .then(async r => {
        const body = await r.json().catch(() => null)
        if (!r.ok) throw new Error(body?.error ?? 'Could not load the bank rows.')
        return body as FirmBank
      })
      .then(d => { if (live) setData(d) })
      .catch(e => { if (live) setError((e as Error).message) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [])

  const byId = useMemo(() => new Map((data?.entities ?? []).map(e => [e.id, e])), [data])

  if (loading) return <div className="p-8 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
  if (error || !data) return <p className="text-sm text-destructive">{error ?? 'Could not load the bank rows.'}</p>
  if (data.entities.length === 0) return <EmptyState>No entities yet. Add one on Admin to import its bank feed.</EmptyState>

  const totalOpen = data.entities.reduce((s, e) => s + e.openRows, 0)
  const waiting = data.entities.filter(e => e.openRows > 0).length
  const sections = groupBySection(data.entities, vehicleGroups, e => ({ id: e.id, name: e.name }))
  const grouped = isGrouped(sections, vehicleGroups)

  const q = search.trim().toLowerCase()
  const rows = data.rows
    .filter(r => !entity || r.vehicleId === entity)
    .filter(r => !q || r.description.toLowerCase().includes(q) || (r.counterparty ?? '').toLowerCase().includes(q))
  const ordered = newestFirst ? [...rows].reverse() : rows

  return (
    <div className="space-y-8">
      <p className="text-sm text-muted-foreground">
        {totalOpen === 0
          ? 'Every bank row is reconciled.'
          : `${totalOpen} open bank ${totalOpen === 1 ? 'row' : 'rows'} across ${waiting} ${waiting === 1 ? 'entity' : 'entities'}.`}
        {data.mancoOmitted && ' Management companies are not shown; that needs the management-company grant.'}
      </p>

      <div className="space-y-4">
        {sections.map(sec => (
          <div key={sec.group?.id ?? 'other'} className="space-y-2">
            {grouped && (
              <p className="text-eyebrow uppercase text-muted-foreground">
                {sec.label}<span className="ml-1.5 font-normal normal-case tracking-normal tabular-nums">· {sec.items.length}</span>
              </p>
            )}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {sec.items.map(e => <EntityCard key={e.id} e={e} money={money} onFilter={() => setEntity(e.id)} />)}
            </div>
          </div>
        ))}
      </div>

      {totalOpen > 0 && (
        <section className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-base font-medium">Open rows</h2>
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={entity} onChange={e => setEntity(e.target.value)} aria-label="Entity"
                className="h-8 rounded-md border border-input bg-background px-2 text-sm"
              >
                <option value="">All entities</option>
                {data.entities.filter(e => e.openRows > 0).map(e => <option key={e.id} value={e.id}>{e.name} ({e.openRows})</option>)}
              </select>
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <input
                  type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Description or counterparty"
                  className="h-8 w-56 pl-8 pr-8 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                />
                {search && (
                  <button onClick={() => setSearch('')} aria-label="Clear search" className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              <button onClick={() => setNewestFirst(v => !v)} className="h-8 rounded-md border px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
                {newestFirst ? 'Newest first' : 'Oldest first'}
              </button>
            </div>
          </div>

          <div className="overflow-x-auto rounded-card border">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground bg-muted/40">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">Date</th>
                  <th className="text-left px-3 py-2 font-medium">Entity</th>
                  <th className="text-left px-3 py-2 font-medium">Description</th>
                  <th className="text-right px-3 py-2 font-medium">Amount</th>
                  <th className="text-left px-3 py-2 font-medium">Status</th>
                  <th className="text-left px-3 py-2 font-medium">Suggested</th>
                </tr>
              </thead>
              <tbody>
                {ordered.length === 0 && (
                  <tr><td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">No open rows match.</td></tr>
                )}
                {ordered.map(r => {
                  const e = byId.get(r.vehicleId)
                  const href = `/funds/${r.vehicleId}/bank${r.description ? `?q=${encodeURIComponent(r.description)}` : ''}`
                  return (
                      <tr key={r.id} className="border-t hover:bg-muted/30">
                        <td className="px-3 py-2 tabular-nums whitespace-nowrap">{r.txnDate}</td>
                        <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">{e?.name ?? '—'}</td>
                        <td className="px-3 py-2">
                          <Link href={href} className="hover:underline">{r.description || '(no description)'}</Link>
                          {r.counterparty && <span className="ml-2 text-xs text-muted-foreground">{r.counterparty}</span>}
                        </td>
                        <td className={`px-3 py-2 text-right tabular-nums whitespace-nowrap ${r.amount < 0 ? '' : 'text-success'}`}>{money(r.amount)}</td>
                        <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">{STATUS_LABEL[r.status] ?? r.status}</td>
                        <td className="px-3 py-2 text-muted-foreground tabular-nums">{r.suggestedAccountCode ?? ''}</td>
                      </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {data.truncated && (
            <p className="text-xs text-muted-foreground">
              Showing the oldest {data.rows.length} open rows. The counts on the cards are exact; open an entity to see the rest.
            </p>
          )}
        </section>
      )}
    </div>
  )
}

function EntityCard({ e, money, onFilter }: { e: FirmBankEntity; money: (n: number) => string; onFilter: () => void }) {
  const href = `/funds/${e.id}/bank`
  return (
    <div className={`rounded-card border p-4 space-y-2 ${e.openRows > 0 ? 'border-warning/40' : ''}`}>
      <div className="flex items-start justify-between gap-2">
        <Link href={href} className="font-medium hover:underline leading-tight">{e.name}</Link>
        <Link href={href} aria-label={`Open ${e.name} bank`} className="text-muted-foreground hover:text-foreground"><ArrowRight className="h-4 w-4" /></Link>
      </div>
      {e.openRows > 0 ? (
        <>
          <button onClick={onFilter} className="text-sm text-warning hover:underline text-left">
            {e.openRows} open {e.openRows === 1 ? 'row' : 'rows'}{e.oldestOpen ? `, oldest ${e.oldestOpen}` : ''}
          </button>
          <dl className="grid grid-cols-2 gap-x-3 text-xs">
            <dt className="text-muted-foreground">In</dt><dd className="text-right tabular-nums">{money(e.openIn)}</dd>
            <dt className="text-muted-foreground">Out</dt><dd className="text-right tabular-nums">{money(e.openOut)}</dd>
          </dl>
        </>
      ) : e.everImported ? (
        <p className="text-sm text-success inline-flex items-center gap-1"><Check className="h-3.5 w-3.5" />All reconciled</p>
      ) : (
        <p className="text-sm text-muted-foreground">No feed imported yet</p>
      )}
      {e.lastImported && <p className="text-xs text-muted-foreground">Last import {e.lastImported}</p>}
    </div>
  )
}
