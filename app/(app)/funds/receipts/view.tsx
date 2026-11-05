'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Upload, Receipt, FileText, Paperclip } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { useCurrency, formatCurrencyPrice } from '@/components/currency-context'
import { useLedgerFetch, useVehicle } from '@/components/accounting-vehicle'
import { AccountPicker, type PickerAccount } from '@/components/accounting/account-picker'
import { EntryModal } from '../entry-modal'

interface ReceiptRow {
  id: string
  vehicle_id: string | null
  source: 'email' | 'upload' | 'agent'
  file_name: string
  vendor_name: string | null
  receipt_date: string | null
  amount: number | null
  currency: string | null
  description: string | null
  allocation_basis: string | null
  extraction_status: string
  extraction_notes: string | null
  status: 'unmatched' | 'matched' | 'dismissed'
  journal_entry_id: string | null
  bank_transaction_id: string | null
  created_at: string
}
interface Suggestion { kind: 'entry' | 'bank'; id: string; date: string; amount: number; description: string | null; status: string; score: number; reason: string }
interface Entity { id: string | null; name: string; kind: string | null }

type Filter = 'unmatched' | 'matched' | 'dismissed' | 'all'

const json = (method: string, body: object) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const errOf = async (r: Response, fallback: string) => (await r.json().catch(() => ({}))).error ?? fallback
const smallBtn = 'text-xs border border-input rounded px-2 py-1 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors disabled:opacity-50'

/**
 * An entity's receipts. The quarterly invoices that bill partnership expenses to the funds are their
 * own page (../partnership-expenses).
 *
 * Receipts arrive from the inbound mailbox (a member's email with "Receipt:" in the subject, or to
 * the +receipts address) or are dropped here. Each one is attached to the entry it supports: the
 * suggestions are the entries and undrafted bank transactions on this entity's books with the same
 * amount near the same date. A receipt with no charge on the books yet can draft one.
 */
export function ReceiptsView() {
  return <ReceiptsList />
}

// ── Receipts ────────────────────────────────────────────────────────────────────────────────

function ReceiptsList() {
  const lf = useLedgerFetch()
  const { group, vehicleId } = useVehicle()
  const currency = useCurrency()
  const fmt = (v: number) => formatCurrencyPrice(v, currency)
  const [filter, setFilter] = useState<Filter>('unmatched')
  const [receipts, setReceipts] = useState<ReceiptRow[]>([])
  const [suggestions, setSuggestions] = useState<Record<string, Suggestion[]>>({})
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [drafting, setDrafting] = useState<string | null>(null)
  const [openEntry, setOpenEntry] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    if (!group) return
    setLoading(true)
    const r = await lf(`/api/accounting/receipts?status=${filter}`)
    const j = r.ok ? await r.json() : { receipts: [], suggestions: {} }
    if (!r.ok) setError(j.error ?? 'Could not load receipts.')
    setReceipts(Array.isArray(j.receipts) ? j.receipts : [])
    setSuggestions(j.suggestions ?? {})
    setLoading(false)
  }, [lf, filter, group])
  useEffect(() => { void load() }, [load])

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return
    setBusy('upload'); setError(null)
    for (const f of Array.from(files)) {
      const form = new FormData()
      form.set('file', f)
      const r = await lf('/api/accounting/receipts', { method: 'POST', body: form })
      if (!r.ok) { setError(await errOf(r, `Could not add ${f.name}`)); break }
    }
    if (fileRef.current) fileRef.current.value = ''
    setBusy(null)
    await load()
  }

  async function act(id: string, body: object, fallback: string) {
    setBusy(id); setError(null)
    const r = await lf(`/api/accounting/receipts/${id}`, json('PATCH', body))
    if (!r.ok) setError(await errOf(r, fallback))
    setBusy(null)
    await load()
    return r.ok
  }

  /** Draft an entry from a receipt. Returns the route's refusal, for the form to show beside its fields. */
  async function draft(id: string, body: object): Promise<string | null> {
    setBusy(id); setError(null)
    try {
      const r = await lf(`/api/accounting/receipts/${id}`, json('PATCH', { action: 'draft', ...body }))
      const failed = r.ok ? null : await errOf(r, 'Could not draft the entry')
      if (!failed) await load()
      return failed
    } finally {
      setBusy(null)
    }
  }

  async function remove(id: string) {
    if (!window.confirm('Delete this receipt and its file?')) return
    setBusy(id); setError(null)
    const r = await lf(`/api/accounting/receipts/${id}`, { method: 'DELETE' })
    if (!r.ok) setError(await errOf(r, 'Could not delete the receipt'))
    setBusy(null)
    await load()
  }

  const filters: { key: Filter; label: string }[] = [
    { key: 'unmatched', label: 'To match' }, { key: 'matched', label: 'Attached' }, { key: 'dismissed', label: 'Dismissed' }, { key: 'all', label: 'All' },
  ]

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex rounded-md border border-input text-xs">
          {filters.map((f, i) => (
            <button key={f.key} onClick={() => setFilter(f.key)} className={`h-8 px-3 ${i > 0 ? 'border-l border-input' : ''} ${filter === f.key ? 'bg-muted font-medium' : 'text-muted-foreground hover:text-foreground'}`}>{f.label}</button>
          ))}
        </div>
        <label className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-input px-3 h-8 text-xs hover:bg-accent ${busy === 'upload' ? 'pointer-events-none opacity-60' : ''}`}>
          {busy === 'upload' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
          Upload receipts
          <input ref={fileRef} type="file" accept="application/pdf,image/*" multiple className="hidden" onChange={e => void upload(e.target.files)} />
        </label>
      </div>
      <p className="text-xs text-muted-foreground">
        Email a receipt to the fund’s inbound address with “Receipt:” at the start of the subject (or send it to the address with +receipts before the @). It is read, filed here, and attached to its bank charge when the match is clear.
      </p>
      {error && <p className="text-sm text-destructive">{error}</p>}

      {loading ? (
        <div className="flex justify-center py-8"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
      ) : receipts.length === 0 ? (
        <EmptyState icon={Receipt}>{filter === 'unmatched' ? 'No receipts waiting to be matched.' : 'No receipts here.'}</EmptyState>
      ) : (
        <ul className="divide-y rounded-card border">
          {receipts.map(r => {
            const sugg = suggestions[r.id] ?? []
            const unfiled = !r.vehicle_id
            const rCurrency = foreignCurrency(r.currency, currency)
            return (
              <li key={r.id} className="space-y-2 p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <a href={`/api/accounting/receipts/${r.id}?redirect=1`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-sm font-medium underline-offset-2 hover:underline">
                      <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{r.vendor_name || r.file_name}</span>
                    </a>
                    <p className="text-xs text-muted-foreground">
                      {[r.receipt_date, r.description, r.source === 'email' ? 'emailed in' : r.source === 'agent' ? 'from an assistant' : 'uploaded'].filter(Boolean).join(' · ')}
                      {r.extraction_status === 'pending' && ' · not read yet'}
                      {r.extraction_status === 'failed' && ' · could not be read, fill in the total'}
                      {r.extraction_notes && ` · ${r.extraction_notes}`}
                    </p>
                    {r.allocation_basis && <p className="text-xs text-muted-foreground">Allocation basis: {r.allocation_basis}</p>}
                    {unfiled && <p className="text-sm text-warning">Not filed under an entity yet.</p>}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="text-sm tabular-nums">{r.amount == null ? '—' : rCurrency ? `${rCurrency} ${Number(r.amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : fmt(Number(r.amount))}</span>
                    {busy === r.id && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
                  </div>
                </div>

                {editing === r.id ? (
                  <ReceiptFieldsForm r={r} onCancel={() => setEditing(null)} onSave={async patch => { if (await act(r.id, { action: 'update', ...patch }, 'Could not save')) setEditing(null) }} />
                ) : drafting === r.id ? (
                  <DraftForm r={r} onCancel={() => setDrafting(null)} onDraft={async body => {
                    const failed = await draft(r.id, body)
                    if (!failed) setDrafting(null)
                    return failed
                  }} />
                ) : (
                  <>
                    {r.status === 'matched' && (
                      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Paperclip className="h-3.5 w-3.5" />
                        {r.journal_entry_id
                          ? <>Attached to <button className="underline underline-offset-2" onClick={() => setOpenEntry(r.journal_entry_id)}>entry {r.journal_entry_id.slice(0, 8)}</button></>
                          : 'Attached to a bank transaction; it moves onto the entry when the transaction is drafted.'}
                      </p>
                    )}
                    {r.status === 'unmatched' && !unfiled && r.amount == null && (
                      <p className="text-xs text-muted-foreground">Fill in the total to see matching charges.</p>
                    )}
                    {r.status === 'unmatched' && sugg.length > 0 && (
                      <div className="space-y-1">
                        <p className="text-xs text-muted-foreground">Likely matches</p>
                        {sugg.map(s => (
                          <div key={`${s.kind}:${s.id}`} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/50 px-2 py-1 text-xs">
                            <span className="min-w-0 truncate">
                              <span className="tabular-nums">{s.date}</span> · {s.kind === 'entry' ? `entry (${s.status})` : 'bank, not drafted'} · {s.description || '—'}
                              <span className="ml-1 text-muted-foreground">({s.reason})</span>
                            </span>
                            <span className="flex items-center gap-2">
                              <span className="tabular-nums">{fmt(s.amount)}</span>
                              <button className={smallBtn} disabled={!!busy} onClick={() => void act(r.id, s.kind === 'entry' ? { action: 'attach', journalEntryId: s.id } : { action: 'attach', bankTransactionId: s.id }, 'Could not attach')}>Attach</button>
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="flex flex-wrap gap-1.5">
                      {unfiled && group && <button className={smallBtn} disabled={!!busy} onClick={() => void act(r.id, { action: 'update', group }, 'Could not file it')}>File under {group}</button>}
                      <button className={smallBtn} disabled={!!busy} onClick={() => setEditing(r.id)}>Edit details</button>
                      {r.status === 'unmatched' && !unfiled && <button className={smallBtn} disabled={!!busy || r.amount == null} onClick={() => setDrafting(r.id)} title="For a charge that is not on the books yet">Draft an entry</button>}
                      {r.status === 'matched' && <button className={smallBtn} disabled={!!busy} onClick={() => void act(r.id, { action: 'detach' }, 'Could not detach')}>Detach</button>}
                      {r.status !== 'dismissed'
                        ? <button className={smallBtn} disabled={!!busy} onClick={() => void act(r.id, { action: 'dismiss' }, 'Could not dismiss')} title="Not a receipt for these books">Dismiss</button>
                        : <button className={smallBtn} disabled={!!busy} onClick={() => void act(r.id, { action: 'restore' }, 'Could not restore')}>Restore</button>}
                      <button className={`${smallBtn} hover:text-destructive`} disabled={!!busy} onClick={() => void remove(r.id)}>Delete</button>
                    </div>
                  </>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {vehicleId === null && group && <p className="text-xs text-muted-foreground">This entity has no registry id; receipts need one.</p>}
      {openEntry && (
        <EntryModal entryId={openEntry} readOnly onClose={() => setOpenEntry(null)} onSaved={() => void load()} />
      )}
    </div>
  )
}

function ReceiptFieldsForm({ r, onSave, onCancel }: { r: ReceiptRow; onSave: (p: object) => void; onCancel: () => void }) {
  const [vendorName, setVendor] = useState(r.vendor_name ?? '')
  const [receiptDate, setDate] = useState(r.receipt_date ?? '')
  const [amount, setAmount] = useState(r.amount != null ? String(r.amount) : '')
  const [description, setDescription] = useState(r.description ?? '')
  const [allocationBasis, setAllocationBasis] = useState(r.allocation_basis ?? '')
  const input = 'mt-0.5 block w-full rounded border border-input bg-transparent px-2 py-1 text-sm'
  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="w-44 text-xs text-muted-foreground">Vendor<input value={vendorName} onChange={e => setVendor(e.target.value)} className={input} /></label>
      <label className="text-xs text-muted-foreground">Date<input type="date" value={receiptDate} onChange={e => setDate(e.target.value)} className={input} /></label>
      <label className="w-28 text-xs text-muted-foreground">Total<input inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} className={`${input} text-right tabular-nums`} /></label>
      <label className="min-w-[160px] flex-1 text-xs text-muted-foreground">What for<input value={description} onChange={e => setDescription(e.target.value)} className={input} /></label>
      <label className="min-w-[200px] flex-1 text-xs text-muted-foreground" title="For a partnership expense: why the fund bears it. Printed on the fund’s invoice.">Allocation basis<input value={allocationBasis} onChange={e => setAllocationBasis(e.target.value)} placeholder="e.g. 100% Fund I: annual audit" className={input} /></label>
      <Button size="sm" variant="outline" onClick={onCancel}>Cancel</Button>
      <Button size="sm" onClick={() => onSave({ vendorName, receiptDate: receiptDate || null, amount: amount || null, description, allocationBasis })}>Save</Button>
    </div>
  )
}

/** The receipt's currency when it is not the books' (the fund's), or null. */
export function foreignCurrency(receiptCurrency: string | null, booksCurrency: string): string | null {
  const c = receiptCurrency?.trim().toUpperCase() || null
  return c && c !== booksCurrency.toUpperCase() ? c : null
}

/**
 * The typed total in the books' currency as a number, or null until it is a whole amount of at
 * least a cent. A comma is read only as a thousands separator in its grouping positions, and at
 * most two decimals are accepted: "108,50" or "1.234,50" (a decimal comma) is refused rather than
 * read as 10850 or 1.2345, and "108.505" rather than left for the server to round. The route and
 * draftEntryFromReceipt refuse a bad amount too; this keeps the button from offering one.
 */
export function parseReportingAmount(text: string): number | null {
  const t = text.trim()
  if (!/^(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/.test(t)) return null
  const n = Number(t.replace(/,/g, ''))
  return Math.round(n * 100) >= 1 ? n : null
}

export const DRAFT_CONNECTION_ERROR = 'Could not draft the entry. Check your connection and try again.'

/**
 * Submit a draft and return the refusal to show, or null. A dropped connection REJECTS rather than
 * returning a response; caught here, so the form always gets a message and its controls back.
 */
export async function runDraft(onDraft: (b: object) => Promise<string | null>, body: object): Promise<string | null> {
  try {
    return await onDraft(body)
  } catch {
    return DRAFT_CONNECTION_ERROR
  }
}

/** Whether the draft form has everything the route needs. */
export function canDraft(f: { debit: string; credit: string; billTo: string; foreign: string | null; reportingAmount: number | null }): boolean {
  return !!(f.debit || f.billTo) && !!f.credit && (!f.foreign || f.reportingAmount != null)
}

/** The draft request body: billed to a fund or debited to an account, with the books-currency total for a foreign receipt. */
export function draftBody(f: {
  debit: string; credit: string; billTo: string; foreign: string | null; reportingAmount: number | null
  /** With billTo: why the fund bears it (upstream #169), and whether to remember it for the vendor. */
  allocationBasis?: string; remember?: boolean
}): object {
  const allocation = f.billTo && f.allocationBasis !== undefined
    ? { allocationBasis: f.allocationBasis, rememberAllocation: !!f.remember && !!f.allocationBasis.trim() }
    : {}
  const base = f.billTo ? { creditAccountId: f.credit, billToVehicleId: f.billTo, ...allocation } : { debitAccountId: f.debit, creditAccountId: f.credit }
  return f.foreign ? { ...base, reportingAmount: f.reportingAmount } : base
}

export function DraftForm({ r, onDraft, onCancel }: { r: ReceiptRow; onDraft: (b: object) => Promise<string | null>; onCancel: () => void }) {
  const lf = useLedgerFetch()
  const { vehicleId } = useVehicle()
  const books = useCurrency()
  // A receipt in another currency is booked at its total in the fund's: the ledger is single-currency
  // and nothing converts. Ask for that total rather than drafting the receipt's own figure.
  const foreign = foreignCurrency(r.currency, books)
  const [reporting, setReporting] = useState('')
  const reportingAmount = parseReportingAmount(reporting)
  const [failed, setFailed] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [accounts, setAccounts] = useState<PickerAccount[]>([])
  const [entities, setEntities] = useState<Entity[]>([])
  const [debit, setDebit] = useState('')
  const [credit, setCredit] = useState('')
  const [billTo, setBillTo] = useState('')
  const [allocationBasis, setAllocationBasis] = useState(r.allocation_basis ?? '')
  const [remember, setRemember] = useState(false)
  useEffect(() => {
    lf('/api/accounting/chart').then(res => (res.ok ? res.json() : [])).then((chart: any[]) => {
      const list = (Array.isArray(chart) ? chart : []).filter(a => a.is_active !== false)
        .map(a => ({ id: a.id, code: a.code, name: a.name, type: a.type, lpEntityId: a.lp_entity_id }))
      setAccounts(list)
      const cash = list.find(a => a.code === '1000')
      if (cash) setCredit(cash.id)
    }).catch(() => {})
    lf('/api/accounting/partnership-invoices').then(res => (res.ok ? res.json() : null)).then(j => {
      if (j?.counterparties) setEntities(j.counterparties)
    }).catch(() => {})
  }, [lf])
  return (
    <div className="space-y-2 rounded-md bg-muted/40 p-2">
      <p className="text-xs text-muted-foreground">A draft for {r.receipt_date ?? 'today'}, {r.vendor_name ?? 'no vendor'}. Nothing posts until you post it from the journal.</p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-muted-foreground">Paid for
          <select value={billTo} onChange={e => setBillTo(e.target.value)} className="mt-0.5 block rounded border border-input bg-transparent px-2 py-1 text-sm" title="A partnership expense: debit that fund's Due-from account so it goes on its quarterly invoice">
            <option value="">This entity (its own expense)</option>
            {entities.filter(e => e.id && e.id !== vehicleId).map(e => <option key={e.id!} value={e.id!}>{e.name} (partnership expense)</option>)}
          </select>
        </label>
        {billTo
          ? <span className="w-56 pb-1.5 text-xs text-muted-foreground">Debit: Due from {entities.find(e => e.id === billTo)?.name ?? 'the fund'}</span>
          : <label className="w-56 text-xs text-muted-foreground">Debit (the cost)<AccountPicker accounts={accounts.filter(a => a.type === 'expense' || a.type === 'asset')} value={debit} onChange={setDebit} /></label>}
        <label className="w-56 text-xs text-muted-foreground">Credit (what paid it)<AccountPicker accounts={accounts.filter(a => a.type === 'asset' || a.type === 'liability')} value={credit} onChange={setCredit} /></label>
        {foreign && (
          <label className="w-36 text-xs text-muted-foreground" title={`The receipt says ${foreign} ${Number(r.amount ?? 0).toFixed(2)}. The books are kept in ${books}.`}>
            Total in {books}
            <input
              required inputMode="decimal" value={reporting} onChange={e => setReporting(e.target.value)}
              aria-invalid={reporting !== '' && reportingAmount == null}
              placeholder={`${foreign} ${Number(r.amount ?? 0).toFixed(2)}`}
              className="mt-0.5 block w-full rounded-md border border-input bg-transparent px-2 py-1 text-right text-sm tabular-nums"
            />
            {/* The amount as it will be booked, so a misread entry is visible before it is drafted. */}
            {reportingAmount != null && <span className="mt-0.5 block text-right tabular-nums">= {books} {reportingAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>}
          </label>
        )}
        <Button size="sm" variant="outline" onClick={onCancel}>Cancel</Button>
        <Button
          size="sm"
          disabled={submitting || !canDraft({ debit, credit, billTo, foreign, reportingAmount })}
          onClick={async () => {
            setSubmitting(true); setFailed(null)
            // The form's fields, the typed total included, are left as they are on a failure.
            try {
              setFailed(await runDraft(onDraft, draftBody({ debit, credit, billTo, foreign, reportingAmount, allocationBasis, remember })))
            } finally {
              setSubmitting(false)
            }
          }}
        >Draft entry</Button>
      </div>
      {failed && <p role="alert" className="text-sm text-destructive">{failed}</p>}
      {billTo && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-[240px] flex-1 text-xs text-muted-foreground" title="Why the fund bears this expense. Printed on its partnership invoice.">Allocation basis
            <input value={allocationBasis} onChange={e => setAllocationBasis(e.target.value)} placeholder="e.g. 100% Fund I: annual audit" className="mt-0.5 block w-full rounded border border-input bg-transparent px-2 py-1 text-sm" />
          </label>
          {r.vendor_name && (
            <label className="flex items-center gap-1.5 pb-1.5 text-xs text-muted-foreground">
              <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} disabled={!allocationBasis.trim()} />
              Use for future {r.vendor_name} expenses for {entities.find(e => e.id === billTo)?.name ?? 'this fund'}
            </label>
          )}
        </div>
      )}
    </div>
  )
}
