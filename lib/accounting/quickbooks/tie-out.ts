import { splitLine, pickDelim, parseAmount } from '@/lib/accounting/bank'
import type { TrialBalance } from '@/lib/accounting/statements'

/**
 * The migration's acceptance test: our trial balance against QuickBooks', account by account.
 *
 * Migration is done when every period ties — not when the import runs without errors. That is
 * the whole reason the Trial Balance is imported separately from the Journal: the Journal is
 * what we load, the Trial Balance is what we prove it against.
 */

export interface QbTrialBalanceRow {
  account: string
  debit: number
  credit: number
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')
const TOTAL_ROW = /^(total|totals|grand total)\b/i
const CENT = 0.005

const HEADERS = {
  account: ['account', 'account name', 'name'],
  debit: ['debit', 'debits'],
  credit: ['credit', 'credits'],
}

export function parseQbTrialBalance(text: string): { rows: QbTrialBalanceRow[]; errors: string[] } {
  // Records split on newlines only; a trial balance has no leading empty columns to protect,
  // but quoted amounts still need the quote-aware line splitter.
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0)
  if (lines.length < 2) return { rows: [], errors: ['Nothing to parse.'] }

  const delim = pickDelim(lines[0])
  const header = splitLine(lines[0], delim).map(norm)
  const col = (k: keyof typeof HEADERS) => header.findIndex(h => HEADERS[k].includes(h))
  const idx = { account: col('account'), debit: col('debit'), credit: col('credit') }

  const missing = (['account', 'debit', 'credit'] as const).filter(k => idx[k] < 0)
  if (missing.length > 0) {
    return { rows: [], errors: [`Missing required column(s): ${missing.join(', ')}.`] }
  }

  const rows: QbTrialBalanceRow[] = []
  for (const line of lines.slice(1)) {
    const cells = splitLine(line, delim)
    const account = (cells[idx.account] ?? '').trim()
    if (!account || TOTAL_ROW.test(account)) continue
    const money = (i: number) => {
      const raw = (cells[i] ?? '').trim()
      return raw ? Math.abs(parseAmount(raw) ?? 0) : 0
    }
    rows.push({ account, debit: money(idx.debit), credit: money(idx.credit) })
  }

  return { rows, errors: [] }
}

export interface TieOutLine {
  code: string
  name: string
  ours: number
  theirs: number
  /** ours − theirs. */
  difference: number
}

export interface TaxRoutedLine {
  code: string
  name: string
  /** Debit minus credit, as the other columns. */
  amount: number
}

/**
 * `taxRouted` is the trial balance of the entries the import sent to the TAX book
 * (book-routing.ts) — the preparer's K-1 entries in a tax-basis file. The source trial balance
 * includes them; our actual book, deliberately, does not. So they are taken out of the source side
 * before comparing, and reported on their own: the actual book ties to the source excluding the
 * tax-routed transactions, and the tax-routed totals show what the tax book holds. Without this, a
 * tax-basis file could never tie, and the differences would be exactly the entries routed correctly.
 */
export function compareTrialBalance(
  ours: TrialBalance,
  theirs: QbTrialBalanceRow[],
  mapping: Map<string, string>,
  capitalRollups: Map<string, string> = new Map(),
  taxRouted?: TrialBalance,
): { lines: TieOutLine[]; ties: boolean; ourTotal: number; theirTotal: number; taxRouted: { lines: TaxRoutedLine[]; total: number } } {
  // Several QuickBooks accounts can map to one of ours — sum them before comparing.
  //
  // Unmapped QuickBooks accounts are SKIPPED, not reported as differences. An unmapped
  // account is a mapping-screen problem; surfacing it here would bury the real differences
  // under noise. The mapping screen shows coverage separately.
  const theirsByCode = new Map<string, number>()
  for (const r of theirs) {
    const code = mapping.get(r.account)
    if (!code) continue
    theirsByCode.set(code, round2((theirsByCode.get(code) ?? 0) + r.debit - r.credit))
  }

  // Rolled up the way our own rows are below, so a tax-routed capital line lands where ours would.
  const taxByCode = new Map<string, { name: string; amount: number }>()
  for (const r of taxRouted?.rows ?? []) {
    const code = theirsByCode.has(r.code) ? r.code : capitalRollups.get(r.code) ?? r.code
    const previous = taxByCode.get(code)
    taxByCode.set(code, { name: previous?.name ?? r.name, amount: round2((previous?.amount ?? 0) + r.debit - r.credit) })
  }
  for (const [code, t] of Array.from(taxByCode)) {
    if (Math.abs(t.amount) < CENT) { taxByCode.delete(code); continue }
    theirsByCode.set(code, round2((theirsByCode.get(code) ?? 0) - t.amount))
  }

  const oursByCode = new Map<string, { name: string; balance: number }>()
  for (const r of ours.rows) {
    // `balance` is normal-side positive (credits are positive for equity/income).
    // QuickBooks above is debit minus credit. Compare the actual debit/credit columns
    // so a matching credit balance does not appear as a difference of twice its value.
    // QuickBooks may keep all partners in one account while we retain per-LP detail.
    // Never roll up a destination which the source trial balance maps explicitly.
    const code = theirsByCode.has(r.code) ? r.code : capitalRollups.get(r.code) ?? r.code
    const previous = oursByCode.get(code)
    oursByCode.set(code, { name: code === r.code ? r.name : previous?.name ?? "Partners' capital",
      balance: round2((previous?.balance ?? 0) + r.debit - r.credit) })
  }

  const codes = new Set([...Array.from(oursByCode.keys()), ...Array.from(theirsByCode.keys())])
  const lines: TieOutLine[] = []
  for (const code of Array.from(codes).sort()) {
    const o = oursByCode.get(code)?.balance ?? 0
    const t = theirsByCode.get(code) ?? 0
    const difference = round2(o - t)
    if (Math.abs(difference) < CENT) continue
    lines.push({ code, name: oursByCode.get(code)?.name ?? '(not in our chart)', ours: o, theirs: t, difference })
  }

  return {
    lines,
    ties: lines.length === 0,
    ourTotal: round2(sum(Array.from(oursByCode.values()).map(v => v.balance))),
    theirTotal: round2(sum(Array.from(theirsByCode.values()))),
    taxRouted: {
      lines: Array.from(taxByCode).sort(([a], [b]) => a.localeCompare(b)).map(([code, t]) => ({ code, name: t.name, amount: t.amount })),
      total: round2(sum(Array.from(taxByCode.values()).map(t => t.amount))),
    },
  }
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
const round2 = (n: number) => Math.round(n * 100) / 100
