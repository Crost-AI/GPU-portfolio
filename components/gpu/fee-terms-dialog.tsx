'use client'

import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { feeFormOf, feeTermsBody, send, waterfallPaths, type FeeForm, type FeeTermsReply, type Fetcher } from './waterfall-api'

// ── GPU fleet (P5) ── Edit the management fee: a share of gross rental revenue, accrued by the close
// monthly or quarterly, booked to a management company intercompany or to Due to manager (2100).
// The route (accounting write; a payee also needs management_company write) owns the rules; its
// refusal is shown in its own words.

const selectClass = 'h-9 w-full rounded-md border border-input bg-background px-2 text-sm'

export function FeeTermsDialog({ fetcher, terms, mancos, onSaved }: {
  fetcher: Fetcher
  terms: FeeTermsReply['terms']
  /** The fund's management companies, the only payees the route accepts. */
  mancos: { id: string; name: string }[]
  onSaved: () => void
}) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<FeeForm>(() => feeFormOf(terms))
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function save() {
    const req = feeTermsBody(form)
    if (!req.ok) { setError(req.error); return }
    setSaving(true); setError(null)
    const r = await send(fetcher, waterfallPaths.feeTerms, 'PUT', req.body)
    setSaving(false)
    if (!r.ok) { setError(r.error); return }
    setOpen(false)
    onSaved()
  }

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => { setForm(feeFormOf(terms)); setError(null); setOpen(true) }}>Edit fee terms</Button>
      <Dialog open={open} onOpenChange={o => { if (!o && !saving) setOpen(false) }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Management fee</DialogTitle>
            <DialogDescription>A share of each month&rsquo;s gross rental revenue, accrued by the close.</DialogDescription>
          </DialogHeader>
          <FeeTermsForm form={form} onChange={setForm} mancos={mancos} error={error} />
          <DialogFooter>
            <Button type="button" onClick={save} disabled={saving}>
              {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

/** The fields, from props. Rendered statically by the tests. */
export function FeeTermsForm({ form, onChange, mancos, error }: {
  form: FeeForm
  onChange: (f: FeeForm) => void
  mancos: { id: string; name: string }[]
  error: string | null
}) {
  const set = <K extends keyof FeeForm>(k: K, v: FeeForm[K]) => onChange({ ...form, [k]: v })
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-xs">Basis</Label>
          <p className="flex h-9 items-center text-sm">Gross rental revenue</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="fee-rate" className="text-xs">Rate (% of revenue)</Label>
          <Input id="fee-rate" inputMode="decimal" className="text-right tabular-nums" value={form.ratePct} onChange={e => set('ratePct', e.target.value)} placeholder="5" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="fee-frequency" className="text-xs">Accrued</Label>
          <select id="fee-frequency" className={selectClass} value={form.frequency} onChange={e => set('frequency', e.target.value as FeeForm['frequency'])}>
            <option value="monthly">Monthly</option>
            <option value="quarterly">Quarterly</option>
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="fee-payee" className="text-xs">Paid to</Label>
          <select id="fee-payee" className={selectClass} value={form.payeeVehicleId} onChange={e => set('payeeVehicleId', e.target.value)}>
            <option value="">Due to manager (2100)</option>
            {mancos.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="fee-from" className="text-xs">In force from</Label>
          <Input id="fee-from" type="date" value={form.effectiveFrom} onChange={e => set('effectiveFrom', e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="fee-to" className="text-xs">Until (optional)</Label>
          <Input id="fee-to" type="date" value={form.effectiveTo} onChange={e => set('effectiveTo', e.target.value)} />
        </div>
      </div>
      {error && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
    </div>
  )
}
