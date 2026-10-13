'use client'

import { useCallback, useEffect, useState } from 'react'
import { Loader2, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useLedgerFetch } from '@/components/accounting-vehicle'

/**
 * Bank details printed on this vehicle's capital call notices.
 *
 * Per vehicle, not per call: an SPV's account is a standing fact, and re-typing it into every
 * call is how one notice goes out with a stale account number. A notice generated without
 * these still renders — it says payment instructions will follow separately, rather than
 * looking complete while telling nobody where to send the money.
 */
export function WireInstructionsCard() {
  const lf = useLedgerFetch()
  const [value, setValue] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    lf('/api/accounting/vehicle-settings')
      .then(r => (r.ok ? r.json() : { wireInstructions: '' }))
      .then(d => setValue(d.wireInstructions ?? ''))
      .finally(() => setLoading(false))
  }, [lf])
  useEffect(() => { load() }, [load])

  async function save() {
    setSaving(true); setErr(null); setSaved(false)
    const res = await lf('/api/accounting/vehicle-settings', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wireInstructions: value }),
    })
    setSaving(false)
    if (!res.ok) { setErr((await res.json().catch(() => ({}))).error ?? 'Could not save'); return }
    setSaved(true)
  }

  if (loading) {
    return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading…</div>
  }

  return (
    <div className="space-y-2">
      <textarea
        value={value}
        onChange={e => { setValue(e.target.value); setSaved(false) }}
        rows={6}
        placeholder={'Bank name\nAccount name\nAccount number / IBAN\nRouting / SWIFT\nReference'}
        className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm font-mono"
      />
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={save} disabled={saving}>
          {saving && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}Save
        </Button>
        {saved && <span className="flex items-center gap-1 text-xs text-success"><Check className="h-3.5 w-3.5" />Saved</span>}
        {err && <span className="text-sm text-warning">{err}</span>}
        <span className="text-xs text-muted-foreground">Printed verbatim on capital call notices for this vehicle.</span>
      </div>
    </div>
  )
}

/**
 * The LPA's capital call notice period for this vehicle. Every drafted notice checks its dates
 * against it (lib/accounting/call-notice-check.ts). An LPA term, so only an admin changes it.
 */
export function CallNoticePeriodField({ isAdmin }: { isAdmin: boolean }) {
  const lf = useLedgerFetch()
  const [days, setDays] = useState('')
  const [basis, setBasis] = useState<'calendar' | 'business'>('calendar')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    lf('/api/accounting/vehicle-settings')
      .then(r => (r.ok ? r.json() : {}))
      .then((d: { callNoticeDays?: number | null; callNoticeBasis?: string | null }) => {
        setDays(d.callNoticeDays == null ? '' : String(d.callNoticeDays))
        setBasis(d.callNoticeBasis === 'business' ? 'business' : 'calendar')
      })
      .catch(() => {})
  }, [lf])

  async function save() {
    setSaving(true); setErr(null); setSaved(false)
    const n = days.trim() === '' ? null : Number(days)
    const res = await lf('/api/accounting/vehicle-settings', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callNoticeDays: n, callNoticeBasis: basis }),
    })
    setSaving(false)
    if (!res.ok) { setErr((await res.json().catch(() => ({}))).error ?? 'Could not save'); return }
    setSaved(true)
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span>LPA notice period</span>
      <input
        type="number" min={0} max={365} value={days} disabled={!isAdmin}
        onChange={e => { setDays(e.target.value); setSaved(false) }}
        className="w-20 rounded-md border border-input bg-transparent px-2 py-1 text-sm tabular-nums"
        aria-label="Notice period in days"
      />
      <select
        value={basis} disabled={!isAdmin}
        onChange={e => { setBasis(e.target.value === 'business' ? 'business' : 'calendar'); setSaved(false) }}
        className="rounded-md border border-input bg-transparent px-2 py-1 text-sm"
      >
        <option value="calendar">calendar days</option>
        <option value="business">business days</option>
      </select>
      {isAdmin && (
        <Button size="sm" variant="outline" onClick={save} disabled={saving}>
          {saving && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}Save
        </Button>
      )}
      {saved && <span className="flex items-center gap-1 text-xs text-success"><Check className="h-3.5 w-3.5" />Saved</span>}
      {err && <span className="text-sm text-warning">{err}</span>}
      <span className="text-xs text-muted-foreground">Drafted capital call notices flag any date inside it.{!isAdmin && ' An admin sets it.'}</span>
    </div>
  )
}
