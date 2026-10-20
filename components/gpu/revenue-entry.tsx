'use client'

import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { ErrorAlert, Field } from './fleet-ui'
import {
  autoNet, derived, importCsv, importRows, manualRowsBody,
  type EntryRow, type ImportReply,
} from './revenue-api'
import type { Fetcher } from './fleet-api'

// ── GPU fleet (P5) ── Enter a period: one row per server, rented GPU-hours or utilization (the other
// is worked out from the server's GPUs × 24 × days, as the import does), gross, fee and net, downtime.
// Or a CSV paste, sent to the route as typed. Either way the rows are STAGED, never posted (Q1).

export const CSV_COLUMNS = 'asset, period_start, period_end, rented_hours, utilization_pct, gross, fee, net, downtime_hours, note'

const cell = 'h-8 text-right tabular-nums'
const fmt4 = (n: number | null) => (n == null || !Number.isFinite(n) ? '—' : String(Number(n.toFixed(4))))

/** The rows and period as typed, and what to do with them. Rendered statically by the tests. */
export function EntryTable({ period, rows, onPeriod, onRow, disabled }: {
  period: { start: string; end: string }
  rows: EntryRow[]
  onPeriod: (p: { start: string; end: string }) => void
  onRow: (i: number, r: EntryRow) => void
  disabled?: boolean
}) {
  return (
    <fieldset disabled={disabled} className="space-y-3">
      <div className="flex flex-wrap gap-3">
        <Field id="rev-start" label="Period start">
          <Input id="rev-start" type="date" value={period.start} onChange={e => onPeriod({ ...period, start: e.target.value })} className="h-9 w-40 tabular-nums" />
        </Field>
        <Field id="rev-end" label="Period end" hint="Defaults to last calendar month.">
          <Input id="rev-end" type="date" value={period.end} onChange={e => onPeriod({ ...period, end: e.target.value })} className="h-9 w-40 tabular-nums" />
        </Field>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No servers in service to enter. Paste CSV below, or bring a server into service on the Fleet page.</p>
      ) : (
        <div className="overflow-x-auto rounded-card border">
          <table className="w-full text-sm" data-region="entry">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                {['Server', 'Entered as', 'Rented GPU-hours', 'Utilization %', 'Gross', 'Fee', 'Net', 'Downtime GPU-hours', 'Note'].map((h, i) => (
                  <th key={h} scope="col" className={cn('whitespace-nowrap px-2 py-2 font-medium', i >= 2 && i <= 7 ? 'text-right' : 'text-left')}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const set = (k: keyof EntryRow) => (e: { target: { value: string } }) => onRow(i, { ...r, [k]: e.target.value })
                const d = derived(r, period.start, period.end)
                const net = autoNet(r)
                return (
                  <tr key={r.assetId} className="border-t" data-entry={r.assetId}>
                    <td className="whitespace-nowrap px-2 py-1.5">{r.assetName}<span className="ml-1 text-caption text-muted-foreground">{r.gpuCount} GPUs</span></td>
                    <td className="px-2 py-1.5">
                      <select aria-label={`${r.assetName}: entered as`} value={r.basis}
                        onChange={e => onRow(i, { ...r, basis: e.target.value as EntryRow['basis'], rentedHours: '', utilizationPct: '' })}
                        className="h-8 rounded-md border border-input bg-background px-1.5 text-sm">
                        <option value="hours">GPU-hours</option>
                        <option value="utilization">Utilization</option>
                      </select>
                    </td>
                    <td className="px-2 py-1.5">
                      {r.basis === 'hours'
                        ? <Input aria-label={`${r.assetName}: rented GPU-hours`} inputMode="decimal" className={cn(cell, 'w-28')} value={r.rentedHours} onChange={set('rentedHours')} />
                        : <span className="block text-right tabular-nums text-muted-foreground" data-derived="hours">{fmt4(d.rentedHours)}</span>}
                    </td>
                    <td className="px-2 py-1.5">
                      {r.basis === 'utilization'
                        ? <Input aria-label={`${r.assetName}: utilization %`} inputMode="decimal" className={cn(cell, 'w-20')} value={r.utilizationPct} onChange={set('utilizationPct')} />
                        : <span className="block text-right tabular-nums text-muted-foreground" data-derived="utilization">{fmt4(d.utilizationPct)}</span>}
                    </td>
                    <td className="px-2 py-1.5"><Input aria-label={`${r.assetName}: gross`} inputMode="decimal" className={cn(cell, 'w-28')} value={r.gross} onChange={set('gross')} /></td>
                    <td className="px-2 py-1.5"><Input aria-label={`${r.assetName}: fee`} inputMode="decimal" className={cn(cell, 'w-24')} value={r.fee} onChange={set('fee')} placeholder="0" /></td>
                    <td className="px-2 py-1.5">
                      <Input aria-label={`${r.assetName}: net`} inputMode="decimal" className={cn(cell, 'w-28')} value={r.net} onChange={set('net')}
                        placeholder={net == null ? '' : net.toFixed(2)} />
                    </td>
                    <td className="px-2 py-1.5"><Input aria-label={`${r.assetName}: downtime GPU-hours`} inputMode="decimal" className={cn(cell, 'w-24')} value={r.downtimeHours} onChange={set('downtimeHours')} /></td>
                    <td className="px-2 py-1.5"><Input aria-label={`${r.assetName}: note`} className="h-8 w-40" value={r.note} onChange={set('note')} /></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-caption text-muted-foreground">
        Leave a server&rsquo;s row empty to enter nothing for it. Net left blank is gross less fee; a fee left blank is 0. The
        figure not typed (GPU-hours or utilization) is worked out from the server&rsquo;s GPUs &times; 24 &times; days.
      </p>
    </fieldset>
  )
}

/** What the import did, in its own words: what was staged, skipped and why, and what needs review. */
export function ImportSummary({ result }: { result: ImportReply }) {
  const unmatched = result.staged.filter(s => s.status === 'unmatched').length
  return (
    <div className="space-y-1 rounded-lg border px-3 py-2 text-sm" role="status" data-region="import-summary">
      <p>
        Staged <span className="tabular-nums">{result.imported}</span>
        {result.skipped > 0 && <>; skipped <span className="tabular-nums">{result.skipped}</span></>}
        {unmatched > 0 && <>; <span className="text-warning">{unmatched} matched no server</span></>}
        {result.needsReview > 0 && <>; <span className="tabular-nums">{result.needsReview}</span> replace a posted period and need review</>}.
      </p>
      {result.skippedRows.length > 0 && (
        <ul className="list-disc pl-5 text-muted-foreground">{result.skippedRows.map(s => <li key={s}>{s}</li>)}</ul>
      )}
      {result.errors.length > 0 && (
        <ul className="list-disc pl-5 text-destructive">{result.errors.map(s => <li key={s}>{s}</li>)}</ul>
      )}
    </div>
  )
}

/** The form, wired: stage the typed rows, or the paste. */
export function EntryForm({ fetcher, initialRows, initialPeriod, canWrite, onStaged }: {
  fetcher: Fetcher
  initialRows: EntryRow[]
  initialPeriod: { start: string; end: string }
  canWrite: boolean
  onStaged: () => void
}) {
  const [period, setPeriod] = useState(initialPeriod)
  const [rows, setRows] = useState(initialRows)
  const [csv, setCsv] = useState('')
  const [busy, setBusy] = useState<'rows' | 'csv' | null>(null)
  const [errors, setErrors] = useState<string[]>([])
  const [result, setResult] = useState<ImportReply | null>(null)

  async function stageRows() {
    const req = manualRowsBody(period, rows)
    if (!req.ok) { setErrors(req.errors); return }
    setBusy('rows'); setErrors([]); setResult(null)
    const r = await importRows(fetcher, req.rows)
    setBusy(null)
    if (!r.ok) { setErrors([r.error]); return }
    setResult(r.data)
    setRows(initialRows)
    onStaged()
  }

  async function stagePaste() {
    if (!csv.trim()) { setErrors(['Paste the rows first.']); return }
    setBusy('csv'); setErrors([]); setResult(null)
    const r = await importCsv(fetcher, csv)
    setBusy(null)
    if (!r.ok) { setErrors([r.error]); return }
    setResult(r.data)
    setCsv('')
    onStaged()
  }

  return (
    <div className="space-y-4">
      <EntryTable period={period} rows={rows} onPeriod={setPeriod} onRow={(i, r) => setRows(rs => rs.map((x, j) => (j === i ? r : x)))} disabled={!canWrite || busy != null} />
      <div className="flex justify-end">
        <Button size="sm" onClick={stageRows} disabled={!canWrite || busy != null || rows.length === 0}>
          {busy === 'rows' && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}Stage entries
        </Button>
      </div>

      <Field id="rev-csv" label="Or paste CSV" hint={`Columns, in this order (header row optional): ${CSV_COLUMNS}. The asset matches a server's name, serial or id.`}>
        <Textarea id="rev-csv" rows={4} className="font-mono" placeholder={CSV_COLUMNS} value={csv} onChange={e => setCsv(e.target.value)} disabled={!canWrite || busy != null} />
      </Field>
      <div className="flex justify-end">
        <Button size="sm" variant="outline" onClick={stagePaste} disabled={!canWrite || busy != null}>
          {busy === 'csv' && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}Stage paste
        </Button>
      </div>

      {errors.length > 0 && <ErrorAlert>{errors.length === 1 ? errors[0] : <ul className="list-disc pl-5">{errors.map(e => <li key={e}>{e}</li>)}</ul>}</ErrorAlert>}
      {result && <ImportSummary result={result} />}
    </div>
  )
}
