'use client'

import { Fragment, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Loader2, Check, AlertTriangle, ChevronDown, ChevronRight, Search, X } from 'lucide-react'
import { useCurrency, formatCurrency, formatCurrencyFull } from '@/components/currency-context'
import { Metric as MetricBox } from '@/components/ui/metric'
import { useVehicleGroups } from '@/components/vehicle-groups'
import { groupBySection, isGrouped } from '@/lib/vehicle-groups'
import { VEHICLE_KINDS, VEHICLE_KIND_LABELS, isVehicleKind } from '@/lib/vehicle-kinds'
import { attentionFor, CLOSE_GRACE_DAYS, type AttentionItem } from '@/lib/accounting/attention'
import type { FirmVehicleRow } from '@/lib/accounting/firm-load'
import { OnboardingEmptyState } from './fund-overview'

// THE FINANCIALS OVERVIEW: every entity on one page, what each is worth, and what is waiting on
// its books.
//
// It replaced a performance-only table, which answered "how are the funds doing" and nothing else:
// an entity with no partner capital (a GP entity, an individual) was filtered out of it entirely,
// although every entity page links back here as "All entities", and what actually needed doing —
// drafts, open bank rows, unclosed quarters — was only on Admin. The full performance table, with
// its charts and the as-of date, is the Fund performance landing now (/funds/performance).
//
// Two sources, both already loaded by the section landings: the firm-wide state of the books
// (/api/accounting/firm) and the fund economics (/api/accounting/fund-economics), joined by entity
// id, then by name for a legacy vehicle that has no id.

interface Metrics {
  committed: number; paidIn: number; uncalled: number; distributions: number
  nav: number; totalValue: number
  dpi: number | null; rvpi: number | null; tvpi: number | null; irr: number | null
}
interface Economics {
  vehicle: string
  id: string | null
  fund: Metrics
  lp: Metrics
  gp?: Metrics
  carryAccrued?: number
}

interface Entity {
  key: string
  id: string | null
  name: string
  kind: string | null
  books: FirmVehicleRow | null
  econ: Economics | null
  attention: AttentionItem[]
}

const moic = (v: number | null) => (v == null ? '—' : `${v.toFixed(2)}x`)
const kindLabel = (k: string | null) => (k && isVehicleKind(k) ? VEHICLE_KIND_LABELS[k] : 'Fund')
const kindRank = (k: string | null) => {
  const i = VEHICLE_KINDS.indexOf((k ?? 'fund') as (typeof VEHICLE_KINDS)[number])
  return i < 0 ? VEHICLE_KINDS.length : i
}
const hasCapital = (m: Metrics | undefined) => !!m && (m.committed !== 0 || m.paidIn !== 0 || m.distributions !== 0 || m.nav !== 0)
const baseFor = (e: { id: string | null; name: string }) => `/funds/${e.id ?? encodeURIComponent(e.name)}`
const dash = <span className="text-muted-foreground">&mdash;</span>

/**
 * `only` narrows the page to those entity ids — the family page (/funds/group/<id>) is this
 * overview scoped to one entity group. Unset, it is the whole firm, and each group heading links
 * to its family page.
 */
export function FirmOverview({ only }: { only?: string[] } = {}) {
  const currency = useCurrency()
  const fmt = (v: number) => formatCurrency(v, currency)
  const money = (v: number) => formatCurrencyFull(v, currency)
  const vehicleGroups = useVehicleGroups()

  const [books, setBooks] = useState<FirmVehicleRow[] | null>(null)
  const [econ, setEcon] = useState<Economics[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  useEffect(() => {
    let live = true
    Promise.all([
      fetch('/api/accounting/firm?backlog=1').then(r => (r.ok ? r.json() : null)).catch(() => null),
      fetch('/api/accounting/fund-economics').then(r => (r.ok ? r.json() : null)).catch(() => null),
    ]).then(([firm, fe]) => {
      if (!live) return
      setBooks(Array.isArray(firm?.vehicles) ? firm.vehicles : null)
      setEcon(Array.isArray(fe?.vehicles) ? fe.vehicles : [])
    }).finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [])

  const today = useMemo(() => new Date(), [])

  const entities = useMemo<Entity[]>(() => {
    const out: Entity[] = []
    const byId = new Map<string, Economics>()
    const byName = new Map<string, Economics>()
    for (const v of econ) {
      if (v.id) byId.set(v.id, v)
      byName.set(v.vehicle.trim().toLowerCase(), v)
    }
    const used = new Set<Economics>()
    for (const b of books ?? []) {
      const e = (b.id && byId.get(b.id)) || byName.get(b.name.trim().toLowerCase()) || null
      if (e) used.add(e)
      out.push({ key: b.id ?? b.name, id: b.id, name: b.name, kind: b.kind, books: b, econ: e, attention: attentionFor(b, today) })
    }
    // A vehicle the economics know and the books do not (legacy, or the books request failed).
    for (const e of econ) {
      if (used.has(e) || !hasCapital(e.fund)) continue
      out.push({ key: e.id ?? e.vehicle, id: e.id, name: e.vehicle, kind: null, books: null, econ: e, attention: [] })
    }
    const keep = only ? new Set(only) : null
    return out
      .filter(e => !keep || (e.id != null && keep.has(e.id)))
      .sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || a.name.localeCompare(b.name))
  }, [books, econ, today, only])

  if (loading) {
    return (
      <div className="rounded-card border p-6 flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading every entity&rsquo;s books&hellip;
      </div>
    )
  }

  if (entities.length === 0) {
    return only
      ? <p className="text-sm text-muted-foreground">No entity in this group has books you can see yet.</p>
      : <OnboardingEmptyState onCreated={() => window.location.reload()} />
  }

  // Net to LP where there is a GP class to carve out, as the performance table does; otherwise
  // the two are the same numbers and whole fund is the honest label.
  const hasGpSplit = econ.some(v => (v.gp?.paidIn ?? 0) !== 0 || (v.gp?.nav ?? 0) !== 0 || (v.carryAccrued ?? 0) !== 0)
  const m = (v: Economics) => (hasGpSplit ? v.lp : v.fund)

  const q = search.trim().toLowerCase()
  const shown = q ? entities.filter(e => e.name.toLowerCase().includes(q)) : entities

  // Firm totals over every entity, not only the ones the search shows: the tiles are the firm.
  const funds = entities.filter(e => e.econ && hasCapital(e.econ.fund)).map(e => m(e.econ!))
  const totals = sumMetrics(funds)
  const cash = entities.reduce((s, e) => s + (e.books && !e.books.empty ? e.books.cash : 0), 0)
  const waiting = entities.filter(e => e.attention.length > 0)

  const sections = groupBySection(shown, vehicleGroups, e => ({ id: e.id, name: e.name }))
  const grouped = isGrouped(sections, vehicleGroups)
  const toggle = (id: string) => setCollapsed(s => {
    const n = new Set(s)
    if (n.has(id)) n.delete(id); else n.add(id)
    return n
  })
  const COLS = 8

  return (
    <div className="space-y-8">
      {/* The firm in six figures. Ratios are computed after summing, never averaged. */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        <MetricBox label="Committed" value={fmt(totals.committed)} />
        <MetricBox label="Called" value={fmt(totals.paidIn)} sub={totals.committed > 0 ? `${Math.round((totals.paidIn / totals.committed) * 100)}% of committed` : undefined} />
        <MetricBox label="Distributed" value={fmt(totals.distributions)} />
        <MetricBox label="NAV" value={fmt(totals.nav)} />
        <MetricBox label="TVPI" value={moic(totals.tvpi)} sub={hasGpSplit ? 'Net to LP' : undefined} />
        <MetricBox label="Cash" value={fmt(cash)} sub={`Across ${entities.filter(e => e.books && !e.books.empty).length} entities`} />
      </div>

      <section className="space-y-2">
        <h2 className="text-base font-medium">Needs attention</h2>
        {books === null ? (
          <p className="text-sm text-muted-foreground">Could not load the state of the books.</p>
        ) : waiting.length === 0 ? (
          <p className="text-sm text-success inline-flex items-center gap-1.5">
            <Check className="h-4 w-4" />Nothing waiting: no drafts, no open bank rows, every trial balance ties and every quarter is closed.
          </p>
        ) : (
          <ul className="rounded-card border divide-y">
            {waiting.map(e => (
              <li key={e.key} className="px-3 py-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
                <Link href={baseFor(e)} className="font-medium hover:underline min-w-48">{e.name}</Link>
                <span className="flex flex-wrap gap-x-4 gap-y-1">
                  {e.attention.map(item => (
                    <Link
                      key={item.kind}
                      href={`${baseFor(e)}${item.href}`}
                      className={`inline-flex items-center gap-1 hover:underline ${item.kind === 'ties' ? 'text-destructive' : 'text-warning'}`}
                    >
                      {item.kind === 'ties' && <AlertTriangle className="h-3.5 w-3.5" />}
                      {item.label}
                    </Link>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-base font-medium">Entities</h2>
            <p className="text-xs text-muted-foreground">
              Every entity the firm keeps books for. Performance for the vehicles with partner capital; cash and
              holdings for all of them.
            </p>
          </div>
          {entities.length > 8 && (
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <input
                type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search entities…"
                className="h-8 w-48 pl-8 pr-8 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-1 focus:ring-ring"
              />
              {search && (
                <button onClick={() => setSearch('')} aria-label="Clear search" className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          )}
        </div>

        <div className="overflow-x-auto rounded-card border">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground bg-muted/40">
              <tr>
                <th className="text-left px-3 py-2 font-medium">Entity</th>
                <th className="text-left px-3 py-2 font-medium">Kind</th>
                <th className="text-right px-3 py-2 font-medium">NAV</th>
                <th className="text-right px-3 py-2 font-medium">TVPI</th>
                <th className="text-right px-3 py-2 font-medium">Holdings at value</th>
                <th className="text-right px-3 py-2 font-medium">Cash</th>
                <th className="text-left px-3 py-2 font-medium">Closed through</th>
                <th className="text-left px-3 py-2 font-medium">Books</th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 && (
                <tr><td colSpan={COLS} className="px-3 py-8 text-center text-muted-foreground">No entities match.</td></tr>
              )}
              {sections.map(sec => {
                const id = sec.group?.id ?? 'other'
                const isCollapsed = grouped && collapsed.has(id)
                const t = sumMetrics(sec.items.filter(e => e.econ && hasCapital(e.econ.fund)).map(e => m(e.econ!)))
                const secCash = sec.items.reduce((s, e) => s + (e.books && !e.books.empty ? e.books.cash : 0), 0)
                const secHold = sec.items.reduce((s, e) => s + (e.books && !e.books.empty ? e.books.investmentsAtValue : 0), 0)
                const secWaiting = sec.items.filter(e => e.attention.length > 0).length
                return (
                  <Fragment key={id}>
                    {grouped && (
                      // The heading carries the group's subtotals, so a collapsed group still says
                      // what it holds and whether anything in it is waiting.
                      <tr className="border-t bg-muted/20">
                        <td colSpan={2} className="px-3 py-2">
                          <button onClick={() => toggle(id)} aria-expanded={!isCollapsed} className="inline-flex items-center gap-1 text-xs font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground">
                            {isCollapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                            {sec.label}
                            <span className="ml-1 font-normal normal-case tracking-normal tabular-nums">· {sec.items.length}</span>
                          </button>
                          {!only && sec.group && (
                            <Link href={`/funds/group/${sec.group.id}`} className="ml-3 text-xs text-muted-foreground hover:text-foreground hover:underline">
                              Family page
                            </Link>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums font-medium">{t.paidIn !== 0 || t.nav !== 0 ? money(t.nav) : ''}</td>
                        <td className="px-3 py-2 text-right tabular-nums font-medium">{t.tvpi != null ? moic(t.tvpi) : ''}</td>
                        <td className="px-3 py-2 text-right tabular-nums font-medium">{secHold !== 0 ? money(secHold) : ''}</td>
                        <td className="px-3 py-2 text-right tabular-nums font-medium">{money(secCash)}</td>
                        <td />
                        <td className="px-3 py-2 text-xs">
                          {secWaiting > 0 && <span className="text-warning">{secWaiting} waiting</span>}
                        </td>
                      </tr>
                    )}
                    {!isCollapsed && sec.items.map(e => (
                      <EntityRow key={e.key} e={e} m={e.econ && hasCapital(e.econ.fund) ? m(e.econ) : null} money={money} />
                    ))}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground max-w-3xl">
          NAV and TVPI come from the capital accounts{hasGpSplit ? ', net of the GP’s carry' : ''}; the full table, with
          DPI, IRR and an as-of date, is on <Link href="/funds/performance" className="underline underline-offset-4 hover:text-foreground">Fund performance</Link>.
          Cash and holdings are today&rsquo;s ledger balances. A quarter counts as late to close {CLOSE_GRACE_DAYS} days after it ends.
        </p>
      </section>
    </div>
  )
}

function EntityRow({ e, m, money }: { e: Entity; m: Metrics | null; money: (n: number) => string }) {
  const base = baseFor(e)
  const b = e.books
  const live = b && !b.empty
  return (
    <tr className="border-t hover:bg-muted/30">
      <td className="px-3 py-2 font-medium">
        <Link href={base} title={e.name} className="hover:underline truncate max-w-[260px] block">{e.name}</Link>
      </td>
      <td className="px-3 py-2 text-muted-foreground">{kindLabel(e.kind)}</td>
      <td className="px-3 py-2 text-right tabular-nums">{m ? money(m.nav) : dash}</td>
      <td className="px-3 py-2 text-right tabular-nums">{m ? moic(m.tvpi) : dash}</td>
      <td className="px-3 py-2 text-right tabular-nums">
        {live && b.investmentsAtValue !== 0 ? <Link href={`${base}/schedule-of-investments`} className="hover:underline">{money(b.investmentsAtValue)}</Link> : dash}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">
        {live ? <Link href={`${base}/bank`} className="hover:underline">{money(b.cash)}</Link> : dash}
      </td>
      <td className="px-3 py-2 tabular-nums">
        {!b ? dash : b.closedThrough
          ? <Link href={`${base}/periods`} className="hover:underline">{b.closedThrough}</Link>
          : <span className="text-muted-foreground">{b.empty ? '—' : 'Never'}</span>}
      </td>
      <td className="px-3 py-2 whitespace-nowrap">
        {!b ? dash : b.empty
          ? <span className="text-muted-foreground">No entries</span>
          : e.attention.length === 0
            ? <span className="inline-flex items-center gap-1 text-success"><Check className="h-3.5 w-3.5" />Up to date</span>
            : (
              <Link
                href={`${base}${e.attention[0].href}`}
                title={e.attention.map(i => i.label).join('\n')}
                className={`inline-flex items-center gap-1 hover:underline ${e.attention.some(i => i.kind === 'ties') ? 'text-destructive' : 'text-warning'}`}
              >
                <AlertTriangle className="h-3.5 w-3.5" />
                {e.attention.length === 1 ? e.attention[0].label : `${e.attention.length} items waiting`}
              </Link>
            )}
      </td>
    </tr>
  )
}

/** Sum metrics; ratios are recomputed from the sums, never averaged. IRR does not sum. */
function sumMetrics(rows: Metrics[]): Metrics {
  const t = rows.reduce((a, x) => ({
    committed: a.committed + x.committed, paidIn: a.paidIn + x.paidIn, uncalled: a.uncalled + x.uncalled,
    distributions: a.distributions + x.distributions, nav: a.nav + x.nav, totalValue: a.totalValue + x.totalValue,
  }), { committed: 0, paidIn: 0, uncalled: 0, distributions: 0, nav: 0, totalValue: 0 })
  const per = (v: number) => (t.paidIn > 0 ? v / t.paidIn : null)
  return { ...t, dpi: per(t.distributions), rvpi: per(t.nav), tvpi: per(t.totalValue), irr: null }
}
