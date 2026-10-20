'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Loader2 } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Metric } from '@/components/ui/metric'
import { EmptyState } from '@/components/ui/empty-state'
import { useLedgerFetch } from '@/components/accounting-vehicle'
import { useCanWrite } from '@/components/access-context'
import { useCurrency, formatCurrencyFull } from '@/components/currency-context'
import { GPU_EVENT_KINDS, type DatacenterContractRow, type GpuAssetEventRow, type GpuAssetTypeRow, type GpuEventKind } from '@/lib/gpu/types'
import { eventBody, eventFormError, fleetPaths, getAsset, listContracts, listEvents, listTypes, nowLocalInput, send, utcToLocalLabel, type EventForm, type Fetcher } from './fleet-api'
import { bookingGate, disposedAsOf, isOffBooks, offBooksLabel, offBooksReason, offersBookedActions, todayIso, type ValuedAsset } from './fleet-math'
import { AsOfControl, ErrorAlert, Field, FLEET_WRITE_HINT, GatedButton, StatusBadge, selectCls } from './fleet-ui'
import { AssetDialog, CapexDialog } from './fleet-dialogs'
import { ShellSection } from './parts'

// ── GPU fleet (P5) ── One server: what it is, its book and tax value as of a date (the server's
// valuation), what has been capitalized into it, and its downtime and maintenance log. Listings,
// monthly revenue and documents arrive with P5-4.

const th = 'whitespace-nowrap px-3 py-2 font-medium'
const num = 'px-3 py-2 text-right tabular-nums'

const TAX_METHOD_LABEL: Record<string, string> = {
  book: 'Same as book', straight_line: 'Straight line', macrs_5: 'MACRS 5-year', macrs_7: 'MACRS 7-year', bonus: 'Bonus',
}

/**
 * The server's valuation of the asset as of its date: basis, the book side and the tax book side
 * (Karl's Q7: the SPV takes tax depreciation). Nothing is computed here. An asset the route reports
 * as not on the books at that date (on_books_as_of false) shows its basis and no book or tax value,
 * with the reason from offBooksReason in fleet-math.ts.
 */
export function ValuationCard({ asset }: { asset: ValuedAsset }) {
  const currency = useCurrency()
  const money = (n: number) => formatCurrencyFull(Number(n), currency)
  const off = isOffBooks(asset) && !disposedAsOf(asset)
  const value = (n: number) => (off ? '—' : money(n))
  const rows: [string, string, string][] = [
    ['Basis', money(asset.basis), 'basis'],
    ['Capitalized costs', money(asset.capitalized_costs), 'capitalized_costs'],
  ]
  return (
    <ShellSection
      title="Book and tax"
      description={<>Valued as of <span className="tabular-nums" data-valuation-as-of={asset.valuation_as_of}>{asset.valuation_as_of}</span>, from the ledger.</>}
    >
      {off && (
        <p className="mb-3 text-sm text-muted-foreground">
          {offBooksReason(asset).long}
        </p>
      )}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
        {rows.map(([k, v, key]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="text-right tabular-nums" data-col={key}>{v}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-3 overflow-x-auto rounded-card border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-muted-foreground">
            <tr>
              <th scope="col" className={`${th} text-left`}><span className="sr-only">Book</span></th>
              <th scope="col" className={`${th} text-right`}>Accumulated depreciation</th>
              <th scope="col" className={`${th} text-right`}>NBV</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-t">
              <th scope="row" className="px-3 py-2 text-left font-normal">Book</th>
              <td className={num} data-col="accumulated_book">{value(asset.accumulated_book)}</td>
              <td className={num} data-col="nbv_book">{value(asset.nbv_book)}</td>
            </tr>
            <tr className="border-t">
              <th scope="row" className="px-3 py-2 text-left font-normal">
                Tax book <span className="text-caption text-muted-foreground">({TAX_METHOD_LABEL[asset.tax_method] ?? asset.tax_method})</span>
              </th>
              <td className={num} data-col="accumulated_tax">{value(asset.accumulated_tax)}</td>
              <td className={num} data-col="nbv_tax">{value(asset.nbv_tax)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </ShellSection>
  )
}

/** The capex posted into the asset as of the valuation date: month, amount and the entry's source ref. */
export function CapexEventsTable({ events }: { events: ValuedAsset['capex_events'] }) {
  const currency = useCurrency()
  if (events.length === 0) return <p className="text-sm text-muted-foreground">Nothing capitalized as of this date.</p>
  return (
    <div className="overflow-x-auto rounded-card border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-muted-foreground">
          <tr>
            <th scope="col" className={`${th} text-left`}>Month</th>
            <th scope="col" className={`${th} text-right`}>Amount</th>
            <th scope="col" className={`${th} text-left`}>Source</th>
            <th scope="col" className={`${th} text-left`}>Posted</th>
          </tr>
        </thead>
        <tbody>
          {events.map(e => (
            <tr key={e.source_ref} className="border-t" data-capex={e.source_ref}>
              <td className="whitespace-nowrap px-3 py-2 tabular-nums">{e.month}</td>
              <td className={num}>{formatCurrencyFull(Number(e.amount), currency)}</td>
              <td className="px-3 py-2 font-mono text-xs">{e.source_ref}</td>
              <td className="whitespace-nowrap px-3 py-2 tabular-nums text-muted-foreground">{e.posted_at ? utcToLocalLabel(e.posted_at) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const EVENT_LABEL: Record<GpuEventKind, string> = {
  downtime: 'Downtime', maintenance: 'Maintenance', rma: 'RMA', relocation: 'Relocation', note: 'Note',
}

export function AssetDetail({ vehicleId, assetId }: { vehicle: string; vehicleId: string | null; assetId: string }) {
  const lf = useLedgerFetch() as Fetcher
  const currency = useCurrency()
  const money = (n: number) => formatCurrencyFull(n, currency)
  const canWriteFleet = useCanWrite('fleet')
  const canBook = useCanWrite('accounting')

  const [asset, setAsset] = useState<ValuedAsset | null>(null)
  const [asOf, setAsOf] = useState(todayIso)
  const [types, setTypes] = useState<GpuAssetTypeRow[]>([])
  const [contracts, setContracts] = useState<DatacenterContractRow[]>([])
  const [events, setEvents] = useState<GpuAssetEventRow[] | null>(null)
  // One error per request, so each says what it failed to load and none clears another.
  const [error, setError] = useState<string | null>(null)
  const [eventsError, setEventsError] = useState<string | null>(null)
  const [contractsError, setContractsError] = useState<string | null>(null)
  const [typesError, setTypesError] = useState<string | null>(null)
  const [dialog, setDialog] = useState<'edit' | 'capex' | null>(null)

  const fetchTypes = useCallback(() => listTypes(lf), [lf])
  const applyTypes = (r: Awaited<ReturnType<typeof listTypes>>) => {
    if (r.ok) setTypes(r.data.assetTypes)
    setTypesError(r.ok ? null : r.error)
  }
  const loadTypes = useCallback(() => { void fetchTypes().then(applyTypes) }, [fetchTypes])

  const fetchAll = useCallback(
    () => Promise.all([getAsset(lf, assetId, asOf), listEvents(lf, assetId), listContracts(lf)] as const),
    [lf, assetId, asOf],
  )
  const apply = ([a, e, c]: Awaited<ReturnType<typeof fetchAll>>) => {
    if (a.ok) setAsset(a.data)
    if (e.ok) setEvents(e.data.events)
    if (c.ok) setContracts(c.data.contracts)
    setError(a.ok ? null : a.error)
    setEventsError(e.ok ? null : e.error)
    setContractsError(c.ok ? null : c.error)
  }
  const load = () => { void fetchAll().then(apply) }

  useEffect(() => {
    let cancelled = false
    void fetchAll().then(r => { if (!cancelled) apply(r) })
    void fetchTypes().then(r => { if (!cancelled) applyTypes(r) })
    return () => { cancelled = true }
  }, [fetchAll, fetchTypes]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!asset) {
    return error
      ? <ErrorAlert>{error}</ErrorAlert>
      : <div className="flex justify-center p-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
  }

  // The route resolves the asset's OWN vehicle, so an id from another GPU SPV would load here, inside
  // this one's chrome. It is not this vehicle's asset: not found, like any other id.
  if (asset.vehicle_id !== vehicleId) {
    return (
      <EmptyState action={vehicleId ? <Link href={`/funds/${vehicleId}/fleet`} className="text-sm underline">Back to the fleet register</Link> : undefined}>
        This asset is not in this vehicle&rsquo;s register.
      </EmptyState>
    )
  }

  const off = isOffBooks(asset) && !disposedAsOf(asset)
  const disposed = asset.status === 'disposed'
  const book = bookingGate(canWriteFleet, canBook)
  // A name that could not be loaded is said so, not shown as "No type" or a dash.
  const typeLabel = !asset.asset_type_id ? 'No type'
    : types.find(t => t.id === asset.asset_type_id)?.label ?? (typesError ? 'Type unavailable' : 'Unknown type')
  const contract = !asset.datacenter_contract_id ? '—'
    : contracts.find(c => c.id === asset.datacenter_contract_id)?.facility ?? (contractsError ? 'Unavailable' : 'Unknown contract')

  return (
    <div className="space-y-4">
      {vehicleId && (
        <Link href={`/funds/${vehicleId}/fleet`} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" />Fleet register
        </Link>
      )}
      {error && <ErrorAlert>{error}</ErrorAlert>}
      {typesError && <ErrorAlert>Could not load the GPU types: {typesError}</ErrorAlert>}
      {contractsError && <ErrorAlert>Could not load the datacenter contracts: {contractsError}</ErrorAlert>}

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold">{asset.name}</h2>
            <StatusBadge status={asset.status} />
          </div>
          <p className="text-sm text-muted-foreground">
            {typeLabel} &middot; <span className="tabular-nums">{asset.gpu_count}</span> GPUs
            {asset.serials.length > 0 && <> &middot; <span className="font-mono text-xs">{asset.serials.join(', ')}</span></>}
          </p>
        </div>
        {!disposed && (
          <div className="flex gap-2">
            {offersBookedActions(asset) && (
              <GatedButton allowed={book.allowed} hint={book.hint} onClick={() => setDialog('capex')}>Capitalize a cost</GatedButton>
            )}
            <GatedButton allowed={canWriteFleet} hint={FLEET_WRITE_HINT} onClick={() => setDialog('edit')}>Edit</GatedButton>
          </div>
        )}
      </div>

      {disposed && (
        <div className="rounded-card border bg-muted/40 p-4 text-sm">
          Disposed on <span className="tabular-nums">{asset.disposed_on}</span> for proceeds of{' '}
          <span className="tabular-nums">{money(Number(asset.disposal_proceeds ?? 0))}</span>. The record is read-only.
        </div>
      )}

      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="text-sm text-muted-foreground">Figures are the ledger&rsquo;s valuation as of <span className="tabular-nums">{asset.valuation_as_of}</span>.</p>
        <AsOfControl id="asset-as-of" value={asOf} onChange={setAsOf} />
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label="Basis" value={money(Number(asset.basis))} sub={off ? `${offBooksLabel(asset)}: ${offBooksReason(asset).short.toLowerCase()}` : Number(asset.capitalized_costs) > 0 ? `Includes ${money(Number(asset.capitalized_costs))} capitalized` : 'Hardware'} />
        <Metric label="Book NBV" value={off ? '—' : money(Number(asset.nbv_book))} sub={off ? offBooksReason(asset).short : `Accumulated ${money(Number(asset.accumulated_book))}`} />
        <Metric label="Tax NBV" value={off ? '—' : money(Number(asset.nbv_tax))} sub={off ? offBooksReason(asset).short : `Accumulated ${money(Number(asset.accumulated_tax))}`} />
        <Metric label="Capitalized" value={money(Number(asset.capitalized_costs))} sub={`${asset.capex_events.length} ${asset.capex_events.length === 1 ? 'entry' : 'entries'}`} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ShellSection title="Specs">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
            {([
              ['Hardware cost', money(Number(asset.hardware_cost))],
              ['Salvage value', money(Number(asset.salvage_value))],
              ['Useful life', `${asset.useful_life_months} months`],
              ['Convention', asset.depreciation_convention === 'mid_month' ? 'Mid month' : 'Full month'],
              ['Purchase date', asset.purchase_date ?? '—'],
              ['In service', asset.in_service_date ?? '—'],
              ['Tax method', asset.tax_method],
              ['Tax life', asset.tax_life_years ? `${asset.tax_life_years} years` : '—'],
              ['Insurance basis', asset.insurance_basis == null ? '—' : money(Number(asset.insurance_basis))],
              ['Datacenter', contract],
            ] as const).map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="text-right tabular-nums">{v}</dd>
              </div>
            ))}
          </dl>
          {asset.notes && <p className="mt-3 text-sm text-muted-foreground">{asset.notes}</p>}
        </ShellSection>

        <ValuationCard asset={asset} />
      </div>

      <ShellSection title="Capitalized costs" description="Installation, shipping and spares booked into the asset (R8), each from the month it was posted. Each joins the basis and depreciates prospectively.">
        <CapexEventsTable events={asset.capex_events} />
      </ShellSection>

      <ShellSection title="Events" description="Downtime is the uptime input (Q9): there is no monitoring feed, so record it here.">
        {events && events.length > 0 && (
          <div className="mb-3 overflow-x-auto rounded-card border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th scope="col" className={`${th} text-left`}>Kind</th>
                  <th scope="col" className={`${th} text-left`}>From</th>
                  <th scope="col" className={`${th} text-left`}>To</th>
                  <th scope="col" className={`${th} text-right`}>GPUs</th>
                  <th scope="col" className={`${th} text-left`}>Cause</th>
                </tr>
              </thead>
              <tbody>
                {events.map(e => (
                  <tr key={e.id} className="border-t">
                    <td className="px-3 py-2">{EVENT_LABEL[e.kind]}</td>
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums">{utcToLocalLabel(e.starts_at)}</td>
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums">{e.ends_at ? utcToLocalLabel(e.ends_at) : 'Open'}</td>
                    <td className={num}>{e.gpus_affected ?? 'All'}</td>
                    <td className="px-3 py-2 text-muted-foreground">{e.cause ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {eventsError && <div className="mb-3"><ErrorAlert>Could not load the events: {eventsError}</ErrorAlert></div>}
        {events && events.length === 0 && <p className="mb-3 text-sm text-muted-foreground">No events recorded yet.</p>}
        {!disposed && canWriteFleet && <EventRecorder fetcher={lf} asset={asset} onDone={load} />}
      </ShellSection>

      <ShellSection title="Listings" description="Where the server is offered for rent, and at what rate.">
        <EmptyState compact>No listings yet.</EmptyState>
      </ShellSection>
      <ShellSection title="Monthly revenue & utilization" description="Entered per period on the Revenue & payouts page.">
        <EmptyState compact>No periods entered for this asset yet.</EmptyState>
      </ShellSection>
      <ShellSection title="Documents" description="Invoices, shipping, warranty and datacenter paperwork.">
        <EmptyState compact>No documents attached yet.</EmptyState>
      </ShellSection>

      <AssetDialog open={dialog === 'edit'} onOpenChange={o => !o && setDialog(null)} fetcher={lf} onDone={load}
        asset={asset} types={types} contracts={contracts} onTypesChanged={loadTypes} />
      <CapexDialog open={dialog === 'capex'} onOpenChange={o => !o && setDialog(null)} fetcher={lf} onDone={load} asset={asset} />
    </div>
  )
}

/** Record a downtime, maintenance, RMA, relocation or note against the asset. */
function EventRecorder({ fetcher, asset, onDone }: { fetcher: Fetcher; asset: ValuedAsset; onDone: () => void }) {
  const empty: EventForm = { kind: 'downtime', starts_at: nowLocalInput(), ends_at: '', gpus_affected: '', cause: '' }
  const [form, setForm] = useState<EventForm>(empty)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const set = (k: keyof EventForm) => (e: { target: { value: string } }) => setForm(f => ({ ...f, [k]: e.target.value }))

  async function record(e: React.FormEvent) {
    e.preventDefault()
    // Checked before anything is converted or the form goes busy: a bad value is a message, not a throw.
    const invalid = eventFormError(form)
    if (invalid) { setError(invalid); return }
    setBusy(true); setError(null)
    try {
      const r = await send(fetcher, fleetPaths.events(asset.id), 'POST', eventBody(form))
      if (!r.ok) { setError(r.error); return }
      setForm(empty)
      onDone()
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={record} className="space-y-3 rounded-card border bg-muted/30 p-3">
      <p className="text-sm font-medium">Record an event</p>
      <div className="grid gap-3 sm:grid-cols-5">
        <Field id="event-kind" label="Kind">
          <select id="event-kind" className={selectCls} value={form.kind} onChange={set('kind')}>
            {GPU_EVENT_KINDS.map(k => <option key={k} value={k}>{EVENT_LABEL[k]}</option>)}
          </select>
        </Field>
        <Field id="event-from" label="From"><Input id="event-from" type="datetime-local" value={form.starts_at} onChange={set('starts_at')} /></Field>
        <Field id="event-to" label="To" hint="Blank while ongoing. Your local time."><Input id="event-to" type="datetime-local" min={form.starts_at || undefined} value={form.ends_at} onChange={set('ends_at')} /></Field>
        <Field id="event-gpus" label="GPUs affected" hint={`Blank: all ${asset.gpu_count}.`}>
          <Input id="event-gpus" type="number" min={1} max={asset.gpu_count} step={1} inputMode="numeric" className="text-right tabular-nums" value={form.gpus_affected} onChange={set('gpus_affected')} />
        </Field>
        <Field id="event-cause" label="Cause"><Input id="event-cause" value={form.cause} onChange={set('cause')} /></Field>
      </div>
      {error && <ErrorAlert>{error}</ErrorAlert>}
      <div className="flex justify-end">
        <Button type="submit" size="sm" variant="outline" disabled={busy || !form.starts_at}>Record event</Button>
      </div>
    </form>
  )
}
