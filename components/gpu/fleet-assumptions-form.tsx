'use client'

import { useState } from 'react'
import { Loader2, Plus, Trash2 } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { CADENCE_LABELS, type FleetAssumptions } from '@/lib/gpu/scenario'
import { ErrorAlert, Field, selectCls } from './fleet-ui'
import { blankFleet, fromFleetForm, toFleetForm, type AssetRowForm, type FleetForm, type TypeRowForm } from './fleet-assumptions'
import { ShellSection } from './parts'

// ── GPU fleet (P5) ── The Forecast page's Fleet tab on a GPU SPV: the plan's fleet assumptions, which
// the scenario engine runs (lib/gpu/scenario.ts) and the Scenarios page compares. Saving replaces
// them whole and recompiles the plan, as any other plan edit does. The parent mounts this once per
// plan revision (its key), so a reload after a save, or after a stale-revision 409, starts it afresh.

const EMPTY_ASSET: AssetRowForm = { typeCode: '', servers: '1', gpusPerServer: '8', hardwareCost: '', capitalizedCosts: '' }
const EMPTY_TYPE: TypeRowForm = { code: '', anchorRate: '', priceChanges: '', utilization: '' }

const num = 'text-right tabular-nums'

export function FleetAssumptionsForm({ fleet, canEdit, onSave }: {
  fleet: FleetAssumptions | null
  canEdit: boolean
  /** Saves the assumptions; resolves to the route's error text, or null once saved. */
  onSave: (fleet: FleetAssumptions) => Promise<string | null>
}) {
  const [form, setForm] = useState<FleetForm>(() => toFleetForm(fleet ?? blankFleet()))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const set = <K extends keyof FleetForm>(k: K, v: FleetForm[K]) => { setForm(f => ({ ...f, [k]: v })); setSaved(false) }
  const field = (k: keyof FleetForm) => ({
    value: String(form[k]),
    onChange: (e: { target: { value: string } }) => set(k, e.target.value as never),
    disabled: !canEdit,
  })
  const setAsset = (i: number, patch: Partial<AssetRowForm>) => set('assets', form.assets.map((a, k) => (k === i ? { ...a, ...patch } : a)))
  const setType = (i: number, patch: Partial<TypeRowForm>) => set('types', form.types.map((t, k) => (k === i ? { ...t, ...patch } : t)))

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const parsed = fromFleetForm(form)
    if ('error' in parsed) { setError(parsed.error); return }
    setBusy(true); setError(null)
    try {
      const err = await onSave(parsed.fleet)
      if (err) setError(err)
      else setSaved(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="mb-6 space-y-4" aria-label="Fleet assumptions">
      {!fleet && (
        <p className="text-sm text-muted-foreground">
          This plan has no fleet assumptions yet. The form starts from the fleet register and the pack&rsquo;s operating defaults; saving makes it a fleet plan.
        </p>
      )}

      <ShellSection title="Timing" description="Year 1 starts in the start month; the fleet is sold at book on the last day of the sale year.">
        <div className="grid gap-3 sm:grid-cols-4">
          <Field id="fleet-start" label="Start month"><Input id="fleet-start" type="month" {...field('startMonth')} /></Field>
          <Field id="fleet-years" label="Years of price paths"><Input id="fleet-years" inputMode="numeric" className={num} {...field('years')} /></Field>
          <Field id="fleet-sale" label="Sale year"><Input id="fleet-sale" inputMode="numeric" className={num} {...field('saleYear')} /></Field>
          <Field id="fleet-hours" label="Hours per year"><Input id="fleet-hours" inputMode="numeric" className={num} {...field('hoursPerYear')} /></Field>
        </div>
      </ShellSection>

      <ShellSection
        title="Assets"
        description="The servers the scenario runs: the fleet register as it stands, or a planned fleet for a pitch."
        action={
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.fromRegister} disabled={!canEdit} onChange={e => set('fromRegister', e.target.checked)} />
            From the fleet register
          </label>
        }
      >
        {form.fromRegister ? (
          <p className="text-sm text-muted-foreground">The register&rsquo;s assets, as booked, are the fleet.</p>
        ) : (
          <div className="space-y-2">
            {form.assets.map((a, i) => (
              <div key={i} className="grid items-end gap-2 sm:grid-cols-[1fr_6rem_6rem_9rem_9rem_auto]" data-asset-row={i}>
                <Field id={`fleet-asset-type-${i}`} label="GPU type code"><Input id={`fleet-asset-type-${i}`} className="font-mono" value={a.typeCode} disabled={!canEdit} onChange={e => setAsset(i, { typeCode: e.target.value })} /></Field>
                <Field id={`fleet-asset-servers-${i}`} label="Servers"><Input id={`fleet-asset-servers-${i}`} inputMode="numeric" className={num} value={a.servers} disabled={!canEdit} onChange={e => setAsset(i, { servers: e.target.value })} /></Field>
                <Field id={`fleet-asset-gpus-${i}`} label="GPUs each"><Input id={`fleet-asset-gpus-${i}`} inputMode="numeric" className={num} value={a.gpusPerServer} disabled={!canEdit} onChange={e => setAsset(i, { gpusPerServer: e.target.value })} /></Field>
                <Field id={`fleet-asset-cost-${i}`} label="Hardware cost each"><Input id={`fleet-asset-cost-${i}`} inputMode="decimal" className={num} value={a.hardwareCost} disabled={!canEdit} onChange={e => setAsset(i, { hardwareCost: e.target.value })} /></Field>
                <Field id={`fleet-asset-capex-${i}`} label="Capitalized each"><Input id={`fleet-asset-capex-${i}`} inputMode="decimal" className={num} value={a.capitalizedCosts} disabled={!canEdit} onChange={e => setAsset(i, { capitalizedCosts: e.target.value })} /></Field>
                <Button type="button" variant="ghost" size="sm" disabled={!canEdit} aria-label={`Remove asset ${i + 1}`} onClick={() => set('assets', form.assets.filter((_, k) => k !== i))}><Trash2 className="h-4 w-4" /></Button>
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" disabled={!canEdit} onClick={() => set('assets', [...form.assets, EMPTY_ASSET])}><Plus className="mr-1 h-4 w-4" />Add asset</Button>
          </div>
        )}
      </ShellSection>

      <ShellSection
        title="GPU types and prices"
        description="Each type's anchor rate in $ per GPU-hour, and its price change each year in percent (comma separated)."
        action={
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.utilizationPerType} disabled={!canEdit} onChange={e => set('utilizationPerType', e.target.checked)} />
            Utilization per type and year
          </label>
        }
      >
        <div className="space-y-2">
          {form.types.map((t, i) => (
            <div key={i} className="grid items-end gap-2 sm:grid-cols-[9rem_8rem_1fr_1fr_auto]" data-type-row={i}>
              <Field id={`fleet-type-code-${i}`} label="Code"><Input id={`fleet-type-code-${i}`} className="font-mono" value={t.code} disabled={!canEdit} onChange={e => setType(i, { code: e.target.value })} /></Field>
              <Field id={`fleet-type-rate-${i}`} label="Anchor $/GPU-hr"><Input id={`fleet-type-rate-${i}`} inputMode="decimal" className={num} value={t.anchorRate} disabled={!canEdit} onChange={e => setType(i, { anchorRate: e.target.value })} /></Field>
              <Field id={`fleet-type-changes-${i}`} label="Price change by year, %"><Input id={`fleet-type-changes-${i}`} className="tabular-nums" value={t.priceChanges} disabled={!canEdit} onChange={e => setType(i, { priceChanges: e.target.value })} placeholder="-5, -5, -5, -5, -5" /></Field>
              {form.utilizationPerType
                ? <Field id={`fleet-type-util-${i}`} label="Utilization by year, %"><Input id={`fleet-type-util-${i}`} className="tabular-nums" value={t.utilization} disabled={!canEdit} onChange={e => setType(i, { utilization: e.target.value })} placeholder="75, 75, 75, 75, 75" /></Field>
                : <div />}
              <Button type="button" variant="ghost" size="sm" disabled={!canEdit} aria-label={`Remove type ${i + 1}`} onClick={() => set('types', form.types.filter((_, k) => k !== i))}><Trash2 className="h-4 w-4" /></Button>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" disabled={!canEdit} onClick={() => set('types', [...form.types, EMPTY_TYPE])}><Plus className="mr-1 h-4 w-4" />Add GPU type</Button>
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-4">
          {!form.utilizationPerType && (
            <Field id="fleet-util" label="Utilization, %"><Input id="fleet-util" inputMode="decimal" className={num} {...field('utilization')} /></Field>
          )}
          <Field id="fleet-timing" label="Price change timing, %" hint="Share of a year's change in that year's rate; 50 is mid-year.">
            <Input id="fleet-timing" inputMode="decimal" className={num} {...field('priceChangeTiming')} />
          </Field>
        </div>
      </ShellSection>

      <ShellSection title="Costs" description="Datacenter hosting, marketplace processing, insurance and the capex contingency raised with the capital.">
        <div className="grid gap-3 sm:grid-cols-4">
          <Field id="fleet-dc-monthly" label="Datacenter, monthly"><Input id="fleet-dc-monthly" inputMode="decimal" className={num} {...field('dcMonthly')} /></Field>
          <Field id="fleet-dc-escalator" label="Escalator, % a year"><Input id="fleet-dc-escalator" inputMode="decimal" className={num} {...field('dcEscalator')} /></Field>
          <Field id="fleet-dc-first" label="First escalation year"><Input id="fleet-dc-first" inputMode="numeric" className={num} {...field('dcFirstEscalationYear')} /></Field>
          <Field id="fleet-dc-contingency" label="Datacenter contingency, %"><Input id="fleet-dc-contingency" inputMode="decimal" className={num} {...field('dcContingency')} /></Field>
          <Field id="fleet-processing" label="Processing fee, % of revenue"><Input id="fleet-processing" inputMode="decimal" className={num} {...field('processingFee')} /></Field>
          <Field id="fleet-insurance" label="Insurance, % of hardware"><Input id="fleet-insurance" inputMode="decimal" className={num} {...field('insurance')} /></Field>
          <Field id="fleet-capex" label="Capex contingency, %"><Input id="fleet-capex" inputMode="decimal" className={num} {...field('capexContingency')} /></Field>
          <Field id="fleet-capex-spent" label="Contingency spent" hint="Blank: all of it (the pack)."><Input id="fleet-capex-spent" inputMode="decimal" className={num} {...field('capexSpent')} /></Field>
          <Field id="fleet-capex-year" label="Unspent returned in year" hint="Blank: the sale year."><Input id="fleet-capex-year" inputMode="numeric" className={num} {...field('capexReturnYear')} /></Field>
          <Field id="fleet-salvage" label="Salvage, %"><Input id="fleet-salvage" inputMode="decimal" className={num} {...field('salvage')} /></Field>
          <Field id="fleet-life" label="Life, years"><Input id="fleet-life" inputMode="numeric" className={num} {...field('lifeYears')} /></Field>
        </div>
      </ShellSection>

      <ShellSection title="Terms and cadence" description="Fee and waterfall terms come from the vehicle unless overridden here.">
        <div className="grid gap-3 sm:grid-cols-5">
          <Field id="fleet-cadence" label="Distribution cadence">
            <select id="fleet-cadence" className={selectCls} value={form.cadence} disabled={!canEdit} onChange={e => set('cadence', e.target.value as FleetForm['cadence'])}>
              <option value="">The vehicle&rsquo;s</option>
              {(['annual', 'quarterly', 'monthly'] as const).map(c => <option key={c} value={c}>{CADENCE_LABELS[c]}</option>)}
            </select>
          </Field>
          <Field id="fleet-fee" label="Fee rate, %"><Input id="fleet-fee" inputMode="decimal" className={num} placeholder="Vehicle" {...field('feeRate')} /></Field>
          <Field id="fleet-pref" label="Preferred return, %"><Input id="fleet-pref" inputMode="decimal" className={num} placeholder="Vehicle" {...field('prefRate')} /></Field>
          <Field id="fleet-carry" label="Carry, %"><Input id="fleet-carry" inputMode="decimal" className={num} placeholder="Vehicle" {...field('carryRate')} /></Field>
          <Field id="fleet-roc" label="ROC to investors, %"><Input id="fleet-roc" inputMode="decimal" className={num} placeholder="Vehicle" {...field('rocLpShare')} /></Field>
        </div>
      </ShellSection>

      {error && <ErrorAlert>{error}</ErrorAlert>}
      <div className="flex items-center justify-end gap-3">
        {saved && <p className="text-sm text-muted-foreground">Saved. The plan has been recompiled.</p>}
        <Button type="submit" disabled={!canEdit || busy}>
          {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}Save fleet assumptions
        </Button>
      </div>
    </form>
  )
}
