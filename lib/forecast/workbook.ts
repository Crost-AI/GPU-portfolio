// The forecast as an Excel model: the same numbers the page shows, written so the workbook still
// works once it leaves the app.
//
// - Totals, net income and the cash roll-forward are formulas, never pasted results, so a changed
//   cell flows through.
// - Every forecast month a rule produced is a formula over that rule's row on the Assumptions sheet
//   (amount, growth or escalation, seasonal profile). Change an assumption and the plan moves.
// - A cell is a formula only when the formula reproduces the app's number to the cent. Anything the
//   rule alone doesn't explain — an override, a hand edit, a linked fee, an investment's entries —
//   stays the app's value, so the workbook opens on exactly what the page shows.
// - Quarterly and annual sheets are SUMs of the monthly one, not a second copy of the numbers.
//
// Pure: takes what lib/forecast/service.ts returns. Text from the app (account names, notes) is only
// ever a string cell — nothing user-entered reaches a formula.

import * as XLSX from 'xlsx'
import { roundCents } from '@/lib/accounting/ledger'
import { monthDiff, parseMonth, type Interval, type MonthKey } from './months'
import type { FixedParams, GrowthParams, ManagementFeeParams, RecurringParams, RuleMethod, SeasonalParams } from './rules'
import type { CashSection } from './report'
import type { RuleView, SeriesResult, VarianceResponse } from './service'
import type { VarianceCell } from './variance'

/** Accounting format — thousands, two decimals, negatives in parentheses. */
const NUM = '#,##0.00;(#,##0.00)'
const PCT = '0.00%'
const RATE = '0.00%'

export interface ForecastWorkbookMeta {
  fundName: string
  /** ISO timestamp the file was generated (the route supplies it — kept out of pure code). */
  generatedAt: string
}

export interface ForecastWorkbookInput {
  /** The series at MONTHLY interval — the grain every formula is written at. */
  monthly: SeriesResult
  rules: RuleView[]
  accounts: { id: string; code: string; name: string }[]
  /** The interval the person was looking at; a quarterly or annual sheet is added on top. */
  interval: Interval
  meta: ForecastWorkbookMeta
}

// ---------------------------------------------------------------------------------------------
// A small grid: cells by row/column, each a value, a formula with its cached value, or blank.
// ---------------------------------------------------------------------------------------------

type Val = string | number | null
interface Cell { v: Val; f?: string; z?: string }

const col = (c: number) => XLSX.utils.encode_col(c)
const ref = (r: number, c: number) => `${col(c)}${r + 1}`
const absRef = (sheet: string, r: number, c: number) => `${sheet}!$${col(c)}$${r + 1}`
const money = (v: number | null | undefined): Cell => ({ v: v == null ? null : roundCents(v), z: NUM })
const formula = (f: string, v: number | null, z = NUM): Cell => ({ v: v == null ? null : roundCents(v), f, z })

class Grid {
  private cells = new Map<string, XLSX.CellObject>()
  private maxR = 0
  private maxC = 0

  set(r: number, c: number, cell: Val | Cell) {
    const x: Cell = cell !== null && typeof cell === 'object' ? cell : { v: cell }
    this.maxR = Math.max(this.maxR, r)
    this.maxC = Math.max(this.maxC, c)
    if (x.f) {
      // A cached value goes with every formula, so a viewer that doesn't recalculate still shows it.
      this.cells.set(ref(r, c), { t: 'n', v: typeof x.v === 'number' ? x.v : 0, f: x.f, ...(x.z ? { z: x.z } : {}) })
      return
    }
    if (x.v === null || x.v === '') return
    this.cells.set(ref(r, c), typeof x.v === 'number'
      ? { t: 'n', v: x.v, ...(x.z ? { z: x.z } : {}) }
      : { t: 's', v: x.v })
  }

  row(r: number, values: (Val | Cell)[], from = 0) {
    values.forEach((v, i) => this.set(r, from + i, v))
  }

  toSheet(widths: number[], freeze?: { r: number; c: number }): XLSX.WorkSheet {
    const ws: XLSX.WorkSheet = {}
    for (const [k, v] of this.cells) ws[k] = v
    ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: this.maxR, c: Math.max(this.maxC, widths.length - 1) } })
    ws['!cols'] = widths.map(wch => ({ wch }))
    if (freeze) {
      // SheetJS writes a frozen pane from the sheet view's split.
      ;(ws as any)['!views'] = [{ state: 'frozen', xSplit: freeze.c, ySplit: freeze.r }]
    }
    return ws
  }
}

/** SUM over a set of rows in one column, as compact ranges: SUM(C5:C9,C12). */
function sumRows(rows: number[], c: number): string {
  if (!rows.length) return '0'
  const sorted = [...rows].sort((a, b) => a - b)
  const parts: string[] = []
  let start = sorted[0]
  let prev = sorted[0]
  for (const r of [...sorted.slice(1), Number.NaN]) {
    if (r === prev + 1) { prev = r; continue }
    parts.push(start === prev ? ref(start, c) : `${ref(start, c)}:${ref(prev, c)}`)
    start = r
    prev = r
  }
  return `SUM(${parts.join(',')})`
}

const sum = (xs: number[]) => roundCents(xs.reduce((s, x) => s + x, 0))

// ---------------------------------------------------------------------------------------------
// Assumptions: one row per rule, the editable drivers in fixed columns.
// ---------------------------------------------------------------------------------------------

const ASSUMPTIONS = 'Assumptions'
const A = { code: 0, account: 1, method: 2, basis: 3, amount: 4, rate: 5, every: 6, anchor: 7, from: 8, to: 9, timing: 10, note: 11, profile: 12 }
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const METHOD_LABEL: Record<RuleMethod, string> = {
  manual: 'Entered by month',
  fixed: 'Fixed monthly',
  recurring: 'Recurring',
  run_rate: 'Run rate',
  growth: 'Growth',
  seasonal: 'Seasonal',
  linked_fee: 'Linked fee',
  linked_construction: 'Portfolio construction',
  management_fee: 'Management fee',
}

/** How a rule's amount for one month is written as a formula, and what that formula evaluates to. */
interface RuleCellFormula { f: string; v: number }

interface PlacedRule {
  rule: RuleView
  row: number
  /** The formula for a month, or null when the rule says nothing about that month. */
  at: (m: MonthKey) => RuleCellFormula | null
}

const inWindow = (m: MonthKey, start?: MonthKey, end?: MonthKey) => (!start || m >= start) && (!end || m <= end)

/** The run-rate's monthly amount: what the plan holds in most of its forecast months. */
function modalForecastValue(values: number[]): number | null {
  const counts = new Map<number, number>()
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1)
  let best: number | null = null
  for (const [v, n] of counts) if (best === null || n > counts.get(best)!) best = v
  return best
}

function assumptionsSheet(
  rules: RuleView[],
  names: Map<string, { code: string; name: string }>,
  forecastValuesByAccount: Map<string, number[]>,
  basisByAccount: SeriesResult['sources'],
): { ws: XLSX.WorkSheet; placed: Map<string, PlacedRule> } {
  const g = new Grid()
  g.set(0, 0, 'Assumptions')
  g.set(1, 0, 'The drivers behind each forecast line. Change an amount, rate or seasonal month here and the forecast sheets recalculate.')
  g.set(2, 0, 'Rows marked "Value from the app" are not driven from here: their months carry the app’s numbers.')
  const head = 4
  g.row(head, ['Code', 'Account', 'Method', 'How it’s worked out', 'Amount', 'Rate', 'Every (months)', 'Anchor / base month', 'From', 'To', 'Cash timing', 'Note', ...MONTHS])

  const placed = new Map<string, PlacedRule>()
  const sorted = [...rules].sort((a, b) => (names.get(a.accountId)?.code ?? '').localeCompare(names.get(b.accountId)?.code ?? ''))
  sorted.forEach((rule, i) => {
    const r = head + 1 + i
    const acct = names.get(rule.accountId)
    const basis = basisByAccount[rule.accountId]?.basis ?? METHOD_LABEL[rule.method]
    g.row(r, [acct?.code ?? '', acct?.name ?? '(account no longer in the chart)', METHOD_LABEL[rule.method] ?? rule.method, basis])
    g.set(r, A.timing, timingLabel(rule.cashTiming))
    if (rule.note) g.set(r, A.note, rule.note)
    const amt = absRef(ASSUMPTIONS, r, A.amount)
    const rate = absRef(ASSUMPTIONS, r, A.rate)
    let at: PlacedRule['at'] = () => null

    switch (rule.method) {
      case 'fixed': {
        const p = rule.params as FixedParams
        g.set(r, A.amount, money(p.amount))
        g.set(r, A.from, p.start ?? null)
        g.set(r, A.to, p.end ?? null)
        at = m => (inWindow(m, p.start, p.end) ? { f: amt, v: p.amount } : null)
        break
      }
      case 'recurring': {
        const p = rule.params as RecurringParams
        const esc = p.annualEscalation ?? 0
        g.set(r, A.amount, money(p.amount))
        g.set(r, A.rate, { v: esc, z: RATE })
        g.set(r, A.every, p.everyMonths)
        g.set(r, A.anchor, p.anchor)
        g.set(r, A.from, p.start ?? null)
        g.set(r, A.to, p.end ?? null)
        const skip = new Set(p.exceptions ?? [])
        at = m => {
          if (!inWindow(m, p.start, p.end)) return null
          const offset = monthDiff(p.anchor, m)
          const oneOff = (p.oneOffs ?? []).filter(o => o.month === m).reduce((s, o) => s + o.amount, 0)
          if (offset % p.everyMonths !== 0 || skip.has(m)) return null
          const years = Math.max(0, Math.floor(offset / 12))
          const extra = oneOff ? `${oneOff > 0 ? '+' : '-'}${Math.abs(oneOff)}` : ''
          return { f: `ROUND(${amt}*(1+${rate})^${years}${extra},2)`, v: roundCents(p.amount * Math.pow(1 + esc, years) + oneOff) }
        }
        break
      }
      case 'growth': {
        const p = rule.params as GrowthParams
        g.set(r, A.amount, money(p.base))
        g.set(r, A.rate, { v: p.rate, z: RATE })
        g.set(r, A.every, p.per === 'month' ? 1 : 12)
        g.set(r, A.anchor, p.baseMonth)
        at = m => {
          const d = monthDiff(p.baseMonth, m)
          if (d < 0) return null
          const steps = p.per === 'month' ? d : Math.floor(d / 12)
          return { f: `ROUND(${amt}*(1+${rate})^${steps},2)`, v: roundCents(p.base * Math.pow(1 + p.rate, steps)) }
        }
        break
      }
      case 'seasonal': {
        const p = rule.params as SeasonalParams
        const growth = p.annualGrowth ?? 0
        g.set(r, A.rate, { v: growth, z: RATE })
        g.set(r, A.anchor, p.anchor)
        MONTHS.forEach((_, k) => g.set(r, A.profile + k, money(p.profile[String(k + 1)] ?? 0)))
        at = m => {
          const month = parseMonth(m).month
          const base = p.profile[String(month)]
          if (!base) return null
          const years = Math.max(0, Math.floor(monthDiff(p.anchor, m) / 12))
          const cell = absRef(ASSUMPTIONS, r, A.profile + month - 1)
          return { f: `ROUND(${cell}*(1+${rate})^${years},2)`, v: roundCents(base * Math.pow(1 + growth, years)) }
        }
        break
      }
      case 'run_rate': {
        // The average itself is history; the workbook carries the figure it came to as the driver.
        const driver = modalForecastValue(forecastValuesByAccount.get(rule.accountId) ?? [])
        if (driver != null) {
          g.set(r, A.amount, money(driver))
          at = () => ({ f: amt, v: driver })
        }
        break
      }
      case 'management_fee': {
        const p = rule.params as ManagementFeeParams
        g.set(r, A.rate, { v: p.rate, z: RATE })
        g.set(r, A.every, null)
        g.set(r, A.note, [rule.note, 'Value from the app: the fee depends on commitments and deployment.'].filter(Boolean).join(' '))
        break
      }
      default:
        g.set(r, A.note, [rule.note, 'Value from the app.'].filter(Boolean).join(' '))
    }
    placed.set(rule.accountId, { rule, row: r, at })
  })
  if (!sorted.length) g.set(head + 1, 0, 'This view has no plan rules — every number is from the ledger or the plan as compiled.')
  return { ws: g.toSheet([10, 32, 20, 48, 14, 9, 9, 12, 10, 10, 18, 40, ...MONTHS.map(() => 11)], { r: head + 1, c: 2 }), placed }
}

function timingLabel(t: RuleView['cashTiming']): string {
  if (!t || typeof t !== 'object') return ''
  const x = t as Record<string, unknown>
  return typeof x.kind === 'string' ? x.kind.replace(/_/g, ' ') + (typeof x.months === 'number' ? ` (${x.months})` : '') : ''
}

// ---------------------------------------------------------------------------------------------
// The statement layout, shared by the monthly sheet and its quarterly / annual roll-ups.
// ---------------------------------------------------------------------------------------------

type RowKind =
  | { kind: 'line'; values: (number | null)[]; accountId?: string; flow: true }
  | { kind: 'sum'; of: number[] }
  | { kind: 'diff'; plus: number; minus: number }
  | { kind: 'opening'; values: (number | null)[] }
  | { kind: 'ending'; opening: number; movement: number }
  | { kind: 'balance'; values: (number | null)[] }
  | { kind: 'heading' }
  | { kind: 'blank' }

interface LayoutRow { label: string; code?: string; row: RowKind }

const STATUS_LABEL: Record<string, string> = {
  actual: 'Actual', actual_unclosed: 'Actual (open)', forecast: 'Forecast', mixed: 'Actual + forecast', none: 'No data',
}

const SECTION_LABEL: Record<CashSection, string> = { operating: 'Operating activities', investing: 'Investing activities', financing: 'Financing activities' }

/** The rows of the statement, in order, with each total pointing at the rows it adds up. */
function layout(s: SeriesResult, firstRow: number): { rows: LayoutRow[]; unreconciled: boolean } {
  const rows: LayoutRow[] = []
  const at = () => firstRow + rows.length
  const push = (r: LayoutRow) => { const i = at(); rows.push(r); return i }
  const flow = (label: string, values: (number | null)[], code?: string, accountId?: string) =>
    push({ label, code, row: { kind: 'line', values, accountId, flow: true } })

  push({ label: 'Revenue', row: { kind: 'heading' } })
  const income = s.lines.filter(l => l.type === 'income').map(l => flow(l.name, l.values, l.code, l.accountId))
  const revenue = push({ label: 'Total revenue', row: { kind: 'sum', of: income } })
  push({ label: '', row: { kind: 'blank' } })
  push({ label: 'Expenses', row: { kind: 'heading' } })
  const expense = s.lines.filter(l => l.type === 'expense').map(l => flow(l.name, l.values, l.code, l.accountId))
  const expenses = push({ label: 'Total expenses', row: { kind: 'sum', of: expense } })
  push({ label: '', row: { kind: 'blank' } })
  push({ label: 'Net income', row: { kind: 'diff', plus: revenue, minus: expenses } })
  push({ label: '', row: { kind: 'blank' } })

  push({ label: 'Cash flow', row: { kind: 'heading' } })
  const opening = push({ label: 'Opening cash', row: { kind: 'opening', values: s.cash.map(c => c?.opening ?? null) } })
  const subtotals: number[] = []
  const detail = s.cashDetail ?? []
  for (const section of ['operating', 'investing', 'financing'] as const) {
    const lines = detail.filter(l => l.section === section)
    if (!lines.length) continue
    push({ label: SECTION_LABEL[section], row: { kind: 'heading' } })
    const own: number[] = []
    for (const l of lines) {
      // A breakdown line sits under its parent and is not added again.
      const r = flow(l.parent ? `   of which: ${l.label}` : l.label, l.values, l.code ?? undefined)
      if (!l.parent) own.push(r)
    }
    subtotals.push(push({ label: `Net cash from ${section} activities`, row: { kind: 'sum', of: own } }))
  }
  // The statement's lines re-add to the movement. Should a period ever not, the gap is a row of
  // its own rather than a silently wrong ending balance.
  const gap = s.periods.map((_, i) => {
    const c = s.cash[i]
    if (!c) return null
    const lines = detail.filter(l => !l.parent).reduce((t, l) => t + (l.values[i] ?? 0), 0)
    return roundCents(c.movement - lines)
  })
  const unreconciled = gap.some(g => g != null && Math.abs(g) >= 0.01)
  if (unreconciled) subtotals.push(flow('Other cash movement (not classified)', gap))
  const movement = push({ label: 'Net cash movement', row: { kind: 'sum', of: subtotals } })
  push({ label: 'Ending cash', row: { kind: 'ending', opening, movement } })
  if (s.cashAccounts.length > 1) {
    push({ label: '', row: { kind: 'blank' } })
    push({ label: 'Ending balance by cash account', row: { kind: 'heading' } })
    for (const a of s.cashAccounts) push({ label: a.name, code: a.code, row: { kind: 'balance', values: a.ending } })
  }
  return { rows, unreconciled }
}

const HEAD_ROW = 4 // period labels
const STATUS_ROW = 5
const FIRST_ROW = 7
const FIRST_COL = 2

interface StatementSheet {
  ws: XLSX.WorkSheet
  rows: LayoutRow[]
  /** Cached values by sheet row and column, for the sheets that roll this one up. */
  values: Map<string, number | null>
  totalCol: number
}

/**
 * Write the statement. `cellFor` supplies a flow line's cell for a column (the monthly sheet's
 * values and rule formulas, or a roll-up's SUM of monthly columns); everything else is formulas
 * within the sheet.
 */
function statementSheet(opts: {
  title: string
  subtitle: string
  periods: { label: string; status: string; hasData: boolean }[]
  rows: LayoutRow[]
  cellFor: (row: LayoutRow, rowIndex: number, i: number) => Cell | null
  openingFor: (rowIndex: number, i: number) => Cell | null
  balanceFor: (row: LayoutRow, rowIndex: number, i: number) => Cell | null
}): StatementSheet {
  const g = new Grid()
  const n = opts.periods.length
  const totalCol = FIRST_COL + n
  const values = new Map<string, number | null>()
  const put = (r: number, c: number, cell: Cell | null) => {
    if (!cell) return
    g.set(r, c, cell)
    values.set(ref(r, c), typeof cell.v === 'number' ? cell.v : null)
  }
  const val = (r: number, c: number) => values.get(ref(r, c)) ?? 0

  g.set(0, 0, opts.title)
  g.set(1, 0, opts.subtitle)
  g.row(HEAD_ROW, ['Code', 'Account', ...opts.periods.map(p => p.label), 'Total'])
  g.row(STATUS_ROW, ['', 'Status', ...opts.periods.map(p => STATUS_LABEL[p.status] ?? p.status)])

  const dataCols = opts.periods.map((p, i) => (p.hasData ? FIRST_COL + i : -1)).filter(c => c >= 0)
  opts.rows.forEach((lr, k) => {
    const r = FIRST_ROW + k
    if (lr.code) g.set(r, 0, lr.code)
    g.set(r, 1, lr.label)
    const row = lr.row
    if (row.kind === 'heading' || row.kind === 'blank') return

    for (let i = 0; i < n; i++) {
      const c = FIRST_COL + i
      if (!opts.periods[i].hasData) continue
      switch (row.kind) {
        case 'line': put(r, c, opts.cellFor(lr, r, i)); break
        case 'sum': put(r, c, formula(sumRows(row.of, c), sum(row.of.map(x => val(x, c))))); break
        case 'diff': put(r, c, formula(`${ref(row.plus, c)}-${ref(row.minus, c)}`, val(row.plus, c) - val(row.minus, c))); break
        case 'opening': put(r, c, opts.openingFor(r, i)); break
        case 'ending': put(r, c, formula(`${ref(row.opening, c)}+${ref(row.movement, c)}`, val(row.opening, c) + val(row.movement, c))); break
        case 'balance': put(r, c, opts.balanceFor(lr, r, i)); break
      }
    }

    // The range's total: flows add up; balances are the first opening and the last ending.
    if (!dataCols.length) return
    const first = dataCols[0]
    const last = dataCols[dataCols.length - 1]
    switch (row.kind) {
      case 'line':
        put(r, totalCol, formula(`SUM(${ref(r, FIRST_COL)}:${ref(r, totalCol - 1)})`, sum(dataCols.map(c => val(r, c)))))
        break
      case 'sum': put(r, totalCol, formula(sumRows(row.of, totalCol), sum(row.of.map(x => val(x, totalCol))))); break
      case 'diff': put(r, totalCol, formula(`${ref(row.plus, totalCol)}-${ref(row.minus, totalCol)}`, val(row.plus, totalCol) - val(row.minus, totalCol))); break
      case 'opening': put(r, totalCol, formula(ref(r, first), val(r, first))); break
      case 'ending': put(r, totalCol, formula(`${ref(row.opening, totalCol)}+${ref(row.movement, totalCol)}`, val(row.opening, totalCol) + val(row.movement, totalCol))); break
      case 'balance': put(r, totalCol, formula(ref(r, last), val(r, last))); break
    }
  })

  const ws = g.toSheet([10, 40, ...opts.periods.map(() => 14), 16], { r: STATUS_ROW + 1, c: FIRST_COL })
  return { ws, rows: opts.rows, values, totalCol }
}

// ---------------------------------------------------------------------------------------------
// The workbook
// ---------------------------------------------------------------------------------------------

const MONTHLY = 'Monthly'

export function buildForecastWorkbook(input: ForecastWorkbookInput): XLSX.WorkBook {
  const s = input.monthly
  const names = new Map(input.accounts.map(a => [a.id, { code: a.code, name: a.name }]))
  for (const l of s.lines) if (!names.has(l.accountId)) names.set(l.accountId, { code: l.code, name: l.name })

  const isForecast = s.periods.map(p => p.status === 'forecast')
  const forecastValues = new Map<string, number[]>()
  for (const l of s.lines) forecastValues.set(l.accountId, l.values.filter((_, i) => isForecast[i]))
  const { ws: assumptions, placed } = assumptionsSheet(input.rules, names, forecastValues, s.sources)

  const { rows, unreconciled } = layout(s, FIRST_ROW)
  const monthOf = (i: number) => s.periods[i].months[0]
  let formulaCells = 0
  let valueCells = 0

  const monthly = statementSheet({
    title: `${s.vehicle} — ${planLabel(s)}`,
    subtitle: `Monthly, ${s.currency}. Formulas: totals, net income, the cash roll-forward, and forecast months driven by the Assumptions sheet.`,
    periods: s.periods.map(p => ({ label: p.label, status: p.status, hasData: p.status !== 'none' })),
    rows,
    cellFor: (lr, _r, i) => {
      if (lr.row.kind !== 'line') return null
      const value = lr.row.values[i] ?? 0
      const rule = lr.row.accountId ? placed.get(lr.row.accountId) : undefined
      if (rule && isForecast[i]) {
        const f = rule.at(monthOf(i))
        // Only where the rule alone gives the app's number: an override or hand edit keeps its value.
        if (f && Math.abs(f.v - value) < 0.005) { formulaCells++; return formula(f.f, f.v) }
        if (isForecast[i] && value) valueCells++
      }
      return money(value)
    },
    openingFor: (r, i) => {
      const c = s.cash[i]
      if (!c) return null
      // Each month opens on the last one's ending — unless the last one had no data.
      if (i > 0 && s.cash[i - 1]) {
        const endingRow = FIRST_ROW + rows.findIndex(x => x.row.kind === 'ending')
        return formula(ref(endingRow, FIRST_COL + i - 1), c.opening)
      }
      return money(c.opening)
    },
    balanceFor: (lr, _r, i) => (lr.row.kind === 'balance' ? money(lr.row.values[i]) : null),
  })

  // The ending cash the formulas reach must be the app's. If it isn't, the workbook says so.
  const endingRow = FIRST_ROW + rows.findIndex(x => x.row.kind === 'ending')
  const drift = s.cash.some((c, i) => c && Math.abs((monthly.values.get(ref(endingRow, FIRST_COL + i)) ?? 0) - c.ending) >= 0.01)

  const wb = XLSX.utils.book_new()
  const notes = [...s.warnings]
  if (unreconciled) notes.push('Some cash moved in a way the cash-flow lines don’t classify; it is shown as "Other cash movement".')
  if (drift) notes.push('The cash roll-forward in this workbook does not tie to the app’s ending cash in every month. Treat the app as the record.')
  if (valueCells) notes.push(`${valueCells} forecast cell${valueCells === 1 ? ' carries' : 's carry'} the app’s value instead of a formula: an override, a hand edit, or an amount from a linked source.`)

  const rollup = input.interval !== 'month' ? rollupSheet(s, rows, monthly, input.interval) : null
  XLSX.utils.book_append_sheet(wb, summarySheet(s, input, rows, rollup ?? monthly, rollup ? (input.interval === 'quarter' ? 'Quarterly' : 'Annual') : MONTHLY, notes, formulaCells), 'Summary')
  if (rollup) XLSX.utils.book_append_sheet(wb, rollup.ws, input.interval === 'quarter' ? 'Quarterly' : 'Annual')
  XLSX.utils.book_append_sheet(wb, monthly.ws, MONTHLY)
  XLSX.utils.book_append_sheet(wb, assumptions, ASSUMPTIONS)
  return wb
}

/** Quarters or years, each a SUM of its months on the monthly sheet. */
function rollupSheet(s: SeriesResult, rows: LayoutRow[], monthly: StatementSheet, interval: Interval): StatementSheet {
  const groups: { label: string; cols: number[]; statuses: Set<string> }[] = []
  const key = (m: MonthKey) => {
    const { year, month } = parseMonth(m)
    return interval === 'quarter' ? `Q${Math.ceil(month / 3)} ${year}` : String(year)
  }
  s.periods.forEach((p, i) => {
    const k = key(p.months[0])
    let g = groups[groups.length - 1]
    if (!g || g.label !== k) { g = { label: k, cols: [], statuses: new Set() }; groups.push(g) }
    if (p.status !== 'none') { g.cols.push(FIRST_COL + i); g.statuses.add(p.status) }
  })
  const status = (st: Set<string>) => st.size === 0 ? 'none' : st.size === 1 ? [...st][0] : st.has('forecast') ? 'mixed' : 'actual_unclosed'
  const mv = (r: number, c: number) => monthly.values.get(ref(r, c)) ?? 0
  const span = (r: number, cols: number[]) => `${MONTHLY}!${ref(r, cols[0])}:${ref(r, cols[cols.length - 1])}`

  return statementSheet({
    title: `${s.vehicle} — ${planLabel(s)}`,
    subtitle: `${interval === 'quarter' ? 'Quarterly' : 'Annual'}, ${s.currency}. Each figure adds up the ${MONTHLY} sheet, so a change there flows here.`,
    periods: groups.map(g => ({ label: g.label, status: status(g.statuses), hasData: g.cols.length > 0 })),
    rows,
    cellFor: (_lr, r, i) => formula(`SUM(${span(r, groups[i].cols)})`, sum(groups[i].cols.map(c => mv(r, c)))),
    openingFor: (r, i) => formula(`${MONTHLY}!${ref(r, groups[i].cols[0])}`, mv(r, groups[i].cols[0])),
    balanceFor: (_lr, r, i) => {
      const last = groups[i].cols[groups[i].cols.length - 1]
      return formula(`${MONTHLY}!${ref(r, last)}`, mv(r, last))
    },
  })
}

function planLabel(s: SeriesResult): string {
  if (!s.plan) return 'Actuals'
  return `${s.plan.name}${s.version ? ` (version ${s.version.versionNo}, ${s.version.status})` : ' (draft)'}`
}

function summarySheet(
  s: SeriesResult, input: ForecastWorkbookInput, rows: LayoutRow[], sheet: StatementSheet, sheetName: string,
  notes: string[], formulaCells: number,
): XLSX.WorkSheet {
  const g = new Grid()
  const first = s.periods[0]
  const last = s.periods[s.periods.length - 1]
  g.set(0, 0, input.meta.fundName)
  g.set(1, 0, 'Forecast workbook')
  g.row(3, ['Entity', s.vehicle])
  g.row(4, ['Plan', planLabel(s)])
  g.row(5, ['View', s.view === 'combined' ? 'Actuals, then forecast' : s.view === 'plan' ? 'Plan only' : 'Actuals only'])
  g.row(6, ['Currency', s.currency])
  g.row(7, ['Range', first && last ? `${first.label} – ${last.label}` : ''])
  g.row(8, ['Actuals through', s.actualsThrough ?? '—'])
  g.row(9, ['Books closed through', s.closedThrough ?? '—'])
  g.row(10, ['Generated', input.meta.generatedAt])

  g.set(12, 0, 'For the range')
  const total = (kind: RowKind['kind'], label?: string) => {
    const k = rows.findIndex(x => x.row.kind === kind && (label === undefined || x.label === label))
    return k < 0 ? null : FIRST_ROW + k
  }
  const figures: [string, number | null][] = [
    ['Total revenue', total('sum', 'Total revenue')],
    ['Total expenses', total('sum', 'Total expenses')],
    ['Net income', total('diff')],
    ['Opening cash', total('opening')],
    ['Net cash movement', total('sum', 'Net cash movement')],
    ['Ending cash', total('ending')],
  ]
  figures.forEach(([label, r], i) => {
    g.set(13 + i, 0, label)
    if (r != null) g.set(13 + i, 1, formula(`'${sheetName}'!${ref(r, sheet.totalCol)}`, sheet.values.get(ref(r, sheet.totalCol)) ?? 0))
  })

  let r = 13 + figures.length + 1
  g.set(r++, 0, 'How this workbook works')
  for (const line of [
    `${MONTHLY}: every month, actual and forecast. Totals, net income and the cash roll-forward are formulas.`,
    `Forecast months a rule produced are formulas over its row on ${ASSUMPTIONS} (${formulaCells} cell${formulaCells === 1 ? '' : 's'}): change a driver there and everything downstream recalculates.`,
    'Actual months, overrides, hand edits and linked amounts (fees, investments, capital calls) carry the app’s values — type over them to try a different number.',
    ...(input.interval !== 'month' ? [`${sheetName}: each period adds up its months on ${MONTHLY}.`] : []),
    'The app stays the record: a change here is not saved to the plan.',
  ]) g.set(r++, 0, line)

  if (notes.length) {
    r++
    g.set(r++, 0, 'Notes')
    for (const n of notes) g.set(r++, 0, n)
  }
  return g.toSheet([26, 60])
}

// ---------------------------------------------------------------------------------------------
// Variance: base and compare as values, the difference and percentage as formulas.
// ---------------------------------------------------------------------------------------------

export function buildVarianceWorkbook(v: VarianceResponse, meta: ForecastWorkbookMeta): XLSX.WorkBook {
  const g = new Grid()
  const n = v.periods.length
  const totalCol = 3 + n
  g.set(0, 0, `${meta.fundName} — ${v.vehicle}`)
  g.set(1, 0, `Variance: ${baseLabel(v)} vs ${v.compare.kind === 'actual' ? 'Actual' : compareLabel(v)}, ${v.currency}. Difference = Compare − Base; % is of the base.`)
  g.set(2, 0, `Generated ${meta.generatedAt}${v.actualsThrough ? `; actuals through ${v.actualsThrough}` : ''}`)
  const head = 4
  g.row(head, ['Code', 'Account', 'Measure', ...v.periods.map(p => (p.partial ? `${p.label} (partial)` : p.label)), 'Total'])

  const values = new Map<string, number>()
  const put = (r: number, c: number, cell: Cell) => { g.set(r, c, cell); values.set(ref(r, c), typeof cell.v === 'number' ? cell.v : 0) }
  const val = (r: number, c: number) => values.get(ref(r, c)) ?? 0
  let r = head + 1
  const baseRows: Record<'income' | 'expense', number[]> = { income: [], expense: [] }

  /** Four rows: base, compare, difference, %. `sumOf` writes the base and compare as totals of other rows. */
  const block = (code: string, name: string, cells: (VarianceCell | null)[], sumOf?: { base: number[] } | { netOf: [number, number] }) => {
    const b = r, c = r + 1, d = r + 2, p = r + 3
    g.row(b, [code, name, 'Base']); g.row(c, [code, name, 'Compare']); g.row(d, [code, name, 'Difference']); g.row(p, [code, name, 'Difference %'])
    for (let i = 0; i <= n; i++) {
      const x = 3 + i
      const isTotal = i === n
      const cell = isTotal ? null : cells[i]
      if (!isTotal && !cell && !sumOf) continue
      if (isTotal) {
        put(b, x, formula(`SUM(${ref(b, 3)}:${ref(b, x - 1)})`, sum(Array.from({ length: n }, (_, k) => val(b, 3 + k)))))
        put(c, x, formula(`SUM(${ref(c, 3)}:${ref(c, x - 1)})`, sum(Array.from({ length: n }, (_, k) => val(c, 3 + k)))))
      } else if (sumOf && 'base' in sumOf) {
        put(b, x, formula(sumRows(sumOf.base, x), sum(sumOf.base.map(y => val(y, x)))))
        put(c, x, formula(sumRows(sumOf.base.map(y => y + 1), x), sum(sumOf.base.map(y => val(y + 1, x)))))
      } else if (sumOf && 'netOf' in sumOf) {
        const [rev, exp] = sumOf.netOf
        put(b, x, formula(`${ref(rev, x)}-${ref(exp, x)}`, val(rev, x) - val(exp, x)))
        put(c, x, formula(`${ref(rev + 1, x)}-${ref(exp + 1, x)}`, val(rev + 1, x) - val(exp + 1, x)))
      } else {
        put(b, x, money(cell!.base))
        put(c, x, money(cell!.compare))
      }
      put(d, x, formula(`${ref(c, x)}-${ref(b, x)}`, val(c, x) - val(b, x)))
      const base = val(b, x)
      g.set(p, x, { v: base === 0 ? 0 : roundPct((val(c, x) - base) / Math.abs(base)), f: `IF(${ref(b, x)}=0,"",${ref(d, x)}/ABS(${ref(b, x)}))`, z: PCT })
    }
    r += 5
    return b
  }

  for (const l of v.lines) baseRows[l.type].push(block(l.code, l.name, l.cells))
  const rev = block('', 'Total revenue', v.revenue, { base: baseRows.income })
  const exp = block('', 'Total expenses', v.expenses, { base: baseRows.expense })
  block('', 'Net income', v.netIncome, { netOf: [rev, exp] })

  if (v.warnings.length) {
    g.set(r++, 0, 'Notes')
    for (const w of v.warnings) g.set(r++, 0, w)
  }
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, g.toSheet([10, 34, 13, ...v.periods.map(() => 14), 16], { r: head + 1, c: 3 }), 'Variance')
  return wb
}

const roundPct = (x: number) => Math.round(x * 10000) / 10000
const baseLabel = (v: VarianceResponse) => `${v.base.plan?.name ?? 'Plan'}${v.base.version ? ` v${v.base.version.versionNo}` : ' (draft)'}`
const compareLabel = (v: VarianceResponse) => v.compare.kind === 'plan'
  ? `${v.compare.plan?.name ?? 'Plan'}${v.compare.version ? ` v${v.compare.version.versionNo}` : ' (draft)'}` : 'Actual'
