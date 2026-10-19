'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Loader2 } from 'lucide-react'
import { useCanWrite } from '@/components/access-context'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  cashTermsBody, cashTermsFormOf, managerPct, send, termsEditable, waterfallPaths,
  type CashTermsField, type CashTermsForm, type Fetcher, type TermsLoad, type WaterfallTermsReply,
} from './waterfall-api'

// ── GPU fleet (P5) ── Edit a GPU SPV's distributable-cash waterfall: the preferred return (simple, on
// unreturned capital), its day count, how the return of capital and the profit after it are split
// between investors and the manager, and who receives the manager's share. The route
// (gp_economics; the page also asks for accounting write) owns the rules; its refusal is shown in
// its own words.

const selectClass = 'h-9 w-full rounded-md border border-input bg-background px-2 text-sm'

/**
 * The terms card's action. The editor, for a caller with gp_economics write and accounting write,
 * on terms the page has read and may replace (termsEditable); a link to the terms page otherwise;
 * nothing while the read is pending or after it failed (the card shows why).
 */
export function TermsAction({ load, fetcher, onSaved }: { load: TermsLoad; fetcher: Fetcher; onSaved: () => void }) {
  const writesGp = useCanWrite('gp_economics')
  const writesBooks = useCanWrite('accounting')
  const writes = writesGp && writesBooks
  if (load.state !== 'ok') return null
  if (writes && termsEditable(load)) return <WaterfallTermsDialog fetcher={fetcher} waterfall={load.data} onSaved={onSaved} />
  return (
    <Link href="/funds/allocation-terms" className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
      Terms page
    </Link>
  )
}

export function WaterfallTermsDialog({ fetcher, waterfall, onSaved }: {
  fetcher: Fetcher
  waterfall: WaterfallTermsReply | null
  onSaved: () => void
}) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<CashTermsForm>(() => cashTermsFormOf(waterfall?.terms ?? null))
  const [error, setError] = useState<{ text: string; field?: CashTermsField } | null>(null)
  const [saving, setSaving] = useState(false)

  async function save() {
    const req = cashTermsBody(form)
    if (!req.ok) { setError({ text: req.error, field: req.field }); return }
    setSaving(true); setError(null)
    const r = await send(fetcher, waterfallPaths.waterfallTerms, 'PUT', req.body)
    setSaving(false)
    if (!r.ok) { setError({ text: r.error }); return }
    setOpen(false)
    onSaved()
  }

  return (
    <>
      <Button size="sm" variant="outline" data-action="edit-waterfall-terms"
        onClick={() => { setForm(cashTermsFormOf(waterfall?.terms ?? null)); setError(null); setOpen(true) }}>
        Edit terms
      </Button>
      <Dialog open={open} onOpenChange={o => { if (!o && !saving) setOpen(false) }}>
        <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Waterfall terms</DialogTitle>
            <DialogDescription>
              Distributable cash: the preferred return on unreturned capital, then capital back, then the profit split.
            </DialogDescription>
          </DialogHeader>
          <CashTermsEditor form={form} onChange={setForm} candidates={waterfall?.candidates ?? []} error={error} />
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
export function CashTermsEditor({ form, onChange, candidates, error }: {
  form: CashTermsForm
  onChange: (f: CashTermsForm) => void
  candidates: WaterfallTermsReply['candidates']
  error: { text: string; field?: CashTermsField } | null
}) {
  const set = <K extends keyof CashTermsForm>(k: K, v: CashTermsForm[K]) => onChange({ ...form, [k]: v })
  const invalid = (f: CashTermsField) => (error?.field === f ? { 'aria-invalid': true, 'aria-describedby': 'wt-error' } : {})
  const managerBefore = managerPct(form.investorsBeforePct)
  const managerAfter = managerPct(form.investorsAfterPct)

  // Ticking a recipient re-splits evenly (the last takes the remainder), as the carry terms page does.
  const toggle = (id: string) => {
    const ids = form.recipients.some(r => r.lpEntityId === id)
      ? form.recipients.filter(r => r.lpEntityId !== id).map(r => r.lpEntityId)
      : [...form.recipients.map(r => r.lpEntityId), id]
    const each = ids.length ? Math.round(100 / ids.length) : 0
    set('recipients', ids.map((lpEntityId, i) => ({ lpEntityId, pct: String(i === ids.length - 1 ? 100 - each * (ids.length - 1) : each) })))
  }
  const total = form.recipients.reduce((t, r) => t + (Number(r.pct) || 0), 0)

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="wt-pref" className="text-xs">Preferred return rate (%)</Label>
          <Input id="wt-pref" inputMode="decimal" className="text-right tabular-nums" placeholder="8"
            value={form.prefPct} onChange={e => set('prefPct', e.target.value)} {...invalid('prefPct')} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="wt-daycount" className="text-xs">Day count</Label>
          <select id="wt-daycount" className={selectClass} value={form.dayCount} onChange={e => set('dayCount', e.target.value as CashTermsForm['dayCount'])}>
            <option value="30_360">30E/360</option>
            <option value="act_365">ACT/365</option>
          </select>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="wt-before" className="text-xs">Before capital is returned</Label>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Investors</span>
          <Input id="wt-before" inputMode="decimal" className="h-8 w-24 text-right tabular-nums"
            value={form.investorsBeforePct} onChange={e => set('investorsBeforePct', e.target.value)} {...invalid('investorsBeforePct')} />
          <span className="text-muted-foreground">% / manager</span>
          <span className="tabular-nums" data-derived="manager-before">{managerBefore == null ? '—' : `${managerBefore}%`}</span>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="wt-after" className="text-xs">After capital is returned</Label>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Investors</span>
          <Input id="wt-after" inputMode="decimal" className="h-8 w-24 text-right tabular-nums" placeholder="70"
            value={form.investorsAfterPct} onChange={e => set('investorsAfterPct', e.target.value)} {...invalid('investorsAfterPct')} />
          <span className="text-muted-foreground">% / manager</span>
          <span className="tabular-nums" data-derived="manager-after">{managerAfter == null ? '—' : `${managerAfter}%`}</span>
        </div>
      </div>

      <fieldset className="space-y-1.5" {...(error?.field === 'recipients' ? { 'aria-describedby': 'wt-error' } : {})}>
        <legend className="text-xs font-medium">Profit-share recipients</legend>
        {candidates.length === 0 && <p className="text-sm text-muted-foreground">No partners in this fund to choose from.</p>}
        {candidates.map(c => {
          const r = form.recipients.find(x => x.lpEntityId === c.lpEntityId)
          return (
            <div key={c.lpEntityId} className="flex items-center gap-2" data-recipient={c.lpEntityId}>
              <label className="flex flex-1 items-center gap-2 text-sm">
                <input type="checkbox" checked={!!r} onChange={() => toggle(c.lpEntityId)} />
                {c.name}{c.partnerClass === 'gp' ? ' (GP)' : ''}
              </label>
              {r && (
                <div className="flex items-center gap-1">
                  <Input aria-label={`${c.name} share (%)`} inputMode="decimal" className="h-8 w-20 text-right tabular-nums"
                    value={r.pct} onChange={e => set('recipients', form.recipients.map(x => x.lpEntityId === c.lpEntityId ? { ...x, pct: e.target.value } : x))} />
                  <span className="text-sm text-muted-foreground">%</span>
                </div>
              )}
            </div>
          )
        })}
        {form.recipients.length > 0 && (
          <p className={`text-sm tabular-nums ${Math.abs(total - 100) > 0.01 ? 'text-warning' : 'text-muted-foreground'}`}>Total: {Number(total.toFixed(6))}%</p>
        )}
      </fieldset>

      {error && <p id="wt-error" role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error.text}</p>}
    </div>
  )
}
