'use client'

import { Fragment, useCallback, useEffect, useState } from 'react'
import { Loader2, FileText, ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { EmptyState } from '@/components/ui/empty-state'
import { useCurrency, formatCurrencyPrice } from '@/components/currency-context'
import { useLedgerFetch, useVehicle } from '@/components/accounting-vehicle'
import { EntryModal } from '../entry-modal'
import { EntryReceipts } from '@/components/accounting/entry-receipts'
import { PeriodPicker } from '@/components/accounting/period-picker'
import { resolvePeriod, type PeriodPreset } from '@/lib/accounting/statement-period'

interface Entity { id: string | null; name: string; kind: string | null }
interface ReceivableAccount { id: string; code: string; name: string; counterpartyVehicleId: string | null }

const json = (method: string, body: object) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const smallBtn = 'text-xs border border-input rounded px-2 py-1 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors disabled:opacity-50'

/**
 * The quarterly invoices that bill a fund for the partnership expenses this entity paid for it.
 *
 * Each expense is booked to the entity's "Due from <fund>" account as it is paid; the quarter's
 * invoice bills every posted debit to that account not already invoiced. Which account is a fund's
 * "Due from" is a link on the account (chart_of_accounts.counterparty_vehicle_id), chosen here, so
 * a chart imported with its own names ("Due from Fund III") works without renaming anything.
 */
export function PartnershipExpensesView() {
  return <PartnershipInvoices />
}

interface InvoiceRow { id: string; invoice_number: string; invoice_date: string; period_start: string; period_end: string; amount: number; adjustment_total?: number | null; status: string; from_vehicle_id: string; to_vehicle_id: string; from_name: string | null; to_name: string | null }
interface Line { entryId: string; postingId: string; entryDate: string; memo: string | null; reference: string | null; vendorName: string | null; amount: number; receiptCount: number; status: string; beforePeriod?: boolean; allocationBasis: string | null; allocationSource?: 'receipt' | 'vendor' | null }
interface Adjustment { id: string; description: string; amount: number }
interface Preview { quarter: { year: number; quarter: number; label: string; start: string; end: string }; range: { from: string | null; through: string }; to: { vehicleId: string; name: string }; lines: Line[]; total: number; drafts: Line[]; hasReceivableAccount: boolean; receivableAccount: { id: string; code: string; name: string } | null; existing: { id: string; invoiceNumber: string; status: string } | null }

function PartnershipInvoices() {
  const lf = useLedgerFetch()
  const { group, vehicleId } = useVehicle()
  const currency = useCurrency()
  const fmt = (v: number) => formatCurrencyPrice(v, currency)
  const [loading, setLoading] = useState(true)
  const [invoices, setInvoices] = useState<InvoiceRow[]>([])
  const [unbilled, setUnbilled] = useState<{ vehicleId: string; name: string; entries: number; amount: number }[]>([])
  const [counterparties, setCounterparties] = useState<Entity[]>([])
  const [receivableAccounts, setReceivableAccounts] = useState<ReceivableAccount[]>([])
  const [to, setTo] = useState('')
  const [year, setYear] = useState(new Date().getFullYear())
  const [quarter, setQuarter] = useState(1)
  // Which expenses to read, on the app's shared period picker. The default, a custom window with no
  // start ending on the quarter's last day, is every unbilled expense through the quarter; its end
  // follows the quarter until someone sets a start.
  const [preset, setPreset] = useState<PeriodPreset>('custom')
  const [rangeFrom, setRangeFrom] = useState('')
  const [rangeThrough, setRangeThrough] = useState('')
  const dates = preset === 'custom' ? { start: rangeFrom || null, end: rangeThrough || null } : resolvePeriod(preset)
  const followQuarter = (y: number, q: number) => { if (preset === 'custom' && !rangeFrom) setRangeThrough(quarterEnd(y, q)) }
  const [preview, setPreview] = useState<Preview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [openEntry, setOpenEntry] = useState<string | null>(null)
  // Lines left off the next invoice, by posting id. They stay open for a later one.
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  // Allocation bases typed over the ones the lines came with, and the lines to save for the vendor.
  const [allocations, setAllocations] = useState<Record<string, string>>({})
  const [remember, setRemember] = useState<Set<string>>(new Set())
  // An invoice already created whose allocation bases are being corrected in place.
  const [editing, setEditing] = useState<{ id: string; invoiceNumber: string; status: string; toName: string; lines: Line[]; addable: Line[]; adjustments: Adjustment[] } | null>(null)
  const [editBases, setEditBases] = useState<Record<string, string>>({})
  const [editRemember, setEditRemember] = useState<Set<string>>(new Set())
  const [editRemove, setEditRemove] = useState<Set<string>>(new Set())
  const [editAdd, setEditAdd] = useState<Set<string>>(new Set())
  const [editDesc, setEditDesc] = useState<Record<string, { vendor: string; description: string }>>({})
  // Credits and charges on a draft: ids to take off, and new ones typed (amount as typed, negative for a credit).
  const [editRemoveAdj, setEditRemoveAdj] = useState<Set<string>>(new Set())
  const [editNewAdj, setEditNewAdj] = useState<{ description: string; amount: string }[]>([])
  const [receiptsFor, setReceiptsFor] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!group) return
    setLoading(true)
    const r = await lf('/api/accounting/partnership-invoices')
    const j = r.ok ? await r.json() : null
    if (!r.ok) setError((j as any)?.error ?? 'Could not load invoices.')
    if (j) {
      setInvoices(j.invoices ?? [])
      setUnbilled(j.unbilled ?? [])
      setCounterparties(j.counterparties ?? [])
      setReceivableAccounts(j.receivableAccounts ?? [])
      if (j.defaultQuarter) { setYear(j.defaultQuarter.year); setQuarter(j.defaultQuarter.quarter); setRangeThrough(j.defaultQuarter.end) }
      setTo(prev => prev || j.unbilled?.[0]?.vehicleId || '')
    }
    setLoading(false)
  }, [lf, group])
  useEffect(() => { void load() }, [load])

  async function runPreview() {
    if (!to) return
    setBusy(true); setError(null); setNotice(null)
    const range = `${dates.start ? `&from=${dates.start}` : ''}${dates.end ? `&through=${dates.end}` : ''}`
    const r = await lf(`/api/accounting/partnership-invoices?to=${to}&year=${year}&quarter=${quarter}${range}`)
    const j = await r.json().catch(() => ({}))
    if (!r.ok) setError(j.error ?? 'Could not preview the invoice')
    setPreview(r.ok ? j.preview : null)
    setExcluded(new Set()); setAllocations({}); setRemember(new Set())
    setBusy(false)
  }

  async function post(body: object, fallback: string): Promise<any | null> {
    setBusy(true); setError(null); setNotice(null)
    const r = await lf('/api/accounting/partnership-invoices', json('POST', body))
    const j = await r.json().catch(() => ({}))
    setBusy(false)
    if (!r.ok) { setError(j.error ?? fallback); return null }
    return j
  }

  async function create() {
    const j = await post({ action: 'create', to, year, quarter, from: dates.start, through: dates.end, exclude: Array.from(excluded), allocations, remember: Array.from(remember) }, 'Could not create the invoice')
    if (j) {
      const unsaved = Array.isArray(j.basesNotSaved) && j.basesNotSaved.length ? ` The allocation basis for ${j.basesNotSaved.join(', ')} was not saved for next time.` : ''
      setNotice(`Draft invoice ${j.invoiceNumber} created for ${fmt(j.amount)}. Review the PDF, then issue it.${unsaved}`); setPreview(null); await load()
    }
  }
  async function issue(id: string) {
    if (!window.confirm('Issue this invoice? It books the expense and the payable on the fund’s books.')) return
    const j = await post({ action: 'issue', id }, 'Could not issue the invoice')
    if (j) { setNotice('Issued and booked on the fund’s books. When the fund pays, settle the charge on the Intercompany tab to clear the receivable.'); await load() }
  }
  async function deleteIt(id: string) {
    if (!window.confirm('Delete this draft? Its expenses go back to unbilled, ready for the next invoice.')) return
    const j = await post({ action: 'delete', id }, 'Could not delete the invoice')
    if (j) { setNotice('Draft deleted. Its expenses can be billed again.'); if (editing?.id === id) setEditing(null); await load() }
  }
  async function voidIt(id: string) {
    if (!window.confirm('Void this issued invoice? It keeps its number, marked void, and its expenses become billable again.')) return
    const j = await post({ action: 'void', id }, 'Could not void the invoice')
    if (j) { setNotice('Voided. Its expenses can be billed again.'); await load() }
  }
  async function editOf(id: string) {
    setBusy(true); setError(null)
    const r = await lf(`/api/accounting/partnership-invoices?id=${id}`)
    const j = await r.json().catch(() => ({}))
    setBusy(false)
    if (!r.ok) { setError(j.error ?? 'Could not open the invoice'); return }
    const inv = j.invoice
    const lines = inv.lines as Line[]
    setEditing({ id: inv.id, invoiceNumber: inv.invoiceNumber, status: inv.status, toName: inv.to.name, lines, addable: Array.isArray(j.addable) ? j.addable : [], adjustments: Array.isArray(inv.adjustments) ? inv.adjustments : [] })
    setEditBases(Object.fromEntries(lines.map(l => [l.postingId, l.allocationBasis ?? ''])))
    setEditDesc(Object.fromEntries(lines.map(l => [l.postingId, { vendor: l.vendorName ?? '', description: l.memo ?? '' }])))
    setEditRemember(new Set()); setEditRemove(new Set()); setEditAdd(new Set()); setReceiptsFor(null)
    setEditRemoveAdj(new Set()); setEditNewAdj([])
  }
  async function saveEdit() {
    if (!editing) return
    const remove = Array.from(editRemove)
    if (remove.length > 0 && !window.confirm(`Remove ${remove.length} ${remove.length === 1 ? 'expense' : 'expenses'} from ${editing.invoiceNumber}? ${remove.length === 1 ? 'It goes' : 'They go'} back to unbilled, ready for the next invoice.`)) return
    // Only what changed: a vendor or description edit is written to the expense's journal entry.
    const descriptions = Object.fromEntries(editing.lines.flatMap(l => {
      const d = editDesc[l.postingId]
      if (!d || editRemove.has(l.postingId)) return []
      const patch: { vendor?: string; description?: string } = {}
      if (d.vendor.trim() !== (l.vendorName ?? '')) patch.vendor = d.vendor
      if (d.description.trim() !== (l.memo ?? '')) patch.description = d.description
      return Object.keys(patch).length ? [[l.postingId, patch]] : []
    }))
    // A row left blank is ignored; one half filled in is sent, so the server says what is missing.
    const addAdjustments = editNewAdj.filter(a => a.description.trim() || a.amount.trim())
    const j = await post({ action: 'edit', id: editing.id, allocations: editBases, remember: Array.from(editRemember), add: Array.from(editAdd), remove, descriptions, addAdjustments, removeAdjustments: Array.from(editRemoveAdj) }, 'Could not save the invoice')
    if (j) {
      const unsaved = Array.isArray(j.basesNotSaved) && j.basesNotSaved.length ? ` The note for ${j.basesNotSaved.join(', ')} was not saved for next time.` : ''
      const moved = j.added || j.removed ? ` ${[j.added ? `Added ${j.added}` : '', j.removed ? `removed ${j.removed}` : ''].filter(Boolean).join(', ')} ${(j.added || 0) + (j.removed || 0) === 1 ? 'expense' : 'expenses'}; the invoice is now ${fmt(j.amount)}.` : ''
      const adjusted = j.adjusted ? ` Amount due is now ${fmt(j.amountDue)}.` : ''
      setNotice(`${editing.invoiceNumber} saved.${moved}${adjusted} The PDF shows the changes.${unsaved}`)
      await load()
      // Stay open, so an expense just added can get its note and receipt.
      await editOf(editing.id)
    }
  }
  async function addAccounts() {
    const j = await post({ action: 'accounts', to }, 'Could not add the accounts')
    if (j) { setNotice(`Added Due from ${preview?.to.name ?? 'the fund'} to ${group ?? 'this entity'}’s chart. Book what you paid for the fund to it.`); await load(); await runPreview() }
  }
  async function linkAccount(accountId: string) {
    if (!accountId) return
    const j = await post({ action: 'link', to, accountId }, 'Could not use that account')
    if (j) { setNotice(`${j.account.code} ${j.account.name} is now ${preview?.to.name ?? 'the fund'}’s Due-from account.`); await load(); await runPreview() }
  }

  if (loading) return <div className="flex justify-center py-8"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>

  const sel = 'mt-0.5 block rounded border border-input bg-transparent px-2 py-1 text-sm'
  return (
    <div className="space-y-4">
      {unbilled.length > 0 && (
        <p className="text-sm">Not yet invoiced: {unbilled.map(u => `${u.name} ${fmt(u.amount)} (${u.entries} ${u.entries === 1 ? 'expense' : 'expenses'})`).join(', ')}.</p>
      )}

      <div className="flex flex-wrap items-end gap-2 rounded-card border p-3">
        <label className="text-xs text-muted-foreground">Bill to
          <select value={to} onChange={e => { setTo(e.target.value); setPreview(null) }} className={sel}>
            <option value="">Choose a fund…</option>
            {counterparties.filter(c => c.id && c.id !== vehicleId).map(c => <option key={c.id!} value={c.id!}>{c.name}</option>)}
          </select>
        </label>
        <label className="text-xs text-muted-foreground">Quarter
          <select value={quarter} onChange={e => { setQuarter(Number(e.target.value)); followQuarter(year, Number(e.target.value)); setPreview(null) }} className={sel}>
            {[1, 2, 3, 4].map(q => <option key={q} value={q}>Q{q}</option>)}
          </select>
        </label>
        <label className="text-xs text-muted-foreground">Year
          <input type="number" value={year} onChange={e => { setYear(Number(e.target.value)); followQuarter(Number(e.target.value), quarter); setPreview(null) }} className={`${sel} w-24 tabular-nums`} />
        </label>
        <div className="text-xs text-muted-foreground">Expenses dated
          <div className="mt-0.5">
            <PeriodPicker
              preset={preset} onPreset={p => { setPreset(p); setPreview(null) }}
              start={rangeFrom} end={rangeThrough}
              onStart={v => { setRangeFrom(v); setPreview(null) }} onEnd={v => { setRangeThrough(v); setPreview(null) }}
              title="Which expenses to look through. Custom with no From picks up every earlier one not yet invoiced."
            />
          </div>
        </div>
        <Button size="sm" variant="outline" disabled={!to || busy} onClick={() => void runPreview()}>{busy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}Find expenses</Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {notice && !error && <p className="text-sm text-success">{notice}</p>}

      {preview && (() => {
        const kept = preview.lines.filter(l => !excluded.has(l.postingId))
        const keptTotal = kept.reduce((sum, l) => sum + l.amount, 0)
        const earlier = preview.lines.filter(l => l.beforePeriod).length
        return (
        <div className="space-y-2 rounded-card border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">{preview.to.name}, {preview.quarter.label}: {kept.length} {kept.length === 1 ? 'expense' : 'expenses'}, {fmt(keptTotal)}{excluded.size > 0 ? ` (${excluded.size} left off)` : ''}</p>
            {preview.existing
              ? <span className="text-xs text-muted-foreground">Already billed on {preview.existing.invoiceNumber} ({preview.existing.status}).</span>
              : <Button size="sm" disabled={busy || kept.length === 0} onClick={() => void create()}>Create draft invoice</Button>}
          </div>
          {preview.drafts.length > 0 && (
            <p className="text-sm text-warning">{preview.drafts.length} {preview.drafts.length === 1 ? 'expense is' : 'expenses are'} still a draft and will not be billed until posted.</p>
          )}
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs text-muted-foreground">Due-from account
              <select
                value={preview.receivableAccount?.id ?? ''}
                disabled={busy}
                onChange={e => void linkAccount(e.target.value)}
                className={sel}
                title={`The account on ${group ?? 'this entity'}’s books that holds what ${preview.to.name} owes it`}
              >
                {!preview.receivableAccount && <option value="">Choose an account…</option>}
                {receivableAccounts.map(a => {
                  const other = a.counterpartyVehicleId && a.counterpartyVehicleId !== preview.to.vehicleId
                    ? counterparties.find(c => c.id === a.counterpartyVehicleId)?.name ?? 'another entity'
                    : null
                  return <option key={a.id} value={a.id} disabled={!!other}>{a.code} {a.name}{other ? ` (${other})` : ''}</option>
                })}
              </select>
            </label>
            {!preview.hasReceivableAccount && (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void addAccounts()}>Add a new account</Button>
            )}
          </div>
          {!preview.hasReceivableAccount && (
            <p className="text-sm text-muted-foreground">Pick the account {group ?? 'this entity'} books {preview.to.name}’s expenses to, or add a new one. Nothing can be billed until it has one.</p>
          )}
          {earlier > 0 && (
            <p className="text-sm text-muted-foreground">{earlier} {earlier === 1 ? 'expense is' : 'expenses are'} dated before {preview.quarter.label} and not on any invoice yet, so {earlier === 1 ? 'it is' : 'they are'} included here. Untick any that should wait, or narrow the dates.</p>
          )}
          <LinesTable
            lines={preview.lines} fmt={fmt} onOpen={setOpenEntry}
            excluded={excluded}
            onToggle={id => setExcluded(prev => toggled(prev, id))}
            onToggleAll={() => setExcluded(prev => (prev.size === 0 ? new Set(preview.lines.map(l => l.postingId)) : new Set()))}
            allocations={allocations}
            onAllocation={(id, v) => setAllocations(prev => ({ ...prev, [id]: v }))}
            remember={remember}
            onRemember={id => setRemember(prev => toggled(prev, id))}
            toName={preview.to.name}
          />
        </div>
        )
      })()}

      {invoices.length === 0 ? (
        <EmptyState icon={FileText}>No partnership invoices yet.</EmptyState>
      ) : (
        <table className="w-full text-sm">
          <thead><tr className="text-left text-xs text-muted-foreground">
            <th className="pb-1 font-medium">Invoice</th><th className="pb-1 font-medium">Period</th><th className="pb-1 font-medium">From → to</th>
            <th className="pb-1 text-right font-medium">Amount</th><th className="pb-1 font-medium">Status</th><th />
          </tr></thead>
          <tbody>
            {invoices.map(i => {
              const mine = i.from_vehicle_id === vehicleId
              return (
                <tr key={i.id} className="border-t">
                  <td className="py-1.5">{i.invoice_number}</td>
                  <td className="py-1.5 tabular-nums text-xs">{i.period_start} – {i.period_end}</td>
                  <td className="py-1.5 text-xs">{i.from_name ?? '—'} → {i.to_name ?? '—'}</td>
                  <td className="py-1.5 text-right tabular-nums" title={Number(i.adjustment_total || 0) ? `Expenses ${fmt(Number(i.amount))}, adjustments ${fmt(Number(i.adjustment_total))}` : undefined}>{fmt(Number(i.amount) + Number(i.adjustment_total || 0))}</td>
                  <td className="py-1.5 text-xs capitalize">{i.status}</td>
                  <td className="py-1.5 text-right">
                    <span className="inline-flex gap-1.5">
                      <a className={smallBtn} href={`/api/accounting/partnership-invoices/${i.id}/pdf`} target="_blank" rel="noreferrer">PDF</a>
                      {mine && i.status !== 'void' && (
                        <InvoiceActions
                          disabled={busy}
                          actions={i.status === 'draft'
                            ? [
                                { label: 'Issue', hint: 'Book it on the fund’s books', run: () => void issue(i.id) },
                                { label: 'Edit', hint: 'Add or remove expenses and credits, change descriptions, notes and receipts', run: () => void editOf(i.id) },
                                { label: 'Delete', hint: 'Remove the draft; its expenses go back to unbilled', run: () => void deleteIt(i.id) },
                              ]
                            : [
                                { label: 'Edit', hint: 'Change descriptions, notes and receipts', run: () => void editOf(i.id) },
                                { label: 'Void', hint: 'Cancel a sent invoice; its expenses go back to unbilled', run: () => void voidIt(i.id) },
                              ]}
                        />
                      )}
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      {editing && (() => {
        const draft = editing.status === 'draft'
        const total = editing.lines.filter(l => !editRemove.has(l.postingId)).reduce((sum, l) => sum + l.amount, 0)
          + editing.addable.filter(l => editAdd.has(l.postingId)).reduce((sum, l) => sum + l.amount, 0)
        const typedAdj = editNewAdj.map(a => Number(a.amount.replace(/[,$\s]/g, ''))).filter(n => Number.isFinite(n))
        const adjTotal = editing.adjustments.filter(a => !editRemoveAdj.has(a.id)).reduce((sum, a) => sum + a.amount, 0) + typedAdj.reduce((sum, n) => sum + n, 0)
        const changed = editRemove.size > 0 || editAdd.size > 0 || editRemoveAdj.size > 0 || typedAdj.some(n => n !== 0)
        const cell = 'block w-full rounded border border-input bg-transparent px-1.5 py-0.5 text-xs'
        return (
        <div className="space-y-3 rounded-card border p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium">Edit {editing.invoiceNumber}</p>
            <span className="inline-flex gap-1.5">
              <button className={smallBtn} disabled={busy} onClick={() => setEditing(null)}>Close</button>
              <Button size="sm" disabled={busy} onClick={() => void saveEdit()}>Save</Button>
            </span>
          </div>
          {!draft && <p className="text-xs text-muted-foreground">Already issued, so its expenses and amount are booked on the fund’s books and can’t change here; void it and bill again for that. Descriptions, notes and receipts can still change; send the fund the new PDF if it needs one.</p>}
          <p className="text-xs text-muted-foreground">Vendor and description are the expense’s own: a change here is made on its journal entry too.</p>
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs text-muted-foreground">
              <th className="pb-1 font-medium">Date</th><th className="pb-1 font-medium">Vendor</th><th className="pb-1 font-medium">Description</th><th className="pb-1 font-medium">Allocation basis</th><th className="pb-1 text-right font-medium">Amount</th><th />
            </tr></thead>
            <tbody>
              {editing.lines.map(l => {
                const value = editBases[l.postingId] ?? ''
                const d = editDesc[l.postingId] ?? { vendor: '', description: '' }
                const removed = editRemove.has(l.postingId)
                const vendor = d.vendor.trim() || l.vendorName
                return (
                  <Fragment key={l.postingId}>
                  <tr className={`border-t align-top text-xs ${removed ? 'text-muted-foreground' : ''}`}>
                    <td className={`py-1 pr-2 tabular-nums ${removed ? 'line-through' : ''}`}>{l.entryDate}</td>
                    <td className="py-1 pr-2">
                      <input value={d.vendor} disabled={removed} onChange={e => setEditDesc(prev => ({ ...prev, [l.postingId]: { ...d, vendor: e.target.value } }))} placeholder="Vendor" aria-label={`Vendor for the expense dated ${l.entryDate}`} className={cell} />
                    </td>
                    <td className="py-1 pr-2">
                      <input value={d.description} disabled={removed} onChange={e => setEditDesc(prev => ({ ...prev, [l.postingId]: { ...d, description: e.target.value } }))} placeholder="Description" aria-label={`Description for the expense dated ${l.entryDate}`} className={cell} />
                    </td>
                    <td className="py-1 pr-2">
                      <input
                        value={value}
                        disabled={removed}
                        onChange={e => setEditBases(prev => ({ ...prev, [l.postingId]: e.target.value }))}
                        placeholder="Note for invoice"
                        aria-label={`Allocation basis for the expense dated ${l.entryDate}`}
                        className={cell}
                      />
                      {!removed && vendor && value.trim() && (
                        <label className="mt-0.5 inline-flex items-center gap-1 text-muted-foreground">
                          <input type="checkbox" checked={editRemember.has(l.postingId)} onChange={() => setEditRemember(prev => toggled(prev, l.postingId))} />
                          use for future {vendor} expenses for {editing.toName}
                        </label>
                      )}
                    </td>
                    <td className={`py-1 text-right tabular-nums ${removed ? 'line-through' : ''}`}>{fmt(l.amount)}</td>
                    <td className="py-1 pl-2 text-right">
                      <span className="inline-flex gap-1">
                        <button className={smallBtn} disabled={busy || removed} onClick={() => setReceiptsFor(receiptsFor === l.entryId ? null : l.entryId)}>Receipts{l.receiptCount ? ` (${l.receiptCount})` : ''}</button>
                        {draft && <button className={smallBtn} disabled={busy} onClick={() => setEditRemove(prev => toggled(prev, l.postingId))}>{removed ? 'Keep' : 'Remove'}</button>}
                      </span>
                    </td>
                  </tr>
                  {receiptsFor === l.entryId && (
                    <tr><td colSpan={6} className="pb-2"><EntryReceipts key={l.entryId} entryId={l.entryId} /></td></tr>
                  )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
          {draft && (
            <div className="space-y-1">
              <p className="text-xs font-medium">Add expenses</p>
              {editing.addable.length === 0 ? (
                <p className="text-xs text-muted-foreground">No other posted expenses on Due from {editing.toName} are waiting to be billed.</p>
              ) : (
                <table className="w-full text-sm">
                  <tbody>
                    {editing.addable.map(l => (
                      <tr key={l.postingId} className="border-t align-top text-xs">
                        <td className="w-6 py-1"><input type="checkbox" checked={editAdd.has(l.postingId)} onChange={() => setEditAdd(prev => toggled(prev, l.postingId))} aria-label={`Add the expense dated ${l.entryDate}`} /></td>
                        <td className="py-1 pr-2 tabular-nums">{l.entryDate}</td>
                        <td className="py-1 pr-2">{l.vendorName ?? '—'}</td>
                        <td className="py-1 pr-2 text-muted-foreground">{l.memo ?? ''}</td>
                        <td className="py-1 text-right tabular-nums">{fmt(l.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
          {(draft || editing.adjustments.length > 0) && (
            <div className="space-y-1">
              <p className="text-xs font-medium">Credits and adjustments</p>
              <p className="text-xs text-muted-foreground">
                Printed below the expenses and taken off (or added to) the amount due. Use a negative amount to credit {editing.toName}, for example for an earlier invoice that asked for more than the books said. Nothing is booked: the expenses stay as they are, and settling the invoice moves the amount due.
              </p>
              <table className="w-full text-sm">
                <tbody>
                  {editing.adjustments.map(a => {
                    const removed = editRemoveAdj.has(a.id)
                    return (
                      <tr key={a.id} className={`border-t text-xs ${removed ? 'text-muted-foreground line-through' : ''}`}>
                        <td className="py-1 pr-2">{a.description}</td>
                        <td className="py-1 text-right tabular-nums">{fmt(a.amount)}</td>
                        <td className="w-20 py-1 pl-2 text-right">
                          {draft && <button className={smallBtn} disabled={busy} onClick={() => setEditRemoveAdj(prev => toggled(prev, a.id))}>{removed ? 'Keep' : 'Remove'}</button>}
                        </td>
                      </tr>
                    )
                  })}
                  {draft && editNewAdj.map((a, i) => (
                    <tr key={`new-${i}`} className="border-t text-xs">
                      <td className="py-1 pr-2">
                        <input value={a.description} onChange={e => setEditNewAdj(prev => prev.map((x, k) => (k === i ? { ...x, description: e.target.value } : x)))} placeholder="Credit for overbilling on an earlier invoice" aria-label="Adjustment description" className={cell} />
                      </td>
                      <td className="w-32 py-1">
                        <input value={a.amount} inputMode="decimal" onChange={e => setEditNewAdj(prev => prev.map((x, k) => (k === i ? { ...x, amount: e.target.value } : x)))} placeholder="-1,000.00" aria-label="Adjustment amount, negative for a credit" className={`${cell} text-right tabular-nums`} />
                      </td>
                      <td className="w-20 py-1 pl-2 text-right">
                        <button className={smallBtn} disabled={busy} onClick={() => setEditNewAdj(prev => prev.filter((_, k) => k !== i))}>Remove</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {draft && <button className={smallBtn} disabled={busy} onClick={() => setEditNewAdj(prev => [...prev, { description: '', amount: '' }])}>Add a credit or adjustment</button>}
            </div>
          )}
          {changed && (
            <p className="text-xs text-muted-foreground">
              {[editAdd.size ? `${editAdd.size} to add` : '', editRemove.size ? `${editRemove.size} to remove (back to unbilled)` : ''].filter(Boolean).join(', ')}{editAdd.size || editRemove.size ? '. ' : ''}Expenses {fmt(total)}{adjTotal ? `, adjustments ${fmt(adjTotal)}, amount due ${fmt(total + adjTotal)}` : ''}.
            </p>
          )}
        </div>
        )
      })()}
      {openEntry && <EntryModal entryId={openEntry} readOnly onClose={() => setOpenEntry(null)} onSaved={() => void load()} />}
    </div>
  )
}

/** The actions an invoice's status allows, behind one button. */
function InvoiceActions({ actions, disabled }: { actions: { label: string; hint: string; run: () => void }[]; disabled: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className={`${smallBtn} inline-flex items-center`} disabled={disabled}>Actions<ChevronDown className="ml-1 h-3 w-3 opacity-60" /></button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-1">
        {actions.map(a => (
          <button
            key={a.label}
            type="button"
            onClick={() => { setOpen(false); a.run() }}
            className="block w-full rounded-sm px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <div>{a.label}</div>
            <div className="text-xs text-muted-foreground">{a.hint}</div>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}

/** A quarter's last day, YYYY-MM-DD: the default end of the expenses an invoice reads. */
function quarterEnd(year: number, quarter: number): string {
  if (!Number.isInteger(year) || year < 1900 || ![1, 2, 3, 4].includes(quarter)) return ''
  const month = quarter * 3
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return `${year}-${String(month).padStart(2, '0')}-${String(last).padStart(2, '0')}`
}

function toggled(set: Set<string>, id: string): Set<string> {
  const next = new Set(set)
  if (next.has(id)) next.delete(id); else next.add(id)
  return next
}

function LinesTable({ lines, fmt, onOpen, excluded, onToggle, onToggleAll, allocations, onAllocation, remember, onRemember, toName }: {
  lines: Line[]; fmt: (v: number) => string; onOpen: (id: string) => void
  excluded: Set<string>; onToggle: (postingId: string) => void; onToggleAll: () => void
  allocations: Record<string, string>; onAllocation: (postingId: string, value: string) => void
  remember: Set<string>; onRemember: (postingId: string) => void
  toName: string
}) {
  if (lines.length === 0) return <p className="text-xs text-muted-foreground">No posted debits to the fund’s Due-from account in these dates that are not already invoiced.</p>
  return (
    <table className="w-full text-xs">
      <thead><tr className="text-left text-muted-foreground">
        <th className="w-6 pb-1 font-medium">
          <input
            type="checkbox"
            checked={excluded.size === 0}
            ref={el => { if (el) el.indeterminate = excluded.size > 0 && excluded.size < lines.length }}
            onChange={onToggleAll}
            aria-label="Bill all or none of these expenses"
          />
        </th>
        <th className="pb-1 font-medium">Date</th><th className="pb-1 font-medium">Vendor</th><th className="pb-1 font-medium">Memo</th>
        <th className="pb-1 font-medium">Receipt</th><th className="pb-1 font-medium">Allocation basis</th><th className="pb-1 text-right font-medium">Amount</th>
      </tr></thead>
      <tbody>
        {lines.map(l => (
          <tr key={l.postingId} className={`border-t ${excluded.has(l.postingId) ? 'text-muted-foreground' : ''}`}>
            <td className="py-1"><input type="checkbox" checked={!excluded.has(l.postingId)} onChange={() => onToggle(l.postingId)} aria-label={`Bill ${l.vendorName ?? l.memo ?? 'this expense'} on this invoice`} /></td>
            <td className="py-1 tabular-nums">
              <button className="underline underline-offset-2" onClick={() => onOpen(l.entryId)}>{l.entryDate}</button>
            </td>
            <td className="py-1">{l.vendorName ?? '—'}</td>
            <td className="py-1">{l.memo ?? '—'}</td>
            <td className={`py-1 ${l.receiptCount > 0 ? '' : 'text-muted-foreground'}`}>{l.receiptCount > 0 ? `${l.receiptCount}` : 'missing'}</td>
            <td className="min-w-[200px] py-1 pr-2">
              {(() => {
                const typed = l.postingId in allocations
                const value = typed ? allocations[l.postingId] : l.allocationBasis ?? ''
                return (
                  <>
                    <input
                      value={value}
                      onChange={e => onAllocation(l.postingId, e.target.value)}
                      placeholder="Note for invoice"
                      aria-label={`Allocation basis for ${l.vendorName ?? l.memo ?? 'this expense'}`}
                      className="block w-full rounded border border-input bg-transparent px-1.5 py-0.5 text-xs"
                    />
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-muted-foreground">
                      {!typed && l.allocationSource === 'receipt' && <span>from the receipt</span>}
                      {!typed && l.allocationSource === 'vendor' && <span>saved for {l.vendorName}</span>}
                      {l.vendorName && value.trim() && (typed || l.allocationSource !== 'vendor') && (
                        <label className="inline-flex items-center gap-1">
                          <input type="checkbox" checked={remember.has(l.postingId)} onChange={() => onRemember(l.postingId)} />
                          use for future {l.vendorName} expenses for {toName}
                        </label>
                      )}
                    </div>
                  </>
                )
              })()}
            </td>
            <td className="py-1 text-right tabular-nums">{fmt(l.amount)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
