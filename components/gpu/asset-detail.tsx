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
import { GPU_EVENT_KINDS, type DatacenterContractRow, type GpuAsset, type GpuAssetEventRow, type GpuAssetTypeRow, type GpuEventKind } from '@/lib/gpu/types'
import type { DepreciationLine } from '@/lib/gpu/depreciation'
import { call, eventBody, fleetPaths, listContracts, listEvents, listTypes, send, type EventForm, type Fetcher } from './fleet-api'
import { assetFigures, assetSchedule, bookingGate, offersBookedActions, todayIso } from './fleet-math'
import { ErrorAlert, Field, FLEET_WRITE_HINT, GatedButton, StatusBadge, selectCls } from './fleet-ui'
import { AssetDialog, CapexDialog } from './fleet-dialogs'
import { ShellSection } from './parts'

// ── GPU fleet (P5) ── One server: what it is, how it depreciates, what has been capitalized into it,
// and its downtime and maintenance log. Listings, monthly revenue and documents arrive with P5-4.

const th = 'whitespace-nowrap px-3 py-2 font-medium'
const num = 'px-3 py-2 text-right tabular-nums'

/** The book schedule, month by month. The last line takes whatever rounding is left (the true-up). */
export function DepreciationTable({ lines }: { lines: DepreciationLine[] }) {
  const currency = useCurrency()
  const money = (n: number) => formatCurrencyFull(n, currency)
  const regular = lines.length > 1 ? lines[0].amount : null
  return (
    <div className="max-h-96 overflow-auto rounded-card border">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-muted text-muted-foreground">
          <tr>
            <th scope="col" className={`${th} text-right`}>#</th>
            <th scope="col" className={`${th} text-left`}>Month</th>
            <th scope="col" className={`${th} text-right`}>Charge</th>
            <th scope="col" className={`${th} text-right`}>Accumulated</th>
            <th scope="col" className={`${th} text-right`}>NBV</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => {
            const trueUp = i === lines.length - 1 && regular != null && l.amount !== regular
            return (
              <tr key={l.month} className="border-t" data-month={i + 1}>
                <td className={`${num} text-muted-foreground`}>{i + 1}</td>
                <td className="whitespace-nowrap px-3 py-2 tabular-nums">{l.month}</td>
                <td className={num}>
                  {money(l.amount)}
                  {trueUp && <span className="ml-1.5 text-caption text-muted-foreground">final-month true-up</span>}
                </td>
                <td className={num}>{money(l.accumulated)}</td>
                <td className={num} data-nbv={l.nbv}>{money(l.nbv)}</td>
              </tr>
            )
          })}
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

  const [asset, setAsset] = useState<GpuAsset | null>(null)
  const [types, setTypes] = useState<GpuAssetTypeRow[]>([])
  const [contracts, setContracts] = useState<DatacenterContractRow[]>([])
  const [events, setEvents] = useState<GpuAssetEventRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dialog, setDialog] = useState<'edit' | 'capex' | null>(null)

  const fetchTypes = useCallback(() => listTypes(lf), [lf])
  const applyTypes = (r: Awaited<ReturnType<typeof listTypes>>) => { if (r.ok) setTypes(r.data.assetTypes) }
  const loadTypes = useCallback(() => { void fetchTypes().then(applyTypes) }, [fetchTypes])

  const fetchAll = useCallback(
    () => Promise.all([call<GpuAsset>(lf, fleetPaths.asset(assetId)), listEvents(lf, assetId), listContracts(lf)] as const),
    [lf, assetId],
  )
  const apply = ([a, e, c]: Awaited<ReturnType<typeof fetchAll>>) => {
    if (a.ok) setAsset(a.data)
    if (e.ok) setEvents(e.data.events)
    if (c.ok) setContracts(c.data.contracts)
    setError(!a.ok ? a.error : !e.ok ? e.error : null)
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

  const asOf = todayIso()
  const f = assetFigures(asset, asOf)
  const lines = assetSchedule(asset)
  const disposed = asset.status === 'disposed'
  const book = bookingGate(canWriteFleet, canBook)
  const typeLabel = types.find(t => t.id === asset.asset_type_id)?.label ?? null
  const contract = contracts.find(c => c.id === asset.datacenter_contract_id)?.facility ?? null

  return (
    <div className="space-y-4">
      {vehicleId && (
        <Link href={`/funds/${vehicleId}/fleet`} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" />Fleet register
        </Link>
      )}
      {error && <ErrorAlert>{error}</ErrorAlert>}

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold">{asset.name}</h2>
            <StatusBadge status={asset.status} />
          </div>
          <p className="text-sm text-muted-foreground">
            {typeLabel ?? 'No type'} &middot; <span className="tabular-nums">{asset.gpu_count}</span> GPUs
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

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label="Cost" value={money(f.cost)} sub={Number(asset.capitalized_costs) > 0 ? `Includes ${money(Number(asset.capitalized_costs))} capitalized` : 'Hardware'} />
        <Metric label="Accumulated depreciation" value={money(f.accumulated)} sub={`Book, through ${asOf}`} />
        <Metric label="NBV today" value={f.nbv == null ? '—' : money(f.nbv)} sub={disposed ? 'Disposed' : asset.in_service_date ? 'Cost less book depreciation' : 'Not in service yet'} />
        <Metric label="Remaining months" value={f.remainingMonths == null ? '—' : String(f.remainingMonths)} sub={`Of a ${asset.useful_life_months}-month life`} />
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
              ['Datacenter', contract ?? '—'],
            ] as const).map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="text-right tabular-nums">{v}</dd>
              </div>
            ))}
          </dl>
          {asset.notes && <p className="mt-3 text-sm text-muted-foreground">{asset.notes}</p>}
        </ShellSection>

        <ShellSection title="Capitalized costs" description="Installation, shipping and spares booked into the asset (R8). Each is a journal entry on its cost account.">
          <p className="text-2xl font-semibold tracking-tight tabular-nums">{money(Number(asset.capitalized_costs ?? 0))}</p>
          <p className="mt-1 text-caption text-muted-foreground">
            Capitalized to date. The schedule below depreciates the hardware cost; a capitalized cost depreciates from the month it is booked, in the ledger.
          </p>
        </ShellSection>
      </div>

      <ShellSection title="Depreciation schedule" description="Straight line to salvage on the hardware cost, month by month from the in-service month.">
        {lines.length === 0
          ? <EmptyState compact>{asset.in_service_date ? 'Nothing to depreciate.' : 'The schedule starts once the asset has an in-service date.'}</EmptyState>
          : <DepreciationTable lines={lines} />}
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
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums">{e.starts_at.slice(0, 10)}</td>
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums">{e.ends_at ? e.ends_at.slice(0, 10) : 'Open'}</td>
                    <td className={num}>{e.gpus_affected ?? 'All'}</td>
                    <td className="px-3 py-2 text-muted-foreground">{e.cause ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
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
function EventRecorder({ fetcher, asset, onDone }: { fetcher: Fetcher; asset: GpuAsset; onDone: () => void }) {
  const empty: EventForm = { kind: 'downtime', starts_at: todayIso(), ends_at: '', gpus_affected: '', cause: '' }
  const [form, setForm] = useState<EventForm>(empty)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const set = (k: keyof EventForm) => (e: { target: { value: string } }) => setForm(f => ({ ...f, [k]: e.target.value }))

  async function record(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError(null)
    const r = await send(fetcher, fleetPaths.events(asset.id), 'POST', eventBody(form))
    setBusy(false)
    if (!r.ok) { setError(r.error); return }
    setForm(empty)
    onDone()
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
        <Field id="event-from" label="From"><Input id="event-from" type="date" value={form.starts_at} onChange={set('starts_at')} /></Field>
        <Field id="event-to" label="To" hint="Blank while ongoing."><Input id="event-to" type="date" value={form.ends_at} onChange={set('ends_at')} /></Field>
        <Field id="event-gpus" label="GPUs affected" hint={`Blank: all ${asset.gpu_count}.`}>
          <Input id="event-gpus" inputMode="numeric" className="text-right tabular-nums" value={form.gpus_affected} onChange={set('gpus_affected')} />
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
