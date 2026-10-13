'use client'

import { useEffect, useState } from 'react'
import { Loader2, FileText, Pencil } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { useCurrency, formatCurrencyPrice } from '@/components/currency-context'
import { useLedgerFetch, useVehicle } from '@/components/accounting-vehicle'
import { PERIOD_PRESETS, type PeriodPreset } from '@/lib/accounting/statement-period'
import { EmptyState } from '@/components/ui/empty-state'
import { useCanWrite } from '@/components/access-context'
import { VehicleLetterheadDialog } from '@/components/vehicle-letterhead'
import type { CapitalAccount } from '@/lib/accounting/capital-account'
import { rollForwardRows, commitmentSummaryRows, STATEMENT_COLUMNS } from '@/lib/accounting/capital-statement-layout'

interface Row { lpEntityId: string; name: string; partnerClass: string; commitment: number; called: number; funded: number; outstanding: number; receivable: number; ending: number }
interface Period { preset: PeriodPreset; start: string | null; end: string | null; label: string }
interface LetterheadParts { logo: string | null; name: string | null; address: string | null; email: string | null }
interface Statement {
  row: Row
  rollForward: CapitalAccount
  periodRollForward: CapitalAccount
  ytdRollForward: CapitalAccount
  ytdPeriod: { start: string; end: string }
  ownership: number
  period: Period
  /** What the PDF prints, the fund's default, and this vehicle's overrides. */
  letterhead: { letterhead: LetterheadParts; fund: LetterheadParts; vehicle: LetterheadParts }
}

// The statement as the PDF lays it out (lib/accounting/capital-statement-layout.ts): the letterhead,
// the roll-forward in three columns, and the commitment summary. Nothing after the summary — the
// transaction list and fund-of-funds exhibits belong to the fund's financials, not a partner's
// capital account.
export function LpStatementView({ lpEntityId, vehicleId }: { lpEntityId: string; vehicleId?: string | null }) {
  const currency = useCurrency()
  const fmt = (v: number) => formatCurrencyPrice(v, currency)
  const lf = useLedgerFetch()
  const { group } = useVehicle()
  const canEditLetterhead = useCanWrite('accounting')
  const [data, setData] = useState<Statement | null>(null)
  const [loading, setLoading] = useState(true)
  const [preset, setPreset] = useState<PeriodPreset>('ytd')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [editingLetterhead, setEditingLetterhead] = useState(false)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    setLoading(true)
    const qs = new URLSearchParams({ lp: lpEntityId, preset })
    if (preset === 'custom') {
      if (start) qs.set('start', start)
      if (end) qs.set('end', end)
    }
    lf(`/api/accounting/lp-statement?${qs}`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => setData(d && !d.error ? d : null))
      .finally(() => setLoading(false))
  }, [lf, lpEntityId, preset, start, end, reload])

  if (loading && !data) return <div className="flex items-center gap-2 text-muted-foreground text-sm"><Loader2 className="h-4 w-4 animate-spin" />Loading…</div>
  if (!data) return <EmptyState>No statement for this LP in the selected vehicle.</EmptyState>

  const { row, period, ownership } = data
  const accounts = [data.periodRollForward, data.ytdRollForward, data.rollForward]
  const rows = rollForwardRows(accounts)
  const summary = commitmentSummaryRows(accounts, row, ownership)
  const lastCol = accounts.length - 1
  const pdfQs = new URLSearchParams({ lp: lpEntityId })
  if (group) pdfQs.set('group', group)
  if (preset === 'custom') { if (start) pdfQs.set('start', start); if (end) pdfQs.set('end', end) }
  else pdfQs.set('preset', preset)
  const statementPdfUrl = `/api/accounting/lp-statement/pdf?${pdfQs}`

  const lh = data.letterhead
  const vehicleName = group ?? 'This vehicle'
  const contact = [lh.letterhead.address, lh.letterhead.email].filter(Boolean).join('\n')
  const columnSub = [
    period.start && period.end ? `${period.start} to ${period.end}` : period.label,
    `${data.ytdPeriod.start} to ${data.ytdPeriod.end}`,
    period.end ? `Through ${period.end}` : '',
  ]

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-medium">{row.name}</h2>
        <div className="flex flex-wrap items-end gap-2">
          <select
            value={preset}
            onChange={e => setPreset(e.target.value as PeriodPreset)}
            className="h-8 px-2 rounded-md border border-input bg-background text-xs"
          >
            {PERIOD_PRESETS.filter(p => p.value !== 'itd').map(p => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
          {preset === 'custom' && (
            <>
              <Input type="date" value={start} onChange={e => setStart(e.target.value)} className="h-8 w-36 text-xs" />
              <Input type="date" value={end} onChange={e => setEnd(e.target.value)} className="h-8 w-36 text-xs" />
            </>
          )}
          {/* The vehicle's letterhead (logo, name, address, email), each part falling back to the fund's. */}
          {vehicleId && canEditLetterhead && (
            <button
              onClick={() => setEditingLetterhead(true)}
              className="inline-flex h-8 items-center gap-1.5 rounded border border-input px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Pencil className="h-3.5 w-3.5" />Edit Details
            </button>
          )}
          {/* Preview only — renders the PDF without storing or sharing it. Publishing
              to the portal is the bulk action on the capital accounts page. */}
          <a
            href={statementPdfUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-8 items-center gap-1.5 rounded border border-input px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <FileText className="h-3.5 w-3.5" />Generate PDF
          </a>
        </div>
      </div>

      <div className={`border rounded-card p-4 sm:p-6 space-y-6 ${loading ? 'opacity-60' : ''}`}>
        {/* Letterhead, as the PDF prints it */}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="shrink-0">
            {lh.letterhead.logo && <img src={lh.letterhead.logo} alt="" className="h-10 w-auto object-contain" />}
          </div>
          <div className="text-right">
            <p className="text-heading font-display font-normal">{lh.letterhead.name}</p>
            {contact && <p className="text-xs text-muted-foreground whitespace-pre-line leading-snug mt-0.5">{contact}</p>}
          </div>
        </div>

        <div>
          <p className="text-heading font-display font-normal">Capital Account Statement</p>
          <p className="text-sm font-semibold">{row.name}</p>
          <p className="text-xs text-muted-foreground">{vehicleName} · {period.label}</p>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-xs">
                <th className="text-left px-3 py-2 font-medium" />
                {STATEMENT_COLUMNS.map((h, i) => (
                  <th key={h} className="text-right px-3 py-2 font-medium whitespace-nowrap">
                    {h}
                    {columnSub[i] && <div className="font-normal text-muted-foreground">{columnSub[i]}</div>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.key} className={`border-b last:border-b-0 ${r.style === 'total' ? 'font-semibold bg-muted/30' : r.style === 'subtotal' ? 'font-semibold' : ''}`}>
                  <td className={`px-3 py-2 ${r.style === 'component' ? 'pl-7 text-muted-foreground' : ''}`}>{r.label}</td>
                  {r.values.map((v, i) => (
                    <td key={i} className={`px-3 py-2 text-right tabular-nums ${r.key === 'unclassified' && Math.abs(v) > 0.004 ? 'text-warning' : ''}`}>{fmt(v)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div>
          <p className="text-sm font-medium mb-2">Commitment summary</p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <tbody>
                {summary.map(r => (
                  <tr key={r.label} className="border-b last:border-b-0">
                    <td className="px-3 py-2">{r.label}</td>
                    {r.values.map((v, i) => (
                      <td key={i} className="px-3 py-2 text-right tabular-nums w-[22%]">
                        {v === null && i < lastCol ? '' : r.format === 'percent' ? `${((v ?? 0) * 100).toFixed(3)}%` : fmt(v ?? 0)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {editingLetterhead && vehicleId && (
        <VehicleLetterheadDialog
          vehicleId={vehicleId}
          vehicleName={vehicleName}
          onClose={() => { setEditingLetterhead(false); setReload(n => n + 1) }}
          onSaved={() => { setEditingLetterhead(false); setReload(n => n + 1) }}
        />
      )}
    </div>
  )
}
