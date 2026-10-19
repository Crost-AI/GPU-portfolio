'use client'

import { useMemo, useState } from 'react'
import { Plus } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { useCurrency, formatCurrencyFull } from '@/components/currency-context'
import { DEPRECIATION_CONVENTIONS, TAX_METHODS, type DatacenterContractRow, type GpuAsset, type GpuAssetTypeRow } from '@/lib/gpu/types'
import {
  EMPTY_ASSET_FORM, EMPTY_CONTRACT_FORM, EMPTY_TYPE_FORM, assetBody, assetFormOf, assetPatch, capexSubmitter, contractBody,
  disposeBody, endContractBody, fleetPaths, purchaseBody, rollBody, send, typeBody,
  type AssetForm, type CapexForm, type ContractForm, type Fetcher, type TypeForm,
} from './fleet-api'
import { todayIso } from './fleet-math'
import { ErrorAlert, Field, FormDialog, selectCls } from './fleet-ui'

// ── GPU fleet (P5) ── Every write the fleet pages make, one dialog each. Each returns the route's
// error text to FormDialog, which shows it verbatim; a success closes it and the page re-fetches.

interface Common { open: boolean; onOpenChange: (o: boolean) => void; fetcher: Fetcher; onDone: () => void }

/**
 * Mount a dialog's form only while it is open, so every opening starts from fresh state (a new
 * capex key, today's date, an empty form) without an effect resetting it.
 */
function whileOpen<P extends Common>(Body: (p: P) => React.ReactElement | null) {
  return function Gated(p: P) { return p.open ? <Body {...p} /> : null }
}

const CONVENTION_LABEL: Record<string, string> = { full_month: 'Full month', mid_month: 'Mid month' }
const TAX_LABEL: Record<string, string> = {
  book: 'Same as book', straight_line: 'Straight line', macrs_5: 'MACRS 5-year', macrs_7: 'MACRS 7-year', bonus: 'Bonus',
}

// ── Asset ────────────────────────────────────────────────────────────────────────────────────

/** Add an asset (no `asset`) or edit one. The type picker can add a GPU type in place. */
export const AssetDialog = whileOpen(function AssetDialogBody({ open, onOpenChange, fetcher, onDone, asset, types, contracts, onTypesChanged }: Common & {
  asset?: GpuAsset
  types: GpuAssetTypeRow[]
  contracts: DatacenterContractRow[]
  onTypesChanged: () => void
}) {
  const [form, setForm] = useState<AssetForm>(() => (asset ? assetFormOf(asset) : EMPTY_ASSET_FORM))
  const [addingType, setAddingType] = useState(false)
  const set = (k: keyof AssetForm) => (e: { target: { value: string } }) => setForm(f => ({ ...f, [k]: e.target.value }))

  const editing = !!asset
  // What the route will refuse anyway, said up front: the cost once booked, the schedule once depreciated.
  const costLocked = editing && (asset!.status !== 'planned' || !!asset!.purchase_entry_id)

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? `Edit ${asset!.name}` : 'Add asset'}
      description={editing ? 'Changes the register. What is already booked to the ledger is corrected there, not here.' : 'One server. It starts planned; booking its purchase orders it.'}
      submitLabel={editing ? 'Save' : 'Add asset'}
      canSubmit={!!form.name.trim() && Number(form.gpu_count) > 0 && form.hardware_cost.trim() !== ''}
      onSubmit={async () => {
        const r = editing
          ? await send(fetcher, fleetPaths.asset(asset!.id), 'PATCH', assetPatch(asset!, form))
          : await send(fetcher, fleetPaths.assets, 'POST', assetBody(form))
        if (!r.ok) return r.error
        onDone()
        return null
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="asset-name" label="Name"><Input id="asset-name" value={form.name} onChange={set('name')} placeholder="e.g. H200 NVL #1" /></Field>
        <Field id="asset-type" label="GPU type">
          <div className="flex gap-1.5">
            <select id="asset-type" className={selectCls} value={form.asset_type_id} onChange={set('asset_type_id')}>
              <option value="">No type</option>
              {types.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
            <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={() => setAddingType(v => !v)} aria-label="Add GPU type" title="Add GPU type">
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </Field>
      </div>
      {addingType && (
        <TypeInlineForm fetcher={fetcher} onAdded={t => { onTypesChanged(); setForm(f => ({ ...f, asset_type_id: t.id, gpu_count: String(t.gpus_per_server) })); setAddingType(false) }} />
      )}
      <div className="grid gap-3 sm:grid-cols-3">
        <Field id="asset-gpus" label="GPUs"><Input id="asset-gpus" inputMode="numeric" className="text-right tabular-nums" value={form.gpu_count} onChange={set('gpu_count')} /></Field>
        <Field id="asset-cost" label="Hardware cost" hint={costLocked ? 'Booked; correct it in the ledger.' : undefined}>
          <Input id="asset-cost" inputMode="decimal" className="text-right tabular-nums" value={form.hardware_cost} onChange={set('hardware_cost')} disabled={costLocked} />
        </Field>
        <Field id="asset-salvage" label="Salvage" hint="Blank: 10% of hardware cost.">
          <Input id="asset-salvage" inputMode="decimal" className="text-right tabular-nums" value={form.salvage_value} onChange={set('salvage_value')} />
        </Field>
        <Field id="asset-life" label="Useful life (months)"><Input id="asset-life" inputMode="numeric" className="text-right tabular-nums" value={form.useful_life_months} onChange={set('useful_life_months')} /></Field>
        <Field id="asset-convention" label="Convention">
          <select id="asset-convention" className={selectCls} value={form.depreciation_convention} onChange={set('depreciation_convention')}>
            {DEPRECIATION_CONVENTIONS.map(c => <option key={c} value={c}>{CONVENTION_LABEL[c]}</option>)}
          </select>
        </Field>
        <Field id="asset-in-service" label="In service"><Input id="asset-in-service" type="date" value={form.in_service_date} onChange={set('in_service_date')} /></Field>
        <Field id="asset-tax" label="Tax method">
          <select id="asset-tax" className={selectCls} value={form.tax_method} onChange={set('tax_method')}>
            {TAX_METHODS.map(m => <option key={m} value={m}>{TAX_LABEL[m]}</option>)}
          </select>
        </Field>
        <Field id="asset-bonus" label="Bonus %"><Input id="asset-bonus" inputMode="decimal" className="text-right tabular-nums" value={form.tax_bonus_pct} onChange={set('tax_bonus_pct')} /></Field>
        <Field id="asset-tax-life" label="Tax life (years)"><Input id="asset-tax-life" inputMode="numeric" className="text-right tabular-nums" value={form.tax_life_years} onChange={set('tax_life_years')} /></Field>
        <Field id="asset-insurance" label="Insurance basis"><Input id="asset-insurance" inputMode="decimal" className="text-right tabular-nums" value={form.insurance_basis} onChange={set('insurance_basis')} /></Field>
        <Field id="asset-contract" label="Datacenter contract" className="sm:col-span-2">
          <select id="asset-contract" className={selectCls} value={form.datacenter_contract_id} onChange={set('datacenter_contract_id')}>
            <option value="">None</option>
            {contracts.map(c => <option key={c.id} value={c.id}>{c.facility}</option>)}
          </select>
        </Field>
      </div>
      <Field id="asset-serials" label="Serials" hint="One per line.">
        <Textarea id="asset-serials" rows={2} className="font-mono" value={form.serials} onChange={set('serials')} />
      </Field>
      <Field id="asset-notes" label="Notes"><Input id="asset-notes" value={form.notes} onChange={set('notes')} /></Field>
    </FormDialog>
  )
})

/** Add a GPU type from the asset form's picker. A duplicate code comes back as the route's 409. */
function TypeInlineForm({ fetcher, onAdded }: { fetcher: Fetcher; onAdded: (t: GpuAssetTypeRow) => void }) {
  const [form, setForm] = useState<TypeForm>(EMPTY_TYPE_FORM)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const set = (k: keyof TypeForm) => (e: { target: { value: string } }) => setForm(f => ({ ...f, [k]: e.target.value }))

  async function add() {
    setBusy(true); setError(null)
    const r = await send<GpuAssetTypeRow>(fetcher, fleetPaths.types, 'POST', typeBody(form))
    setBusy(false)
    if (!r.ok) setError(r.error)
    else { setForm(EMPTY_TYPE_FORM); onAdded(r.data) }
  }

  return (
    <div className="space-y-3 rounded-card border bg-muted/30 p-3">
      <p className="text-sm font-medium">New GPU type</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field id="type-code" label="Code" hint="e.g. h200-nvl"><Input id="type-code" className="font-mono" value={form.code} onChange={set('code')} /></Field>
        <Field id="type-label" label="Label"><Input id="type-label" value={form.label} onChange={set('label')} placeholder="H200 NVL" /></Field>
        <Field id="type-model" label="GPU model"><Input id="type-model" value={form.gpu_model} onChange={set('gpu_model')} /></Field>
        <Field id="type-gpus" label="GPUs per server"><Input id="type-gpus" inputMode="numeric" className="text-right tabular-nums" value={form.gpus_per_server} onChange={set('gpus_per_server')} /></Field>
        <Field id="type-rate" label="Anchor $/GPU-hour"><Input id="type-rate" inputMode="decimal" className="text-right tabular-nums" value={form.anchor_rate} onChange={set('anchor_rate')} /></Field>
      </div>
      {error && <ErrorAlert>{error}</ErrorAlert>}
      <div className="flex justify-end">
        <Button type="button" size="sm" variant="outline" disabled={busy || !form.code.trim() || !form.label.trim()} onClick={add}>Add type</Button>
      </div>
    </div>
  )
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────────────────────

export const PurchaseDialog = whileOpen(function PurchaseDialogBody({ open, onOpenChange, fetcher, onDone, asset }: Common & { asset: GpuAsset | null }) {
  const currency = useCurrency()
  const [entryDate, setEntryDate] = useState(todayIso)
  const [invoiced, setInvoiced] = useState(false)
  if (!asset) return null
  return (
    <FormDialog
      open={open} onOpenChange={onOpenChange}
      title={`Book the purchase of ${asset.name}`}
      description={`Debits the asset's cost account ${formatCurrencyFull(Number(asset.hardware_cost), currency)} and credits cash, or accrued liabilities when invoiced and not yet paid.`}
      submitLabel="Book purchase"
      canSubmit={/^\d{4}-\d{2}-\d{2}$/.test(entryDate)}
      onSubmit={async () => {
        const r = await send(fetcher, fleetPaths.purchase(asset.id), 'POST', purchaseBody(entryDate, invoiced))
        if (!r.ok) return r.error
        onDone(); return null
      }}
    >
      <Field id="purchase-date" label="Date"><Input id="purchase-date" type="date" value={entryDate} onChange={e => setEntryDate(e.target.value)} /></Field>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={invoiced} onChange={e => setInvoiced(e.target.checked)} />
        Invoiced, not yet paid
      </label>
    </FormDialog>
  )
})

export const DisposeDialog = whileOpen(function DisposeDialogBody({ open, onOpenChange, fetcher, onDone, asset }: Common & { asset: GpuAsset | null }) {
  const [disposedOn, setDisposedOn] = useState(todayIso)
  const [proceeds, setProceeds] = useState('')
  if (!asset) return null
  return (
    <FormDialog
      open={open} onOpenChange={onOpenChange}
      title={`Dispose of ${asset.name}`}
      description="Clears the asset's cost and accumulated depreciation and books the gain or loss. Depreciation stops after the disposal month. This cannot be undone here."
      submitLabel="Dispose"
      canSubmit={/^\d{4}-\d{2}-\d{2}$/.test(disposedOn) && proceeds.trim() !== '' && Number.isFinite(Number(proceeds))}
      onSubmit={async () => {
        const r = await send(fetcher, fleetPaths.dispose(asset.id), 'POST', disposeBody(disposedOn, proceeds))
        if (!r.ok) return r.error
        onDone(); return null
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="dispose-date" label="Disposed on"><Input id="dispose-date" type="date" value={disposedOn} onChange={e => setDisposedOn(e.target.value)} /></Field>
        <Field id="dispose-proceeds" label="Proceeds"><Input id="dispose-proceeds" inputMode="decimal" className="text-right tabular-nums" value={proceeds} onChange={e => setProceeds(e.target.value)} placeholder="0.00" /></Field>
      </div>
    </FormDialog>
  )
})

/** Capitalize a cost. One idempotency key per opening, so a retry books it once. */
export const CapexDialog = whileOpen(function CapexDialogBody({ open, onOpenChange, fetcher, onDone, asset }: Common & { asset: GpuAsset }) {
  // Created once per opening (the body mounts on open): every submit until it closes sends one key.
  const submitter = useMemo(() => capexSubmitter(fetcher, asset.id), [fetcher, asset.id])
  const [form, setForm] = useState<CapexForm>(() => ({ amount: '', entryDate: todayIso(), memo: '', invoiced: false }))
  return (
    <FormDialog
      open={open} onOpenChange={onOpenChange}
      title="Capitalize a cost"
      description={`Installation, shipping or spares actually spent on ${asset.name}. It joins the asset's cost and depreciates over the remaining life.`}
      submitLabel="Capitalize"
      canSubmit={Number(form.amount) > 0 && /^\d{4}-\d{2}-\d{2}$/.test(form.entryDate)}
      onSubmit={async () => {
        const r = await submitter.submit(form)
        if (!r.ok) return r.error
        onDone(); return null
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="capex-amount" label="Amount"><Input id="capex-amount" inputMode="decimal" className="text-right tabular-nums" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} placeholder="0.00" /></Field>
        <Field id="capex-date" label="Date"><Input id="capex-date" type="date" value={form.entryDate} onChange={e => setForm(f => ({ ...f, entryDate: e.target.value }))} /></Field>
      </div>
      <Field id="capex-memo" label="Description"><Input id="capex-memo" value={form.memo} onChange={e => setForm(f => ({ ...f, memo: e.target.value }))} placeholder="e.g. Rack installation" /></Field>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={form.invoiced} onChange={e => setForm(f => ({ ...f, invoiced: e.target.checked }))} />
        Invoiced, not yet paid
      </label>
    </FormDialog>
  )
})

// ── Datacenter contracts ──────────────────────────────────────────────────────────────────────

export function ContractDialog(p: Common & { canSchedule: boolean }) {
  // Outlives the dialog: a contract saved without its schedule says so after the dialog closes.
  const [scheduleNote, setScheduleNote] = useState<string | null>(null)
  return (
    <>
      <ContractDialogBody {...p} onScheduleNote={setScheduleNote} />
      {scheduleNote && !p.open && (
        <div className="mt-2"><ErrorAlert>The contract was saved, but its schedule was not: {scheduleNote}</ErrorAlert></div>
      )}
    </>
  )
}

const ContractDialogBody = whileOpen(function ContractDialogForm({ open, onOpenChange, fetcher, onDone, canSchedule, onScheduleNote }: Common & {
  canSchedule: boolean
  onScheduleNote: (note: string | null) => void
}) {
  const [form, setForm] = useState<ContractForm>(EMPTY_CONTRACT_FORM)
  const set = (k: keyof ContractForm) => (e: { target: { value: string } }) => setForm(f => ({ ...f, [k]: e.target.value }))
  return (
      <FormDialog
        open={open} onOpenChange={onOpenChange}
        title="Add datacenter contract"
        description={canSchedule
          ? 'Saves the contract and its monthly accrual schedule through today; the close proposes each month.'
          : 'Saves the contract only. Its accrual schedule books to the ledger, which needs write access to Accounting; someone with it can roll the schedule from the contract list.'}
        submitLabel="Add contract"
        canSubmit={!!form.facility.trim() && /^\d{4}-\d{2}-\d{2}$/.test(form.start_date) && form.monthly_fee.trim() !== ''}
        onSubmit={async () => {
          const r = await send<{ scheduleError?: { error: string } }>(fetcher, fleetPaths.contracts, 'POST', contractBody(form, canSchedule))
          if (!r.ok) return r.error
          // Saved, but the schedule was refused: the route says why, and Roll retries it.
          onScheduleNote(r.data?.scheduleError?.error ?? null)
          onDone(); return null
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="dc-facility" label="Facility" className="sm:col-span-2"><Input id="dc-facility" value={form.facility} onChange={set('facility')} /></Field>
          <Field id="dc-start" label="Start"><Input id="dc-start" type="date" value={form.start_date} onChange={set('start_date')} /></Field>
          <Field id="dc-end" label="End" hint="Blank for open-ended."><Input id="dc-end" type="date" value={form.end_date} onChange={set('end_date')} /></Field>
          <Field id="dc-fee" label="Monthly fee"><Input id="dc-fee" inputMode="decimal" className="text-right tabular-nums" value={form.monthly_fee} onChange={set('monthly_fee')} /></Field>
          <Field id="dc-escalator" label="Escalator %"><Input id="dc-escalator" inputMode="decimal" className="text-right tabular-nums" value={form.escalator_pct} onChange={set('escalator_pct')} placeholder="0" /></Field>
          <Field id="dc-escalates" label="Escalates on">
            <select id="dc-escalates" className={selectCls} value={form.escalates_on} onChange={set('escalates_on')}>
              <option value="anniversary">Anniversary</option>
              <option value="calendar_year">Calendar year</option>
            </select>
          </Field>
          <Field id="dc-first-escalation" label="First escalation"><Input id="dc-first-escalation" type="date" value={form.first_escalation_date} onChange={set('first_escalation_date')} /></Field>
          <Field id="dc-power" label="Power (kW)"><Input id="dc-power" inputMode="decimal" className="text-right tabular-nums" value={form.power_kw} onChange={set('power_kw')} /></Field>
          <Field id="dc-deposit" label="Deposit"><Input id="dc-deposit" inputMode="decimal" className="text-right tabular-nums" value={form.deposit} onChange={set('deposit')} /></Field>
        </div>
      </FormDialog>
  )
})

export const EndContractDialog = whileOpen(function EndContractDialogBody({ open, onOpenChange, fetcher, onDone, contract }: Common & { contract: DatacenterContractRow | null }) {
  const [endDate, setEndDate] = useState(() => contract?.end_date ?? todayIso())
  if (!contract) return null
  return (
    <FormDialog
      open={open} onOpenChange={onOpenChange}
      title={`End ${contract.facility}`}
      description="Its accrual schedule stops at the end date. An ended contract is not reopened; a new term is a new contract."
      submitLabel="End contract"
      canSubmit={/^\d{4}-\d{2}-\d{2}$/.test(endDate)}
      onSubmit={async () => {
        const r = await send(fetcher, fleetPaths.contract(contract.id), 'PATCH', endContractBody(endDate))
        if (!r.ok) return r.error
        onDone(); return null
      }}
    >
      <Field id="dc-end-date" label="End date"><Input id="dc-end-date" type="date" value={endDate} onChange={e => setEndDate(e.target.value)} /></Field>
    </FormDialog>
  )
})

export const RollDialog = whileOpen(function RollDialogBody({ open, onOpenChange, fetcher, onDone, contract }: Common & { contract: DatacenterContractRow | null }) {
  const [asOf, setAsOf] = useState(todayIso)
  if (!contract) return null
  return (
    <FormDialog
      open={open} onOpenChange={onOpenChange}
      title={`Roll schedules for ${contract.facility}`}
      description="Brings the accrual schedule up to the escalation period containing this date, creating it if it is missing."
      submitLabel="Roll"
      canSubmit={/^\d{4}-\d{2}-\d{2}$/.test(asOf)}
      onSubmit={async () => {
        const r = await send(fetcher, fleetPaths.contract(contract.id), 'POST', rollBody(asOf))
        if (!r.ok) return r.error
        onDone(); return null
      }}
    >
      <Field id="dc-roll-asof" label="As of"><Input id="dc-roll-asof" type="date" value={asOf} onChange={e => setAsOf(e.target.value)} /></Field>
    </FormDialog>
  )
})
