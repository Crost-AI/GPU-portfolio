import { splitRecords, splitLine, pickDelim, normalizeDate, parseAmount } from '@/lib/accounting/bank'

/**
 * QuickBooks' Journal report, parsed. Pure.
 *
 * WHY THE JOURNAL REPORT and not the General Ledger or the Trial Balance. The Journal is the
 * only QuickBooks export that is already a double-entry stream — one row per split line, with
 * both sides of every transaction present. The GL report is account-major and loses the
 * transaction grouping (you cannot tell which credit answers which debit); the Trial Balance
 * has no detail at all. We import the Trial Balance too, but only as the tie-out target.
 *
 * THE GROUPING RULE. QuickBooks prints date/type/num on a transaction's FIRST line only and
 * leaves them blank on its continuation lines. A row with a date starts a new transaction; a
 * row without one belongs to the transaction above it. Get this wrong and unrelated
 * transactions merge into one entry that happens to balance.
 */

export interface QbLine {
  account: string
  name: string | null
  memo: string | null
  /** Positive magnitudes, as QuickBooks prints them. Conversion to signed happens later. */
  debit: number
  credit: number
}

export interface QbTransaction {
  date: string
  type: string | null
  num: string | null
  memo: string | null
  lines: QbLine[]
}

export interface QbAccountSummary {
  account: string
  lineCount: number
  totalDebit: number
  totalCredit: number
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')

const HEADERS = {
  date:    ['date', 'transaction date'],
  type:    ['transaction type', 'type'],
  num:     ['num', 'number', 'no.', 'ref no.', 'ref'],
  name:    ['name', 'payee', 'vendor'],
  memo:    ['memo/description', 'memo', 'description'],
  account: ['account', 'account name', 'split'],
  debit:   ['debit', 'debits'],
  credit:  ['credit', 'credits'],
}

const TOTAL_ROW = /^(total|totals|grand total|beginning balance|ending balance)\b/i
const CENT = 0.005

export function parseQbJournal(text: string): {
  transactions: QbTransaction[]
  accounts: QbAccountSummary[]
  errors: string[]
} {
  const errors: string[] = []
  const records = splitRecords(text)
  if (records.length < 2) return { transactions: [], accounts: [], errors: ['Nothing to parse.'] }

  const delim = pickDelim(records[0])
  const header = splitLine(records[0], delim).map(norm)
  const col = (k: keyof typeof HEADERS) => header.findIndex(h => HEADERS[k].includes(h))
  const idx = {
    date: col('date'), type: col('type'), num: col('num'), name: col('name'),
    memo: col('memo'), account: col('account'), debit: col('debit'), credit: col('credit'),
  }

  const missing = (['account', 'debit', 'credit'] as const).filter(k => idx[k] < 0)
  if (missing.length > 0) {
    return { transactions: [], accounts: [], errors: [`Missing required column(s): ${missing.join(', ')}. Export the Journal report with Debit and Credit columns.`] }
  }
  if (idx.date < 0) {
    return { transactions: [], accounts: [], errors: ['Missing a Date column.'] }
  }

  const cell = (cells: string[], i: number) => (i >= 0 ? (cells[i] ?? '').trim() : '')
  const money = (raw: string) => (raw ? (parseAmount(raw) ?? 0) : 0)

  const out: QbTransaction[] = []
  let current: QbTransaction | null = null

  for (const rec of records.slice(1)) {
    const cells = splitLine(rec, delim)
    const account = cell(cells, idx.account)
    if (!account || TOTAL_ROW.test(account)) continue

    const dateRaw = cell(cells, idx.date)
    if (dateRaw) {
      const date = normalizeDate(dateRaw)
      if (!date) { errors.push(`Unreadable date "${dateRaw}".`); current = null; continue }
      current = {
        date,
        type: cell(cells, idx.type) || null,
        num: cell(cells, idx.num) || null,
        memo: cell(cells, idx.memo) || null,
        lines: [],
      }
      out.push(current)
    }

    // A split line before any dated row is orphaned — report it rather than attaching it
    // to whatever came before.
    if (!current) { errors.push(`Line for "${account}" has no transaction date above it.`); continue }

    current.lines.push({
      account,
      name: cell(cells, idx.name) || null,
      memo: cell(cells, idx.memo) || null,
      debit: Math.abs(money(cell(cells, idx.debit))),
      credit: Math.abs(money(cell(cells, idx.credit))),
    })
  }

  return finalize(out, errors)
}

/**
 * The same journal, handed over already structured — by a connector reading QuickBooks' API or
 * MCP server rather than a person pasting an export. Pure.
 *
 * It goes through the SAME balance check and account summary as a parsed export, so an API-fed
 * transaction cannot reach the ledger by a looser path than a pasted one. Anything malformed is
 * named and dropped, never coerced: an amount that cannot be read is an error, not a zero, because
 * a zero would still balance and would misstate the account. An ABSENT debit or credit is zero,
 * as an empty export cell is.
 */
export function normalizeQbTransactions(input: unknown): {
  transactions: QbTransaction[]
  accounts: QbAccountSummary[]
  errors: string[]
} {
  const errors: string[] = []
  if (!Array.isArray(input)) return { transactions: [], accounts: [], errors: ['transactions must be an array.'] }

  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
  const amount = (v: unknown): number | null => {
    if (v === null || v === undefined || v === '') return 0
    const n = typeof v === 'number' ? v : parseAmount(String(v))
    return n === null || !Number.isFinite(n) ? null : Math.abs(n)
  }

  const out: QbTransaction[] = []
  input.forEach((raw: any, i) => {
    const label = `Transaction ${i + 1}${str(raw?.num) ? ` (${raw.num})` : ''}`
    const date = str(raw?.date) ? normalizeDate(raw.date) : null
    if (!date) { errors.push(`${label}: missing or unreadable date.`); return }
    if (!Array.isArray(raw?.lines) || raw.lines.length === 0) { errors.push(`${label}: has no lines.`); return }

    const lines: QbLine[] = []
    for (const l of raw.lines) {
      const account = str(l?.account)
      const debit = amount(l?.debit)
      const credit = amount(l?.credit)
      if (!account || debit === null || credit === null) {
        errors.push(`${label}: a line is missing its account or has an unreadable amount.`)
        return
      }
      lines.push({ account, name: str(l?.name), memo: str(l?.memo), debit, credit })
    }
    out.push({ date, type: str(raw?.type), num: str(raw?.num), memo: str(raw?.memo), lines })
  })

  return finalize(out, errors)
}

function finalize(out: QbTransaction[], errors: string[]) {
  // Drop anything that does not balance. An unbalanced transaction is a broken export or a
  // parse error, and importing it would fail assertBalanced in persistEntry anyway — better
  // to name it here, where the user can see which one.
  const balanced: QbTransaction[] = []
  for (const t of out) {
    if (t.lines.length === 0) continue
    const diff = t.lines.reduce((a, l) => a + l.debit - l.credit, 0)
    if (Math.abs(diff) > CENT) {
      errors.push(`${t.type ?? 'Transaction'} ${t.num ?? t.date} does not balance (off by ${diff.toFixed(2)}).`)
      continue
    }
    balanced.push(t)
  }

  const summary = new Map<string, QbAccountSummary>()
  for (const t of balanced) {
    for (const l of t.lines) {
      const s = summary.get(l.account) ?? { account: l.account, lineCount: 0, totalDebit: 0, totalCredit: 0 }
      s.lineCount += 1
      s.totalDebit += l.debit
      s.totalCredit += l.credit
      summary.set(l.account, s)
    }
  }

  return {
    transactions: balanced,
    // Busiest accounts first — the mapping screen should open on what matters.
    accounts: Array.from(summary.values()).sort((a, b) => b.lineCount - a.lineCount),
    errors,
  }
}
