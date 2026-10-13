'use client'

import { Fragment, useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Loader2, Check, AlertTriangle, ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useCurrency, formatCurrencyFull } from '@/components/currency-context'
import { useAccess, useIsAdmin } from '@/components/access-context'
import { VEHICLE_KIND_LABELS, isVehicleKind } from '@/lib/vehicle-kinds'
import { hasSectionForKind, sectionForSlug } from '@/lib/accounting/nav'
import { withCapitalAction, type CapitalAction } from '@/lib/accounting/capital-action'
import { bookAllNote, type BookAllVehicle } from '@/lib/accounting/backfill-note'
import { EmptyState } from '@/components/ui/empty-state'
import { AddVehicleButton } from '@/components/add-vehicle-button'
import { useVehicleGroups, GroupHeadingRow } from '@/components/vehicle-groups'
import { groupBySection, isGrouped } from '@/lib/vehicle-groups'
import { attentionFor } from '@/lib/accounting/attention'

// THE FIRM-WIDE TABLE: every entity the caller may see, with the state of its books.
//
// This is what the separate "Firm overview" page used to be, and the reason it is no longer a page
// of its own is that it turned out to be the landing for EVERY section. `/funds/journal` has to
// answer "which vehicle's journal?", and the answer is a table of the vehicles.
//
// But it is one table, not one column set. Asked "which vehicle's journal?", the number that
// decides is how many drafts are waiting; asked "which vehicle's bank?", it is how many rows are
// unreconciled; asked "which schedule of investments?", it is what the vehicle holds. Showing all
// nine columns everywhere made every section's landing identical, so the question you arrived with
// was the one thing the page did not answer. COLUMNS below maps each section to the two or three
// figures that answer it; the firm-wide Admin page (section null) keeps the full set, because
// there the whole state of the books IS the question.
//
// Management companies are rows in it like anything else. They were a section of their own while
// their pages were a parallel copy of the fund ones; the pages are shared now, so the only thing
// left that is particular to a manco is that its chart has to be seeded before there is anything
// to open — which is the button on its row.

interface Row {
  id: string | null; name: string; kind: string | null
  closedThrough: string | null; lastEntryDate: string | null; firstEntryDate: string | null
  postedEntries: number; draftEntries: number; openBankRows: number
  trialBalanced: boolean; totalDebits: number; empty: boolean; cash: number
  investmentsAtCost: number; investmentsAtValue: number
  underivedTransactions: number
}
interface Overview { vehicles: Row[]; mancoOmitted: boolean }

/** What /api/manco/vehicles adds for a management company: whether its chart is seeded yet. */
interface MancoState {
  id: string; name: string; active: boolean
  accountCount: number; missingAccounts: number; chartSeeded: boolean; convertedFromOtherChart: boolean
}

const kindLabel = (k: string | null) => (k && isVehicleKind(k) ? VEHICLE_KIND_LABELS[k] : 'Fund')

/** Where a row's pages live. Every entity is addressed the same way, management company included. */
function baseFor(r: { id: string | null; name: string; kind: string | null }): string {
  return `/funds/${r.id ?? encodeURIComponent(r.name)}`
}

/**
 * Does this entity have a `<section>` page at all? Null section = the lead page, which every
 * entity has. Answered by the section's own `hideFor`, so a management company is filtered by
 * the same rule as an individual or a GP entity rather than by a list of its own.
 */
function hasSection(r: { kind: string | null }, section: string | null): boolean {
  return !section || hasSectionForKind(section, r.kind)
}

/** A row's link helper, closed over the row's base path and whether it can be linked at all. */
type LinkCell = (label: string | number, href: string, warn?: boolean) => React.ReactNode

interface Col {
  key: string
  label: string
  align?: 'right'
  cell: (r: Row, link: LinkCell, money: (n: number) => string) => React.ReactNode
}

const dash = <span className="text-muted-foreground">&mdash;</span>

const CLOSED: Col = {
  key: 'closed', label: 'Closed through',
  cell: (r, link) => (r.closedThrough ? link(r.closedThrough, '/periods') : <span className="text-muted-foreground">Never</span>),
}
const LAST_ENTRY: Col = {
  key: 'last', label: 'Last entry',
  cell: r => <span className="text-muted-foreground">{r.lastEntryDate ?? '—'}</span>,
}
const POSTED: Col = { key: 'posted', label: 'Posted', align: 'right', cell: (r, link) => link(r.postedEntries, '/journal') }
const DRAFTS: Col = {
  key: 'drafts', label: 'Drafts', align: 'right',
  cell: (r, link) => link(r.draftEntries, '/journal?status=draft', r.draftEntries > 0),
}
const BANK_OPEN: Col = {
  key: 'bank', label: 'Bank open', align: 'right',
  cell: (r, link) => link(r.openBankRows, '/bank', r.openBankRows > 0),
}
const TOTAL_DEBITS: Col = {
  key: 'debits', label: 'Trial balance', align: 'right',
  cell: (r, link, money) => (r.empty ? dash : link(money(r.totalDebits), '/statements')),
}
const TIES: Col = {
  key: 'ties', label: 'Ties',
  cell: r =>
    r.empty
      ? <span className="text-muted-foreground">Empty</span>
      : r.trialBalanced
        ? <span className="inline-flex items-center gap-1 text-success"><Check className="h-3.5 w-3.5" />Yes</span>
        : <span className="inline-flex items-center gap-1 text-destructive"><AlertTriangle className="h-3.5 w-3.5" />No</span>,
}
/** The whole state of the books — the firm-wide Admin view, and the fallback for a section
 *  with no figures of its own (allocation terms, opening balances, a migration). */
const ALL: Col[] = [CLOSED, LAST_ENTRY, POSTED, DRAFTS, BANK_OPEN, TOTAL_DEBITS, TIES]

/**
 * The one figure that answers "which entity?" on each section's picker. The sections whose
 * firm-wide answer is the content itself (bank, journal, close, schedule of investments,
 * performance) have landings of their own and do not come here; Admin keeps the full table.
 */
interface Figure { label: string; value: (r: Row, money: (n: number) => string) => string | null; warn?: (r: Row) => boolean }
const LAST_ENTRY_FIGURE: Figure = { label: 'Last entry', value: r => r.lastEntryDate }
const FIGURES: Record<string, Figure> = {
  ledger: { label: 'Posted entries', value: r => (r.empty ? null : r.postedEntries.toLocaleString()) },
  statements: { label: 'Trial balance', value: (r, m) => (r.empty ? null : m(r.totalDebits)), warn: r => !r.empty && !r.trialBalanced },
  'capital-accounts': { label: 'Closed through', value: r => r.closedThrough },
  tax: { label: 'Closed through', value: r => r.closedThrough },
  // Actuals run through the last close; cash is what a forecast is mostly about.
  forecast: { label: 'Cash', value: (r, m) => (r.empty ? null : m(r.cash)) },
}

/**
 * The one-line summary above the table, counting what THIS section is waiting on. The firm-wide
 * view counts everything, because there the question is whether the books are done at all.
 */
function summaryFor(section: string | null, rows: Row[]): string | null {
  const live = rows.filter(r => !r.empty)
  const n = (count: number, one: string, many: string) =>
    count === 0 ? null : `${count} ${count === 1 ? 'entity' : 'entities'} ${count === 1 ? one : many}`
  switch (section) {
    case 'statements':
    case 'ledger':
      return n(live.filter(r => !r.trialBalanced).length, 'does not tie.', 'do not tie.')
        ?? 'Every trial balance ties.'
    default: {
      const open = rows.filter(r => (!r.empty && (r.draftEntries > 0 || r.openBankRows > 0 || !r.trialBalanced)) || r.underivedTransactions > 0)
      return open.length === 0
        ? 'Nothing waiting: no drafts, no open bank rows, every trial balance ties.'
        : `${open.length} of ${rows.length} entities have something waiting.`
    }
  }
}

export function FirmVehiclesTable({
  section = null,
  showAdd = false,
  action = null,
}: {
  /** The subpage each row leads to (`journal`, `bank`, …), or null for the entity's lead page. */
  section?: string | null
  /** Offer the one Add vehicle button — the firm-wide Admin page carries it. */
  showAdd?: boolean
  /**
   * Carried onto each row's link. /start sends "issue a capital call" to the firm-wide capital
   * accounts landing, which is this table; without forwarding, picking the entity would drop the
   * request and land on a closed panel.
   */
  action?: CapitalAction | null
}) {
  const currency = useCurrency()
  const access = useAccess()
  const isAdmin = useIsAdmin()
  const vehicleGroups = useVehicleGroups()
  const canSeeBooks = access('accounting') !== 'none'
  const canSeeManco = access('management_company') !== 'none'

  const [data, setData] = useState<Overview | null>(null)
  const [manco, setManco] = useState<MancoState[]>([])
  const [loading, setLoading] = useState(true)
  const [booking, setBooking] = useState(false)
  const [bookError, setBookError] = useState<string | null>(null)
  const [bookNote, setBookNote] = useState<string | null>(null)

  // The backlog count costs queries per entity, so only the pages that show it ask for it.
  const withBacklog = section === null || section === 'status'

  const load = useCallback(() => {
    setLoading(true)
    Promise.all([
      // The books of every entity — an `accounting` route. A manco-only bookkeeper cannot call it,
      // and gets the management companies alone from the second request rather than an error.
      canSeeBooks
        ? fetch(withBacklog ? '/api/accounting/firm?backlog=1' : '/api/accounting/firm').then(r => (r.ok ? r.json() : null)).catch(() => null)
        : Promise.resolve(null),
      canSeeManco
        ? fetch('/api/manco/vehicles').then(r => (r.ok ? r.json() : [])).catch(() => [])
        : Promise.resolve([]),
    ]).then(([firm, mancos]) => {
      setData(firm)
      setManco(Array.isArray(mancos) ? mancos : [])
    }).finally(() => setLoading(false))
  }, [canSeeBooks, canSeeManco, withBacklog])
  useEffect(() => { load() }, [load])

  async function bookAll() {
    setBooking(true); setBookError(null); setBookNote(null)
    try {
      const res = await fetch('/api/accounting/investments', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'backfill', all: true }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        setBookError(body?.error ?? 'Could not put the transactions on the ledger.')
        return
      }
      const note = bookAllNote((body?.vehicles ?? []) as BookAllVehicle[])
      if (note) setBookNote(note)
      load()
    } catch {
      setBookError('Could not put the transactions on the ledger.')
    } finally {
      setBooking(false)
    }
  }

  if (loading) {
    return <div className="p-8 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
  }

  // The books rows, plus any management company the firm route did not list (a caller who holds
  // the manco grant without fund accounting sees only these). Merged by id so a manco that IS on
  // the books list is not shown twice.
  const mancoById = new Map(manco.map(m => [m.id, m]))
  const rows: Row[] = [...(data?.vehicles ?? [])]
  const listed = new Set(rows.map(r => r.id).filter(Boolean))
  for (const m of manco) {
    if (listed.has(m.id)) continue
    rows.push({
      id: m.id, name: m.name, kind: 'manco',
      closedThrough: null, lastEntryDate: null, firstEntryDate: null, postedEntries: 0, draftEntries: 0, openBankRows: 0,
      trialBalanced: true, totalDebits: 0, empty: true, cash: 0,
      investmentsAtCost: 0, investmentsAtValue: 0, underivedTransactions: 0,
    })
  }
  const visible = rows.filter(r => hasSection(r, section))

  // Booking every entity's transactions is admin-only; the route enforces it, this just hides the button.
  const showBookAll = (section === null || section === 'status')
    && isAdmin && access('accounting') === 'write' && rows.some(r => r.underivedTransactions > 0)

  const addButton = showAdd ? <AddVehicleButton onCreated={load} /> : null

  if (visible.length === 0) {
    return (
      <EmptyState action={addButton}>
        {rows.length === 0
          ? 'No entities yet. Add a fund, SPV, GP entity, individual or management company to start keeping its books.'
          : 'None of the firm’s entities has this page.'}
      </EmptyState>
    )
  }

  const sectionLabel = section ? sectionForSlug(section)?.label ?? null : null
  const cols = ALL
  const summary = data ? summaryFor(section, visible) : null
  const money = (n: number) => formatCurrencyFull(n, currency)
  // Admin-defined sections (Settings → Entity groups). No subtotals here: these are the state of
  // each entity's books, not amounts that add up across entities.
  const sections = groupBySection(visible, vehicleGroups, r => ({ id: r.id, name: r.name }))
  const grouped = isGrouped(sections, vehicleGroups)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {section
            ? <>Pick an entity to open its {sectionLabel ? sectionLabel.toLowerCase() : 'page'}. </>
            : null}
          {summary}
          {data?.mancoOmitted && !canSeeManco && ' Management companies are not shown; that needs the management-company grant.'}
        </p>
        <div className="flex items-center gap-2">
          {showBookAll && (
            <Button size="sm" variant="outline" onClick={bookAll} disabled={booking}>
              {booking ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}Put every entity&rsquo;s transactions on the ledger
            </Button>
          )}
          {addButton}
        </div>
      </div>

      {bookError && <p className="text-sm text-destructive">{bookError}</p>}
      {bookNote && <p className="text-sm text-muted-foreground">{bookNote}</p>}

      {/* A section's picker is cards: the whole card is the link, with the one figure that answers
          "which entity?" and the state of its books. Admin (no section, or `status`) keeps the
          full table, because there the whole state of the books IS the question. */}
      {section && section !== 'status' ? (
        <div className="space-y-4">
          {sections.map(sec => (
            <div key={sec.group?.id ?? 'other'} className="space-y-2">
              {grouped && (
                <p className="text-eyebrow uppercase text-muted-foreground">
                  {sec.label}<span className="ml-1.5 font-normal normal-case tracking-normal tabular-nums">· {sec.items.length}</span>
                </p>
              )}
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {sec.items.map(r => (
                  <PickerCard
                    key={r.id ?? r.name}
                    row={r}
                    href={withCapitalAction(`${baseFor(r)}/${section}`, action)}
                    figure={FIGURES[section] ?? LAST_ENTRY_FIGURE}
                    money={money}
                    inactive={!!(r.id && mancoById.get(r.id) && !mancoById.get(r.id)!.active)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
      <div className="rounded-card border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-muted-foreground">
            <tr>
              <th className="text-left px-3 py-2 font-medium">Entity</th>
              <th className="text-left px-3 py-2 font-medium">Kind</th>
              {cols.map(c => (
                <th key={c.key} className={`px-3 py-2 font-medium ${c.align === 'right' ? 'text-right' : 'text-left'}`}>{c.label}</th>
              ))}
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {sections.map(sec => (
              <Fragment key={sec.group?.id ?? 'other'}>
                {grouped && <GroupHeadingRow label={sec.label} count={sec.items.length} colSpan={cols.length + 3} />}
                {sec.items.map(r => {
                  const base = baseFor(r)
                  const m = r.id ? mancoById.get(r.id) : undefined
                  // A management company whose chart is not the manco chart yet has nothing to open:
                  // its row offers the setup step where the link would be.
                  const target = withCapitalAction(section ? `${base}/${section}` : base, action)
                  const cell = (label: string | number, href: string, warn = false) => (
                    <Link href={`${base}${href}`} className={warn ? 'text-warning hover:underline' : 'hover:underline'}>{label}</Link>
                  )
                  return (
                    <tr key={r.id ?? r.name} className="border-t">
                      <td className="px-3 py-2 font-medium">
                        <Link href={target} className="hover:underline">{r.name}</Link>
                        {m && !m.active && (
                          <span className="ml-2 rounded-md bg-muted px-1.5 py-0.5 text-caption font-normal text-muted-foreground">Inactive</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{kindLabel(r.kind)}</td>
                      {cols.map(c => (
                        <td key={c.key} className={`px-3 py-2 tabular-nums ${c.align === 'right' ? 'text-right' : 'text-left'}`}>
                          {c.cell(r, cell, money)}
                        </td>
                      ))}
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        <Button asChild variant="outline" size="sm">
                          <Link href={target}>Open <ArrowRight className="ml-1 h-3.5 w-3.5" /></Link>
                        </Button>
                      </td>
                    </tr>
                  )
                })}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      )}
    </div>
  )
}

function PickerCard({ row, href, figure, money, inactive }: {
  row: Row; href: string; figure: Figure; money: (n: number) => string; inactive: boolean
}) {
  const value = figure.value(row, money)
  const waiting = row.empty ? [] : attentionFor(row, new Date())
  const warn = figure.warn?.(row) ?? false
  return (
    <Link href={href} className="group rounded-card border p-4 space-y-2 hover:bg-muted/30 transition-colors">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium leading-tight truncate group-hover:underline">{row.name}</p>
          <p className="text-xs text-muted-foreground">
            {kindLabel(row.kind)}{inactive && ' · Inactive'}
          </p>
        </div>
        <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground group-hover:text-foreground" />
      </div>
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="text-muted-foreground">{figure.label}</span>
        <span className={`tabular-nums ${warn ? 'text-destructive' : ''}`}>{value ?? '—'}</span>
      </div>
      <p className="text-xs">
        {row.empty
          ? <span className="text-muted-foreground">No entries yet</span>
          : waiting.length === 0
            ? <span className="inline-flex items-center gap-1 text-success"><Check className="h-3.5 w-3.5" />Up to date</span>
            : <span className="inline-flex items-center gap-1 text-warning"><AlertTriangle className="h-3.5 w-3.5" />{waiting.length === 1 ? waiting[0].label : `${waiting.length} items waiting`}</span>}
      </p>
    </Link>
  )
}
