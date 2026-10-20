// ── GPU fleet (P5) ── The operations routes as the Revenue & payouts page and the KPI tiles call them:
// the request bodies, the reply shapes, and the arithmetic the page does on them. Pure. The field
// names are the ones parseManualRows (lib/gpu/ops/parse.ts) and the routes under app/api/fleet/ops
// read; nothing here decides what is allowed, the routes do.

import type { EarningStatus } from '@/lib/gpu/ops/types'
import type { Kpi } from '@/lib/gpu/kpis'
import { daysInclusive } from '@/lib/gpu/kpis'
import { call, send, type Fetcher } from './fleet-api'

export const opsPaths = {
  import: '/api/fleet/ops/import',
  earnings: '/api/fleet/ops/earnings',
  payouts: '/api/fleet/ops/payouts',
  kpis: '/api/fleet/kpis',
}

// ── Reply shapes ───────────────────────────────────────────────────────────────────────────────

/** A row of GET /api/fleet/ops/earnings. */
export interface EarningView {
  id: string
  runId: string | null
  assetId: string | null
  assetName: string | null
  /** What was typed or pasted for the asset: the name, serial or id it was matched on (or not). */
  assetRef: string
  periodStart: string
  periodEnd: string
  gpuHoursRented: number | null
  utilizationPct: number | null
  gross: number
  fee: number
  net: number
  downtimeHours: number
  note: string | null
  currency: string
  status: EarningStatus
  supersedesId: string | null
  entryId: string | null
}

/** The bank-import ImportResult the import route returns, plus the run. */
export interface ImportReply {
  imported: number
  skipped: number
  needsReview: number
  skippedRows: string[]
  errors: string[]
  runId: string
  staged: { id: string; status: string }[]
}

export type PayoutStatus = 'expected' | 'matching' | 'matched'

export interface PayoutView {
  id: string
  payoutDate: string
  amount: number
  reference: string | null
  note: string | null
  status: PayoutStatus
  bankTransactionId: string | null
  entryId: string | null
  /** Open bank inflows of the same amount within the window; only for an expected payout. */
  candidates: { id: string; txnDate: string; amount: number; description: string | null; status: string }[]
}

export interface ReceivableTieOut {
  asOf: string
  ledger1150: number
  postedNet: number
  matchedPayouts: number
  expected: number
  difference: number
}

export interface NeedsReversal { id: string; supersedesId: string; entryId: string | null; entryDate: string | null }

export type PostReply =
  | { posted: { id: string; entryId: string | null }[]; reversed: { id: string; reversalId: string | null }[] }
  | { needsReversal: NeedsReversal[] }

export type FleetKpis = { month: string; fleet: Kpi; byType: Record<string, Kpi>; byAsset: Record<string, Kpi & { name: string }>; ltm: Kpi }

// ── Requests ───────────────────────────────────────────────────────────────────────────────────

export const listEarnings = (f: Fetcher, from: string, to: string) =>
  call<{ rows: EarningView[] }>(f, `${opsPaths.earnings}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
export const listPayouts = (f: Fetcher) => call<{ payouts: PayoutView[]; receivable: ReceivableTieOut }>(f, opsPaths.payouts)
export const getKpis = (f: Fetcher, month: string) => call<FleetKpis>(f, `${opsPaths.kpis}?month=${encodeURIComponent(month)}`)
/** The KPIs of a vehicle named explicitly, for pages that list several (the /fleet overview, the lead page). */
export const getVehicleKpis = (f: Fetcher, vehicle: string, month: string) =>
  call<FleetKpis>(f, `${opsPaths.kpis}?group=${encodeURIComponent(vehicle)}&month=${encodeURIComponent(month)}`)

export const importRows = (f: Fetcher, rows: ManualRowBody[]) => send<ImportReply>(f, opsPaths.import, 'POST', { rows })
/** A paste goes to the route as typed: the server parses it (parseEarningsCsv). */
export const importCsv = (f: Fetcher, csv: string) => send<ImportReply>(f, opsPaths.import, 'POST', { csv })
export const postEarnings = (f: Fetcher, ids: string[], confirmReversal = false) =>
  send<PostReply>(f, opsPaths.earnings, 'POST', { action: 'post', ids, ...(confirmReversal ? { confirmReversal: true } : {}) })
export const ignoreEarnings = (f: Fetcher, ids: string[]) => send<{ ignored: string[] }>(f, opsPaths.earnings, 'POST', { action: 'ignore', ids })
export const recordPayout = (f: Fetcher, body: PayoutBody) => send<{ payout: unknown }>(f, opsPaths.payouts, 'POST', { action: 'record', ...body })
export const matchPayout = (f: Fetcher, payoutId: string, txnId: string) =>
  send<{ payoutId: string; entryId: string }>(f, opsPaths.payouts, 'POST', { action: 'match', payoutId, txnId })

// ── Dates ──────────────────────────────────────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, '0')
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate()

/** The calendar month before `today`'s (YYYY-MM-DD, local): the default period to enter. */
export function previousMonth(today: string): { start: string; end: string } {
  const [y, m] = today.split('-').map(Number)
  const py = m === 1 ? y - 1 : y
  const pm = m === 1 ? 12 : m - 1
  return { start: `${py}-${pad(pm)}-01`, end: `${py}-${pad(pm)}-${pad(lastDay(py, pm))}` }
}

/** The twelve months ending with `today`'s: the default range of the entered-periods table. */
export function lastTwelveMonths(today: string): { from: string; to: string } {
  const [y, m] = today.split('-').map(Number)
  const fy = m === 12 ? y : y - 1
  const fm = m === 12 ? 1 : m + 1
  return { from: `${fy}-${pad(fm)}-01`, to: `${y}-${pad(m)}-${pad(lastDay(y, m))}` }
}

// ── The entry form ─────────────────────────────────────────────────────────────────────────────

/** One asset's row in the entry form, as typed. Rented hours OR utilization; the other is derived. */
export interface EntryRow {
  assetId: string
  assetName: string
  gpuCount: number
  basis: 'hours' | 'utilization'
  rentedHours: string
  utilizationPct: string
  gross: string
  /** Blank is 0: no account fee rate exists to default from. */
  fee: string
  /** Blank is gross − fee, worked out here; typed, it must equal that to the cent. */
  net: string
  downtimeHours: string
  note: string
}

export const entryRowFor = (a: { id: string; name: string; gpu_count: number }): EntryRow => ({
  assetId: a.id, assetName: a.name, gpuCount: a.gpu_count, basis: 'hours',
  rentedHours: '', utilizationPct: '', gross: '', fee: '', net: '', downtimeHours: '', note: '',
})

/** The ManualRow the import route reads (parseManualRows: snake_case, numbers as numbers). */
export interface ManualRowBody {
  assetId: string
  period_start: string
  period_end: string
  rented_hours?: number
  utilization_pct?: number
  gross: number
  fee: number
  net: number
  downtime_hours?: number
  note?: string
}

const cents = (n: number) => Math.round(n * 100)
const round4 = (n: number) => Math.round(n * 10_000) / 10_000
/** A figure as typed: blank is null; commas and $ allowed; anything else is NaN. */
export function figure(s: string): number | null {
  const t = s.replace(/[$,\s]/g, '')
  return t === '' ? null : Number(t)
}

/** GPU-hours a server can be rented in the period: GPUs × 24 × days (match.ts's capacity). */
export const capacityHours = (gpuCount: number, start: string, end: string) => gpuCount * 24 * daysInclusive(start, end)

/** The figure not typed, as the server will derive it; null while the typed one is not a number. */
export function derived(row: EntryRow, start: string, end: string): { rentedHours: number | null; utilizationPct: number | null } {
  const cap = capacityHours(row.gpuCount, start, end)
  if (cap <= 0) return { rentedHours: null, utilizationPct: null }
  if (row.basis === 'hours') {
    const h = figure(row.rentedHours)
    return { rentedHours: h, utilizationPct: h == null || !Number.isFinite(h) ? null : round4((h / cap) * 100) }
  }
  const u = figure(row.utilizationPct)
  return { utilizationPct: u, rentedHours: u == null || !Number.isFinite(u) ? null : round4((u / 100) * cap) }
}

/** gross − fee to the cent, as the net the row will send when net is left blank; null until both are numbers. */
export function autoNet(row: Pick<EntryRow, 'gross' | 'fee'>): number | null {
  const g = figure(row.gross)
  const f = figure(row.fee) ?? 0
  return g == null || !Number.isFinite(g) || !Number.isFinite(f) ? null : (cents(g) - cents(f)) / 100
}

/** A row the operator left empty: nothing entered for that server this period, so nothing is sent. */
export const isBlankRow = (r: EntryRow) =>
  [r.rentedHours, r.utilizationPct, r.gross, r.fee, r.net, r.downtimeHours, r.note].every(v => v.trim() === '')

/**
 * The import body from the form: one ManualRow per row with anything in it. The rules parseManualRows
 * applies are checked here first, so a bad row is named on the page before any request: exactly one
 * of rented hours and utilization, no negative figure, gross present, fee no more than gross, and
 * gross − fee = net to the cent.
 */
export function manualRowsBody(period: { start: string; end: string }, rows: EntryRow[]): { ok: true; rows: ManualRowBody[] } | { ok: false; errors: string[] } {
  const errors: string[] = []
  if (!/^\d{4}-\d{2}-\d{2}$/.test(period.start) || !/^\d{4}-\d{2}-\d{2}$/.test(period.end)) errors.push('Pick the period start and end.')
  else if (period.end < period.start) errors.push('The period ends before it starts.')
  const out: ManualRowBody[] = []
  for (const r of rows) {
    if (isBlankRow(r)) continue
    const fail = (m: string) => { errors.push(`${r.assetName}: ${m}`) }
    const nums: Record<string, number | null> = {
      rented_hours: figure(r.rentedHours), utilization_pct: figure(r.utilizationPct),
      gross: figure(r.gross), fee: figure(r.fee), net: figure(r.net), downtime_hours: figure(r.downtimeHours),
    }
    const bad = Object.entries(nums).find(([, v]) => v != null && (!Number.isFinite(v) || v < 0))
    if (bad) { fail(`${bad[0].replace('_', ' ')} must be a number, 0 or more.`); continue }
    const typed = r.basis === 'hours' ? nums.rented_hours : nums.utilization_pct
    const other = r.basis === 'hours' ? nums.utilization_pct : nums.rented_hours
    if (typed == null || other != null) { fail('enter exactly one of rented GPU-hours and utilization %.'); continue }
    if (nums.utilization_pct != null && nums.utilization_pct > 100) { fail('utilization cannot be more than 100%.'); continue }
    if (nums.gross == null) { fail('gross revenue is required.'); continue }
    const fee = nums.fee ?? 0
    if (cents(fee) > cents(nums.gross)) { fail('the fee is more than gross revenue.'); continue }
    const want = (cents(nums.gross) - cents(fee)) / 100
    const net = nums.net ?? want
    if (cents(net) !== cents(want)) { fail(`gross less fee is ${want.toFixed(2)}, not net ${net.toFixed(2)}.`); continue }
    out.push({
      assetId: r.assetId,
      period_start: period.start,
      period_end: period.end,
      ...(r.basis === 'hours' ? { rented_hours: typed } : { utilization_pct: typed }),
      gross: cents(nums.gross) / 100,
      fee: cents(fee) / 100,
      net: cents(net) / 100,
      ...(nums.downtime_hours != null ? { downtime_hours: nums.downtime_hours } : {}),
      ...(r.note.trim() ? { note: r.note.trim() } : {}),
    })
  }
  if (errors.length) return { ok: false, errors }
  if (out.length === 0) return { ok: false, errors: ['Nothing to stage: enter figures for at least one server.'] }
  return { ok: true, rows: out }
}

/** Stage the form's rows: checked here first, so a bad row never leaves the page; then the route. */
export async function stageRows(f: Fetcher, period: { start: string; end: string }, rows: EntryRow[]):
  Promise<{ ok: true; data: ImportReply } | { ok: false; errors: string[] }> {
  const req = manualRowsBody(period, rows)
  if (!req.ok) return req
  const r = await importRows(f, req.rows)
  return r.ok ? r : { ok: false, errors: [r.error] }
}

// ── Payouts ────────────────────────────────────────────────────────────────────────────────────

export interface PayoutBody { date: string; amount: number; reference?: string; note?: string }

export function payoutBody(f: { date: string; amount: string; reference: string; note: string }): { ok: true; body: PayoutBody } | { ok: false; error: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date)) return { ok: false, error: 'Pick the payout date.' }
  const amount = figure(f.amount)
  if (amount == null || !Number.isFinite(amount) || cents(amount) <= 0) return { ok: false, error: 'Enter the payout amount, more than 0.' }
  return {
    ok: true,
    body: { date: f.date, amount: cents(amount) / 100, ...(f.reference.trim() ? { reference: f.reference.trim() } : {}), ...(f.note.trim() ? { note: f.note.trim() } : {}) },
  }
}

// ── Statuses ───────────────────────────────────────────────────────────────────────────────────

/** posting and reversing are claims held while a request books the row: in progress, never actionable. */
export const BUSY_STATUSES: readonly string[] = ['posting', 'reversing', 'matching']

export const EARNING_STATUS_LABEL: Record<EarningStatus, string> = {
  staged: 'Staged', unmatched: 'Unmatched', posting: 'Posting…', posted: 'Posted', ignored: 'Ignored', reversing: 'Reversing…', reversed: 'Reversed',
}

/** Design tokens per status: info, warning, success, muted; in progress is muted with a spinner. */
export const EARNING_STATUS_TONE: Record<EarningStatus, string> = {
  staged: 'bg-info-subtle text-info',
  unmatched: 'bg-warning-subtle text-warning',
  posting: 'bg-muted text-muted-foreground',
  posted: 'bg-success-subtle text-success',
  ignored: 'bg-muted text-muted-foreground',
  reversing: 'bg-muted text-muted-foreground',
  reversed: 'bg-muted text-muted-foreground',
}

export const PAYOUT_STATUS_LABEL: Record<PayoutStatus, string> = { expected: 'Expected', matching: 'Matching…', matched: 'Matched' }

/** Which rows can be selected for Post or Ignore: staged or unmatched (ignore only for unmatched). */
export const selectable = (r: Pick<EarningView, 'status'>) => r.status === 'staged' || r.status === 'unmatched'

/** The table's grouping: by period (newest first), then by server name, as the route sorts them. */
export function groupByPeriod(rows: EarningView[]): { period: string; start: string; end: string; rows: EarningView[] }[] {
  const out: { period: string; start: string; end: string; rows: EarningView[] }[] = []
  for (const r of rows) {
    const key = `${r.periodStart}..${r.periodEnd}`
    const last = out[out.length - 1]
    if (last && last.period === key) last.rows.push(r)
    else out.push({ period: key, start: r.periodStart, end: r.periodEnd, rows: [r] })
  }
  return out
}

/** The caption a KPI carries when entered-but-unposted rows count toward it. */
export const STAGED_CAPTION = 'includes staged rows'
export const kpiCaption = (k: Pick<Kpi, 'includesStaged'> | null | undefined, base?: string) =>
  [base, k?.includesStaged ? STAGED_CAPTION : null].filter(Boolean).join('; ') || undefined

/** Several vehicles' LTM KPIs as one: sums, and utilization recomputed from the summed hours. */
export function combineLtm(kpis: Kpi[]): { grossRevenue: number; utilizationPct: number | null; includesStaged: boolean } {
  const gross = kpis.reduce((t, k) => t + cents(k.grossRevenue), 0) / 100
  const rented = kpis.reduce((t, k) => t + k.rentedHours, 0)
  const available = kpis.reduce((t, k) => t + k.availableHours, 0)
  return { grossRevenue: gross, utilizationPct: available > 0 ? round4((rented / available) * 100) : null, includesStaged: kpis.some(k => k.includesStaged) }
}
