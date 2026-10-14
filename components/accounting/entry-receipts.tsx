'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Paperclip, X, Upload } from 'lucide-react'
import { useLedgerFetch, useVehicle, type VehicleOption } from '@/components/accounting-vehicle'
import { useAppFetch } from '@/components/app-runtime'

interface ReceiptLite {
  id: string
  file_name: string
  vendor_name: string | null
  receipt_date: string | null
  amount: number | null
}

/**
 * The entry modal's evidence block: the receipts attached to this entry, a way to add one, and the
 * partnership-expense tag (bill this cost to another entity on the quarterly invoice).
 *
 * Both save on their own, independently of the entry's lines: attaching a receipt or tagging an
 * entry does not change what it posts, so neither needs the entry unposted to do it.
 */
export function EntryReceipts({
  entryId, rebillVehicleId, rebillAmount, invoiced,
}: {
  entryId: string
  rebillVehicleId: string | null
  rebillAmount: number | null
  /** Already billed on a partnership invoice: the tag is shown, not editable. */
  invoiced: boolean
}) {
  const lf = useLedgerFetch()
  const appFetch = useAppFetch()
  const { vehicleId } = useVehicle()
  const [receipts, setReceipts] = useState<ReceiptLite[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [entities, setEntities] = useState<VehicleOption[]>([])
  const [billTo, setBillTo] = useState<string>(rebillVehicleId ?? '')
  const [amount, setAmount] = useState<string>(rebillAmount != null ? String(rebillAmount) : '')
  const [saved, setSaved] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    const r = await lf(`/api/accounting/receipts?entryId=${entryId}`)
    const j = r.ok ? await r.json() : { receipts: [] }
    setReceipts(Array.isArray(j.receipts) ? j.receipts : [])
    setLoading(false)
  }, [lf, entryId])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    appFetch('/api/accounting/vehicle-index').then(r => (r.ok ? r.json() : [])).then((vs: VehicleOption[]) => {
      if (Array.isArray(vs)) setEntities(vs.filter(v => v.id && v.id !== vehicleId && v.kind !== 'manco'))
    }).catch(() => {})
  }, [appFetch, vehicleId])

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return
    setBusy(true); setError(null)
    for (const f of Array.from(files)) {
      const form = new FormData()
      form.set('file', f)
      form.set('entryId', entryId)
      const r = await lf('/api/accounting/receipts', { method: 'POST', body: form })
      if (!r.ok) { setError((await r.json().catch(() => ({}))).error ?? `Could not add ${f.name}`); break }
    }
    if (fileRef.current) fileRef.current.value = ''
    await load()
    setBusy(false)
  }

  async function detach(id: string) {
    setBusy(true); setError(null)
    const r = await lf(`/api/accounting/receipts/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'detach' }) })
    if (!r.ok) setError((await r.json().catch(() => ({}))).error ?? 'Could not remove the receipt')
    await load()
    setBusy(false)
  }

  async function saveTag(nextBillTo: string, nextAmount: string) {
    setBusy(true); setError(null); setSaved(false)
    const r = await lf('/api/accounting/partnership-expenses', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entryId, rebillVehicleId: nextBillTo || null, rebillAmount: nextBillTo && nextAmount ? Number(nextAmount) : null }),
    })
    if (!r.ok) setError((await r.json().catch(() => ({}))).error ?? 'Could not save the tag')
    else setSaved(true)
    setBusy(false)
  }

  return (
    <div className="space-y-2 rounded-card border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium"><Paperclip className="h-3.5 w-3.5" />Receipts</span>
        <label className={`inline-flex cursor-pointer items-center gap-1 text-xs text-muted-foreground hover:text-foreground ${busy ? 'pointer-events-none opacity-60' : ''}`}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
          Add receipt
          <input ref={fileRef} type="file" accept="application/pdf,image/*" multiple className="hidden" onChange={e => void upload(e.target.files)} />
        </label>
      </div>
      {loading ? null : receipts.length === 0 ? (
        <p className="text-xs text-muted-foreground">None attached. Add one here, or email it to the inbound address with “Receipt:” in the subject.</p>
      ) : (
        <ul className="space-y-1">
          {receipts.map(r => (
            <li key={r.id} className="flex items-center justify-between gap-2 text-xs">
              <a href={`/api/accounting/receipts/${r.id}?redirect=1`} target="_blank" rel="noreferrer" className="truncate underline underline-offset-2">
                {r.vendor_name || r.file_name}
              </a>
              <span className="flex shrink-0 items-center gap-2 text-muted-foreground">
                {r.receipt_date && <span className="tabular-nums">{r.receipt_date}</span>}
                {r.amount != null && <span className="tabular-nums">{Number(r.amount).toFixed(2)}</span>}
                <button onClick={() => void detach(r.id)} disabled={busy} title="Detach from this entry (the receipt goes back to the Receipts page)" className="hover:text-destructive"><X className="h-3.5 w-3.5" /></button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-end gap-2 border-t pt-2">
        <label className="text-xs text-muted-foreground">Partnership expense, bill to
          <select
            value={billTo}
            disabled={busy || invoiced}
            onChange={e => { setBillTo(e.target.value); void saveTag(e.target.value, amount) }}
            className="mt-0.5 block rounded border border-input bg-transparent px-2 py-1 text-sm"
            title="Bill this cost to another entity on its quarterly partnership invoice"
          >
            <option value="">Not billed</option>
            {entities.map(v => <option key={v.id!} value={v.id!}>{v.name}</option>)}
            {billTo && !entities.some(v => v.id === billTo) && <option value={billTo}>Another entity</option>}
          </select>
        </label>
        {billTo && (
          <label className="text-xs text-muted-foreground">Amount to bill
            <input
              inputMode="decimal" value={amount} disabled={busy || invoiced} placeholder="Whole expense"
              onChange={e => setAmount(e.target.value)} onBlur={() => void saveTag(billTo, amount)}
              className="mt-0.5 block w-32 rounded border border-input bg-transparent px-2 py-1 text-right text-sm tabular-nums"
            />
          </label>
        )}
        {invoiced && <span className="pb-1 text-xs text-muted-foreground">Billed on a partnership invoice.</span>}
        {saved && !error && <span className="pb-1 text-xs text-success">Saved</span>}
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  )
}
