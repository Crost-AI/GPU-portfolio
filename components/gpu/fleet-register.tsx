'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Loader2, Plus } from 'lucide-react'
import { EmptyState } from '@/components/ui/empty-state'
import { useLedgerFetch } from '@/components/accounting-vehicle'
import { useCanWrite } from '@/components/access-context'
import { useCurrency, formatCurrencyFull } from '@/components/currency-context'
import type { DatacenterContractRow, GpuAsset, GpuAssetTypeRow } from '@/lib/gpu/types'
import { fleetPaths, listAssets, listContracts, listTypes, send, type Fetcher } from './fleet-api'
import { assetFigures, fleetTotals, todayIso } from './fleet-math'
import { ACCOUNTING_WRITE_HINT, ErrorAlert, FLEET_WRITE_HINT, GatedButton, StatusBadge } from './fleet-ui'
import { AssetDialog, ContractDialog, DisposeDialog, EndContractDialog, PurchaseDialog, RollDialog } from './fleet-dialogs'
import { ShellSection } from './parts'

// ── GPU fleet (P5) ── The fleet register: one row per server, with what it cost and what it is worth
// on the books today, and the datacenter contracts it sits under. Purchase, disposal and contract
// schedules post to the ledger, so they need accounting write as well as the fleet's; the routes
// enforce it and the buttons say so.

const th = 'whitespace-nowrap px-3 py-2 font-medium'
const num = 'px-3 py-2 text-right tabular-nums'

export interface RegisterTableProps {
  assets: GpuAsset[]
  types: GpuAssetTypeRow[]
  contracts: DatacenterContractRow[]
  asOf: string
  vehicleId: string | null
  canWriteFleet: boolean
  canBook: boolean
  onPurchase: (a: GpuAsset) => void
  onDispose: (a: GpuAsset) => void
  onDelete: (a: GpuAsset) => void
}

/** The register table and its totals row (the fleet as it stands: disposed assets excluded). */
export function RegisterTable({ assets, types, contracts, asOf, vehicleId, canWriteFleet, canBook, onPurchase, onDispose, onDelete }: RegisterTableProps) {
  const currency = useCurrency()
  const money = (n: number) => formatCurrencyFull(n, currency)
  const typeLabel = new Map(types.map(t => [t.id, t.label]))
  const facility = new Map(contracts.map(c => [c.id, c.facility]))
  const totals = fleetTotals(assets, asOf)

  return (
    <div className="overflow-x-auto rounded-card border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-muted-foreground">
          <tr>
            <th scope="col" className={`${th} text-left`}>Asset</th>
            <th scope="col" className={`${th} text-left`}>Type</th>
            <th scope="col" className={`${th} text-right`}>GPUs</th>
            <th scope="col" className={`${th} text-left`}>Status</th>
            <th scope="col" className={`${th} text-left`}>In service</th>
            <th scope="col" className={`${th} text-right`} title="What the ledger holds: booked purchases and capitalized costs">Cost</th>
            <th scope="col" className={`${th} text-right`} title="Cost of assets whose purchase is not booked yet">Planned</th>
            <th scope="col" className={`${th} text-right`}>NBV</th>
            <th scope="col" className={`${th} text-left`}>Contract</th>
            <th scope="col" className={th}><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {assets.map(a => {
            const f = assetFigures(a, asOf)
            const href = vehicleId ? `/funds/${vehicleId}/fleet/${a.id}` : null
            return (
              <tr key={a.id} className="border-t" data-asset={a.id}>
                <td className="px-3 py-2 font-medium">{href ? <Link href={href} className="hover:underline">{a.name}</Link> : a.name}</td>
                <td className="px-3 py-2 text-muted-foreground">{(a.asset_type_id && typeLabel.get(a.asset_type_id)) || '—'}</td>
                <td className={num}>{a.gpu_count}</td>
                <td className="px-3 py-2"><StatusBadge status={a.status} /></td>
                <td className="whitespace-nowrap px-3 py-2 tabular-nums">{a.in_service_date ?? '—'}</td>
                <td className={num} data-cost={f.booked ? f.cost : ''}>{f.booked ? money(f.cost) : '—'}</td>
                <td className={`${num} text-muted-foreground`} data-planned={f.booked ? '' : f.cost}>{f.booked ? '—' : money(f.cost)}</td>
                <td className={num} data-nbv={f.nbv ?? ''}>{f.nbv == null ? '—' : money(f.nbv)}</td>
                <td className="px-3 py-2 text-muted-foreground">{(a.datacenter_contract_id && facility.get(a.datacenter_contract_id)) || '—'}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right">
                  <div className="flex justify-end gap-1.5">
                    {a.status === 'planned' && !a.purchase_entry_id && (
                      <GatedButton allowed={canBook} hint={ACCOUNTING_WRITE_HINT} onClick={() => onPurchase(a)}>Purchase</GatedButton>
                    )}
                    {a.status !== 'planned' && a.status !== 'disposed' && (
                      <GatedButton allowed={canBook} hint={ACCOUNTING_WRITE_HINT} onClick={() => onDispose(a)}>Dispose</GatedButton>
                    )}
                    {a.status === 'planned' && !a.purchase_entry_id && (
                      <GatedButton allowed={canWriteFleet} hint={FLEET_WRITE_HINT} variant="ghost" onClick={() => onDelete(a)}>Delete</GatedButton>
                    )}
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
        <tfoot>
          <tr className="border-t bg-muted/30 font-medium">
            <td className="px-3 py-2" colSpan={2}>Fleet ({totals.assets} {totals.assets === 1 ? 'asset' : 'assets'}, excluding disposed)</td>
            <td className={num} data-total="gpus">{totals.gpus}</td>
            <td className="px-3 py-2" colSpan={2} />
            <td className={num} data-total="cost">{money(totals.cost)}</td>
            <td className={`${num} text-muted-foreground`} data-total="planned">{money(totals.planned)}</td>
            <td className={num} data-total="nbv">{money(totals.nbv)}</td>
            <td className="px-3 py-2" colSpan={2} />
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

export interface ContractsTableProps {
  contracts: DatacenterContractRow[]
  canBook: boolean
  onEnd: (c: DatacenterContractRow) => void
  onRoll: (c: DatacenterContractRow) => void
}

export function ContractsTable({ contracts, canBook, onEnd, onRoll }: ContractsTableProps) {
  const currency = useCurrency()
  return (
    <div className="overflow-x-auto rounded-card border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-muted-foreground">
          <tr>
            <th scope="col" className={`${th} text-left`}>Facility</th>
            <th scope="col" className={`${th} text-left`}>Start</th>
            <th scope="col" className={`${th} text-left`}>End</th>
            <th scope="col" className={`${th} text-right`}>Monthly fee</th>
            <th scope="col" className={`${th} text-right`}>Escalator</th>
            <th scope="col" className={`${th} text-left`}>Escalates on</th>
            <th scope="col" className={`${th} text-left`}>Status</th>
            <th scope="col" className={`${th} text-left`}>Schedule</th>
            <th scope="col" className={th}><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {contracts.map(c => (
            <tr key={c.id} className="border-t" data-contract={c.id}>
              <td className="px-3 py-2 font-medium">{c.facility}</td>
              <td className="whitespace-nowrap px-3 py-2 tabular-nums">{c.start_date}</td>
              <td className="whitespace-nowrap px-3 py-2 tabular-nums">{c.end_date ?? '—'}</td>
              <td className={num}>{formatCurrencyFull(Number(c.monthly_fee), currency)}</td>
              <td className={num}>{`${Math.round(Number(c.escalator_pct) * 10000) / 100}%`}</td>
              <td className="px-3 py-2 text-muted-foreground">{c.escalates_on === 'calendar_year' ? 'Calendar year' : 'Anniversary'}</td>
              <td className="px-3 py-2">{c.status === 'ended' ? 'Ended' : 'Active'}</td>
              <td className="px-3 py-2 text-muted-foreground">{c.schedule_id ? 'Accruing' : 'None'}</td>
              <td className="whitespace-nowrap px-3 py-2 text-right">
                {c.status === 'active' && (
                  <div className="flex justify-end gap-1.5">
                    <GatedButton allowed={canBook} hint={ACCOUNTING_WRITE_HINT} onClick={() => onRoll(c)}>Roll schedules</GatedButton>
                    <GatedButton allowed={canBook} hint={ACCOUNTING_WRITE_HINT} onClick={() => onEnd(c)}>End contract</GatedButton>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

type Dialog =
  | { kind: 'add' } | { kind: 'purchase'; asset: GpuAsset } | { kind: 'dispose'; asset: GpuAsset }
  | { kind: 'contract' } | { kind: 'end'; contract: DatacenterContractRow } | { kind: 'roll'; contract: DatacenterContractRow }
  | null

export function FleetRegister({ vehicleId }: { vehicle: string; vehicleId: string | null }) {
  const lf = useLedgerFetch() as Fetcher
  const canWriteFleet = useCanWrite('fleet')
  const canBook = useCanWrite('accounting')

  const [assets, setAssets] = useState<GpuAsset[] | null>(null)
  const [types, setTypes] = useState<GpuAssetTypeRow[]>([])
  const [contracts, setContracts] = useState<DatacenterContractRow[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [dialog, setDialog] = useState<Dialog>(null)

  const fetchTypes = useCallback(() => listTypes(lf), [lf])
  const applyTypes = (r: Awaited<ReturnType<typeof listTypes>>) => { if (r.ok) setTypes(r.data.assetTypes); else setLoadError(r.error) }
  const loadTypes = () => { void fetchTypes().then(applyTypes) }

  const fetchAll = useCallback(() => Promise.all([listAssets(lf), listContracts(lf)] as const), [lf])
  const apply = ([a, c]: Awaited<ReturnType<typeof fetchAll>>) => {
    if (a.ok) setAssets(a.data.assets)
    if (c.ok) setContracts(c.data.contracts)
    setLoadError(!a.ok ? a.error : !c.ok ? c.error : null)
  }
  const load = () => { void fetchAll().then(apply) }

  useEffect(() => {
    let cancelled = false
    void fetchAll().then(r => { if (!cancelled) apply(r) })
    void fetchTypes().then(r => { if (!cancelled) applyTypes(r) })
    return () => { cancelled = true }
  }, [fetchAll, fetchTypes]) // eslint-disable-line react-hooks/exhaustive-deps

  const close = () => setDialog(null)
  const done = () => { setActionError(null); void load() }

  async function remove(a: GpuAsset) {
    if (!window.confirm(`Delete ${a.name} from the register? Nothing is booked for it.`)) return
    setActionError(null)
    const r = await send(lf, fleetPaths.asset(a.id), 'DELETE')
    if (!r.ok) setActionError(r.error)
    else void load()
  }

  const asOf = todayIso()

  return (
    <div className="space-y-4">
      {loadError && <ErrorAlert>{loadError}</ErrorAlert>}

      <ShellSection
        title="Assets"
        description="Cost and net book value are what the ledger holds: an asset counts once its purchase is booked. Until then its cost is planned."
        action={<GatedButton allowed={canWriteFleet} hint={FLEET_WRITE_HINT} variant="default" onClick={() => setDialog({ kind: 'add' })}><Plus className="mr-1 h-4 w-4" />Add asset</GatedButton>}
      >
        {actionError && <div className="mb-3"><ErrorAlert>{actionError}</ErrorAlert></div>}
        {assets === null ? (
          loadError ? null : <div className="flex justify-center p-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : assets.length === 0 ? (
          <EmptyState compact>No assets yet. Add the servers this vehicle owns or has on order.</EmptyState>
        ) : (
          <RegisterTable
            assets={assets} types={types} contracts={contracts ?? []} asOf={asOf} vehicleId={vehicleId}
            canWriteFleet={canWriteFleet} canBook={canBook}
            onPurchase={a => setDialog({ kind: 'purchase', asset: a })}
            onDispose={a => setDialog({ kind: 'dispose', asset: a })}
            onDelete={remove}
          />
        )}
        {!canBook && assets !== null && assets.length > 0 && (
          <p className="mt-2 text-caption text-muted-foreground">Purchase and disposal book to the ledger, so they need write access to Accounting.</p>
        )}
      </ShellSection>

      <ShellSection
        title="Datacenter contracts"
        description="Each contract's monthly fee accrues on a schedule the close books from."
        action={<GatedButton allowed={canWriteFleet} hint={FLEET_WRITE_HINT} onClick={() => setDialog({ kind: 'contract' })}><Plus className="mr-1 h-4 w-4" />Add contract</GatedButton>}
      >
        {contracts === null ? null : contracts.length === 0 ? (
          <EmptyState compact>No datacenter contracts yet.</EmptyState>
        ) : (
          <ContractsTable
            contracts={contracts} canBook={canBook}
            onEnd={c => setDialog({ kind: 'end', contract: c })}
            onRoll={c => setDialog({ kind: 'roll', contract: c })}
          />
        )}
      </ShellSection>

      <AssetDialog
        open={dialog?.kind === 'add'} onOpenChange={o => !o && close()} fetcher={lf} onDone={done}
        types={types} contracts={contracts ?? []} onTypesChanged={loadTypes}
      />
      <PurchaseDialog open={dialog?.kind === 'purchase'} onOpenChange={o => !o && close()} fetcher={lf} onDone={done}
        asset={dialog?.kind === 'purchase' ? dialog.asset : null} />
      <DisposeDialog open={dialog?.kind === 'dispose'} onOpenChange={o => !o && close()} fetcher={lf} onDone={done}
        asset={dialog?.kind === 'dispose' ? dialog.asset : null} />
      <ContractDialog open={dialog?.kind === 'contract'} onOpenChange={o => !o && close()} fetcher={lf} onDone={done} canSchedule={canBook} />
      <EndContractDialog open={dialog?.kind === 'end'} onOpenChange={o => !o && close()} fetcher={lf} onDone={done}
        contract={dialog?.kind === 'end' ? dialog.contract : null} />
      <RollDialog open={dialog?.kind === 'roll'} onOpenChange={o => !o && close()} fetcher={lf} onDone={done}
        contract={dialog?.kind === 'roll' ? dialog.contract : null} />
    </div>
  )
}
