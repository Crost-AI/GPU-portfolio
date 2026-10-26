'use client'

import { useCallback, useEffect, useState } from 'react'
import { Loader2, FileText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { useCurrency, formatCurrencyPrice } from '@/components/currency-context'
import { useLedgerFetch, useVehicle } from '@/components/accounting-vehicle'
import { EntryModal } from '../entry-modal'
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

interface InvoiceRow { id: string; invoice_number: string; invoice_date: string; period_start: string; period_end: string; amount: number; status: string; from_vehicle_id: string; to_vehicle_id: string; from_name: string | null; to_name: string | null }
interface Line { entryId: string; postingId: string; entryDate: string; memo: string | null; reference: string | null; vendorName: string | null; amount: number; receiptCount: number; status: string; beforePeriod?: boolean; allocationBasis: string | null; allocationSource?: 'receipt' | 'vendor' | null }
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
  async function voidIt(id: string) {
    if (!window.confirm('Void this invoice? Its expenses become billable again.')) return
    const j = await post({ action: 'void', id }, 'Could not void the invoice')
    if (j) { setNotice('Voided. Its expenses can be billed again.'); await load() }
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
      <p className="text-xs text-muted-foreground">
        When {group ?? 'this entity'} pays a fund’s expense, book it to “Due from” that fund instead of an expense. The quarter’s invoice bills every posted debit to that account not already invoiced, and the PDF lists each one with its receipt behind it. Issuing books the expense and the payable on the fund’s books; the fund’s payment, settled on the Intercompany tab, clears the receivable.
      </p>
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
                  <td className="py-1.5 text-right tabular-nums">{fmt(Number(i.amount))}</td>
                  <td className="py-1.5 text-xs capitalize">{i.status}</td>
                  <td className="py-1.5 text-right">
                    <span className="inline-flex gap-1.5">
                      <a className={smallBtn} href={`/api/accounting/partnership-invoices/${i.id}/pdf`} target="_blank" rel="noreferrer">PDF</a>
                      {mine && i.status === 'draft' && <button className={smallBtn} disabled={busy} onClick={() => void issue(i.id)}>Issue</button>}
                      {mine && i.status !== 'void' && <button className={smallBtn} disabled={busy} onClick={() => void voidIt(i.id)}>Void</button>}
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      {openEntry && <EntryModal entryId={openEntry} readOnly onClose={() => setOpenEntry(null)} onSaved={() => void load()} />}
    </div>
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
                      placeholder="Why the fund bears it"
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
