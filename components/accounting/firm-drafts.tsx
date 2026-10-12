'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Loader2, Search, X, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useCurrency, formatCurrencyFull } from '@/components/currency-context'
import { useCanWrite } from '@/components/access-context'
import { EmptyState } from '@/components/ui/empty-state'
import { chunkIds, describeSkipped } from '@/lib/accounting/journal-selection'
import { releaseNotice, type ReleaseReport } from '@/lib/accounting/release-notice'
import type { FirmDrafts } from '@/lib/accounting/drafts-firm'

// THE /funds/journal LANDING: every draft entry across the firm, in one queue, posted or discarded
// in place. It replaced a list of entities with a draft count each, which meant opening every
// journal to see what was waiting.
//
// Posting and discarding go through the journal's own bulk routes, one call per entity with that
// entity named, so every guard the journal page runs runs here too: a draft that does not balance,
// falls in a closed period, or would touch investments without the grant comes back skipped, with
// its reason, rather than posted.

type Action = 'post' | 'void'

export function FirmDraftsView() {
  const currency = useCurrency()
  const money = (n: number) => formatCurrencyFull(n, currency)
  const canWrite = useCanWrite('accounting')

  const [data, setData] = useState<FirmDrafts | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [entity, setEntity] = useState('')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const load = useCallback(() => {
    return fetch('/api/accounting/firm/drafts')
      .then(async r => {
        const body = await r.json().catch(() => null)
        if (!r.ok) throw new Error(body?.error ?? 'Could not load the drafts.')
        return body as FirmDrafts
      })
      .then(d => { setData(d); setError(null); setSelected(new Set()) })
      .catch(e => setError((e as Error).message))
  }, [])
  useEffect(() => { void load() }, [load])

  const byId = useMemo(() => new Map((data?.entities ?? []).map(e => [e.id, e])), [data])

  if (error && !data) return <p className="text-sm text-destructive">{error}</p>
  if (!data) return <div className="p-8 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
  if (data.entities.length === 0) return <EmptyState>No entities yet. Add one on Admin to start keeping its books.</EmptyState>

  const total = data.entities.reduce((s, e) => s + e.drafts, 0)
  const q = search.trim().toLowerCase()
  const shown = data.drafts
    .filter(d => !entity || d.vehicleId === entity)
    .filter(d => !q || d.memo.toLowerCase().includes(q) || (d.sourceType ?? '').toLowerCase().includes(q))
  const allShownSelected = shown.length > 0 && shown.every(d => selected.has(d.id))

  async function run(action: Action, ids: string[]) {
    if (ids.length === 0 || !data) return
    if (action === 'void' && !window.confirm(`Discard ${ids.length} draft ${ids.length === 1 ? 'entry' : 'entries'}? A draft has never touched the ledger, so nothing is reversed.`)) return
    setBusy(true); setMessage(null)
    // One entity per call: the bulk routes act on one entity's journal, named by `group`.
    const byEntity = new Map<string, string[]>()
    for (const id of ids) {
      const d = data.drafts.find(x => x.id === id)
      if (!d) continue
      byEntity.set(d.vehicleId, [...(byEntity.get(d.vehicleId) ?? []), id])
    }
    let changed = 0
    let failed = false
    const skipped: { id: string; reason: string }[] = []
    const released: Required<Pick<ReleaseReport, 'removedTransactions' | 'unlinkedRegisterRows' | 'warnings'>> = { removedTransactions: [], unlinkedRegisterRows: [], warnings: [] }
    for (const [vehicleId, entityIds] of byEntity) {
      const group = byId.get(vehicleId)?.name
      if (!group) continue
      for (const batch of chunkIds(entityIds)) {
        try {
          const res = await fetch(`/api/accounting/journal/bulk-${action}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ group, ids: batch }),
          })
          if (!res.ok) { failed = true; continue }
          const d = await res.json() as { changed?: number; skipped?: { id: string; reason: string }[] } & ReleaseReport
          changed += d.changed ?? 0
          skipped.push(...(d.skipped ?? []))
          released.removedTransactions.push(...(d.removedTransactions ?? []))
          released.unlinkedRegisterRows.push(...(d.unlinkedRegisterRows ?? []))
          released.warnings.push(...(d.warnings ?? []))
        } catch {
          failed = true
        }
      }
    }
    const verb = action === 'post' ? 'Posted' : 'Discarded'
    setMessage(`${failed ? `Some ${action === 'post' ? 'posts' : 'discards'} failed. ` : ''}${verb} ${changed} ${changed === 1 ? 'entry' : 'entries'}. ${releaseNotice(released) ?? ''} ${describeSkipped(skipped)}`.replace(/\s+/g, ' ').trim())
    await load()
    setBusy(false)
  }

  const toggle = (id: string) => setSelected(s => {
    const n = new Set(s)
    if (n.has(id)) n.delete(id); else n.add(id)
    return n
  })

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {total === 0
          ? 'No drafts waiting anywhere.'
          : `${total} draft ${total === 1 ? 'entry' : 'entries'} across ${data.entities.filter(e => e.drafts > 0).length} ${data.entities.filter(e => e.drafts > 0).length === 1 ? 'entity' : 'entities'}.`}
        {' '}To browse posted entries, open an entity&rsquo;s journal from its card.
        {data.mancoOmitted && ' Management companies are not shown; that needs the management-company grant.'}
      </p>

      <div className="flex flex-wrap gap-2">
        {data.entities.map(e => (
          <Link
            key={e.id}
            href={`/funds/${e.id}/journal${e.drafts > 0 ? '?status=draft' : ''}`}
            className="rounded-lg border px-3 py-1.5 text-sm hover:bg-accent"
          >
            {e.name}
            <span className={`ml-2 tabular-nums ${e.drafts > 0 ? 'text-warning' : 'text-muted-foreground'}`}>{e.drafts}</span>
          </Link>
        ))}
      </div>

      {total > 0 && (
        <section className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={entity} onChange={e => setEntity(e.target.value)} aria-label="Entity"
                className="h-8 rounded-md border border-input bg-background px-2 text-sm"
              >
                <option value="">All entities</option>
                {data.entities.filter(e => e.drafts > 0).map(e => <option key={e.id} value={e.id}>{e.name} ({e.drafts})</option>)}
              </select>
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <input
                  type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Memo or source"
                  className="h-8 w-56 pl-8 pr-8 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                />
                {search && (
                  <button onClick={() => setSearch('')} aria-label="Clear search" className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>
            {canWrite && (
              <div className="flex items-center gap-2">
                <Button size="sm" disabled={busy || selected.size === 0} onClick={() => run('post', [...selected])}>
                  {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}Post {selected.size || ''}
                </Button>
                <Button size="sm" variant="outline" disabled={busy || selected.size === 0} onClick={() => run('void', [...selected])}>
                  Discard {selected.size || ''}
                </Button>
              </div>
            )}
          </div>

          {message && <p className="text-sm text-muted-foreground">{message}</p>}

          <div className="overflow-x-auto rounded-card border">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground bg-muted/40">
                <tr>
                  {canWrite && (
                    <th className="w-8 px-3 py-2">
                      <input
                        type="checkbox" aria-label="Select all shown" checked={allShownSelected}
                        onChange={() => setSelected(s => {
                          const n = new Set(s)
                          if (allShownSelected) shown.forEach(d => n.delete(d.id)); else shown.forEach(d => n.add(d.id))
                          return n
                        })}
                      />
                    </th>
                  )}
                  <th className="text-left px-3 py-2 font-medium">Date</th>
                  <th className="text-left px-3 py-2 font-medium">Entity</th>
                  <th className="text-left px-3 py-2 font-medium">Memo</th>
                  <th className="text-left px-3 py-2 font-medium">Source</th>
                  <th className="text-right px-3 py-2 font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 && (
                  <tr><td colSpan={canWrite ? 6 : 5} className="px-3 py-8 text-center text-muted-foreground">No drafts match.</td></tr>
                )}
                {shown.map(d => (
                  <tr key={d.id} className="border-t hover:bg-muted/30">
                    {canWrite && (
                      <td className="px-3 py-2">
                        <input type="checkbox" aria-label="Select entry" checked={selected.has(d.id)} onChange={() => toggle(d.id)} />
                      </td>
                    )}
                    <td className="px-3 py-2 tabular-nums whitespace-nowrap">{d.entryDate}</td>
                    <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">{byId.get(d.vehicleId)?.name ?? '—'}</td>
                    <td className="px-3 py-2">
                      <Link href={`/funds/${d.vehicleId}/journal?status=draft`} className="hover:underline">{d.memo || '(no memo)'}</Link>
                      {d.imbalance !== 0 && (
                        <span className="ml-2 inline-flex items-center gap-1 text-sm text-destructive">
                          <AlertTriangle className="h-3 w-3" />Off by {money(d.imbalance)}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{d.sourceType ?? ''}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{money(d.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.truncated && (
            <p className="text-xs text-muted-foreground">
              Showing the newest {data.drafts.length} drafts. The counts above are exact; open an entity&rsquo;s journal for the rest.
            </p>
          )}
        </section>
      )}
    </div>
  )
}
