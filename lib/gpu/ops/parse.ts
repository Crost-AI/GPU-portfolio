// Parse manual GPU operations entry — a form's rows or a CSV paste — into one shape. Pure.
//
// Decision Q1: there is no marketplace integration, so these are the only two sources. Each row is
// one asset for one period. Exactly one of rented hours / utilization % is given; the other needs
// the asset's GPU count, so it is derived when the row is matched (match.ts), not here.

import { normalizeDate, parseAmount, pickDelim, splitLine, splitRecords } from '@/lib/accounting/bank'

/** The CSV columns, in order. A header row is optional. */
export const EARNINGS_CSV_COLUMNS = [
  'asset', 'period_start', 'period_end', 'rented_hours', 'utilization_pct', 'gross', 'fee', 'net', 'downtime_hours', 'note',
] as const

/** One row as a form sends it. Numbers may arrive as numbers or strings. */
export interface ManualRow {
  asset?: unknown
  /** The form's asset picker sends the id; `asset` (a name, serial or id) wins when both are given. */
  assetId?: unknown
  period_start?: unknown
  period_end?: unknown
  rented_hours?: unknown
  utilization_pct?: unknown
  gross?: unknown
  fee?: unknown
  net?: unknown
  downtime_hours?: unknown
  note?: unknown
}

export interface ParsedEarning {
  /** 1-based position in the paste or the form, for error and skip messages. */
  line: number
  assetRef: string
  periodStart: string
  periodEnd: string
  /** Exactly one of these two is non-null. */
  rentedHours: number | null
  utilizationPct: number | null
  gross: number
  fee: number
  net: number
  downtimeHours: number
  note: string | null
  raw: Record<string, string>
}

export interface ParseOutcome {
  rows: ParsedEarning[]
  errors: string[]
}

const cents = (n: number) => Math.round(n * 100)
const text = (v: unknown) => (v == null ? '' : String(v).trim())

/** A blank cell is null; anything else must be a number, or the row is refused. */
function amount(v: string, field: string): { value: number | null } | { error: string } {
  if (v === '') return { value: null }
  const n = parseAmount(v)
  if (n == null || !Number.isFinite(n)) return { error: `${field} "${v}" is not a number` }
  if (n < 0) return { error: `${field} cannot be negative` }
  return { value: n }
}

function parseOne(line: number, cells: Record<string, string>): ParsedEarning | { error: string } {
  const fail = (m: string) => ({ error: `Row ${line}: ${m}` })
  const assetRef = cells.asset ?? ''
  if (!assetRef) return fail('asset is required')
  const periodStart = normalizeDate(cells.period_start ?? '')
  const periodEnd = normalizeDate(cells.period_end ?? '')
  if (!periodStart) return fail('period_start must be a date (YYYY-MM-DD or M/D/YYYY)')
  if (!periodEnd) return fail('period_end must be a date (YYYY-MM-DD or M/D/YYYY)')
  if (periodEnd < periodStart) return fail('period_end is before period_start')

  const nums: Record<string, number | null> = {}
  for (const k of ['rented_hours', 'utilization_pct', 'gross', 'fee', 'net', 'downtime_hours']) {
    const r = amount(cells[k] ?? '', k)
    if ('error' in r) return fail(r.error)
    nums[k] = r.value
  }
  const given = [nums.rented_hours, nums.utilization_pct].filter(v => v != null).length
  if (given !== 1) return fail('give exactly one of rented_hours and utilization_pct')
  if (nums.utilization_pct != null && nums.utilization_pct > 100) return fail('utilization_pct cannot be more than 100')
  if (nums.gross == null) return fail('gross is required')
  const fee = nums.fee ?? 0
  const net = nums.net ?? (cents(nums.gross) - cents(fee)) / 100
  if (cents(nums.gross) - cents(fee) !== cents(net)) {
    return fail(`gross ${nums.gross} less fee ${fee} is ${(cents(nums.gross) - cents(fee)) / 100}, not net ${net}`)
  }
  return {
    line, assetRef, periodStart, periodEnd,
    rentedHours: nums.rented_hours, utilizationPct: nums.utilization_pct,
    gross: nums.gross, fee, net, downtimeHours: nums.downtime_hours ?? 0,
    note: cells.note ? cells.note : null,
    raw: cells,
  }
}

function collect(rows: { line: number; cells: Record<string, string> }[]): ParseOutcome {
  const out: ParseOutcome = { rows: [], errors: [] }
  for (const r of rows) {
    const parsed = parseOne(r.line, r.cells)
    if ('error' in parsed) out.errors.push(parsed.error)
    else out.rows.push(parsed)
  }
  return out
}

/** Rows from the entry form. */
export function parseManualRows(rows: ManualRow[]): ParseOutcome {
  if (!Array.isArray(rows)) return { rows: [], errors: ['rows must be a list'] }
  return collect(rows.map((r, i) => ({
    line: i + 1,
    cells: Object.fromEntries(EARNINGS_CSV_COLUMNS.map(c => [c, text(c === 'asset' ? (r?.asset ?? r?.assetId) : (r ?? {})[c])])),
  })))
}

/**
 * A CSV, TSV or semicolon paste in EARNINGS_CSV_COLUMNS order. The first record is a header when its
 * period_start cell is not a date. Fields may be quoted; a quoted field may hold the delimiter.
 */
export function parseEarningsCsv(csv: string): ParseOutcome {
  const records = splitRecords(csv ?? '')
  if (records.length === 0) return { rows: [], errors: ['Nothing to import'] }
  const delim = pickDelim(records[0])
  const lines = records.map((r, i) => ({ line: i + 1, fields: splitLine(r, delim) }))
  const body = normalizeDate(lines[0].fields[1] ?? '') ? lines : lines.slice(1)
  if (body.length === 0) return { rows: [], errors: ['Nothing to import: only a header row'] }
  return collect(body.map(l => ({
    line: l.line,
    cells: Object.fromEntries(EARNINGS_CSV_COLUMNS.map((c, i) => [c, l.fields[i] ?? ''])),
  })))
}
