// The book-to-tax capital bridge: how partners' capital on the books (ASC 946, what the
// administrator reports) becomes the tax-basis capital on the K-1s, for one year. Pure.
//
// Three sections, so a reconciliation starts from the right side and every difference has a name:
//   1. The fund: beginning capital, contributions, distributions, income and ending capital, book
//      beside tax, with the difference on each line.
//   2. What makes the difference: every tax-book entry, grouped, by its effect on capital. Entries
//      dated before the year explain the opening difference; the year's own explain the rest. A
//      residual line says what the tax book does not explain, so a gap is never silently absorbed.
//   3. Each partner: the same roll-forward, book beside tax.
//
// An entry's effect on capital is what it does to net assets: the signed sum of its lines on asset
// and liability accounts (a debit to an asset raises capital). That holds whether the entry runs
// through income, straight to a partner's capital, or to retained earnings, which is how imported
// tax-basis entries often arrive.

import type { ChangesInPartnersCapital, PartnerCapitalRow } from './statements'
import type { ExportEntry } from './journal-export'
import type { CapitalAccount } from './capital-account'

type Cell = string | number | null

const cents = (n: number) => Math.round(n * 100) / 100

const INCOME_FIELDS: (keyof CapitalAccount)[] = [
  'managementFees', 'expenses', 'operatingIncome', 'realizedGains', 'unrealizedGains',
  'fxTranslation', 'carriedInterest', 'unclassified',
]

/** Income and loss for the period, every line that is not money in or out or a transfer. */
export const periodIncome = (c: CapitalAccount) => cents(INCOME_FIELDS.reduce((s, f) => s + Number(c[f] ?? 0), 0))

/** What the tax-book entries are, in words a preparer recognises. */
export function bridgeCategory(e: Pick<ExportEntry, 'sourceRef' | 'sourceType'>): string {
  const ref = e.sourceRef ?? ''
  if (ref.startsWith('tax-k1:')) return 'Lower-tier K-1 pass-through'
  if (/^tax:\d{4}$/.test(ref)) return 'Book-to-tax adjustments run'
  if (e.sourceType === 'quickbooks' || e.sourceType === 'carta') return 'Imported tax-basis entries'
  return 'Hand-entered tax entries'
}

/** An entry's effect on partners' capital: its lines on asset and liability accounts. */
export function capitalEffect(e: ExportEntry, typeOfCode: Map<string, string>): number {
  let effect = 0
  for (const p of e.postings) {
    const type = typeOfCode.get(p.accountCode)
    // Credit balances are negative here: a credit to a liability lowers net assets.
    if (type === 'asset' || type === 'liability') effect += p.amount
  }
  return cents(effect)
}

export interface BridgeInputs {
  year: number
  book: ChangesInPartnersCapital
  tax: ChangesInPartnersCapital
  /** Posted tax-book entries dated before the year: the opening difference. */
  priorTaxEntries: ExportEntry[]
  /** Posted tax-book entries dated in the year. */
  yearTaxEntries: ExportEntry[]
  /** Account code to type, from the chart. */
  typeOfCode: Map<string, string>
}

interface Group { label: string; amount: number; entries: number }

function groupEntries(entries: ExportEntry[], typeOfCode: Map<string, string>, by: (e: ExportEntry) => string): Group[] {
  const groups = new Map<string, Group>()
  for (const e of entries) {
    const effect = capitalEffect(e, typeOfCode)
    if (effect === 0) continue
    const label = by(e)
    const g = groups.get(label) ?? { label, amount: 0, entries: 0 }
    g.amount = cents(g.amount + effect)
    g.entries++
    groups.set(label, g)
  }
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label))
}

const diff = (tax: number, book: number) => cents(tax - book)

export function bookTaxBridgeRows(i: BridgeInputs): Cell[][] {
  const b = i.book.totals
  const t = i.tax.totals
  const rows: Cell[][] = [
    [`Book-to-tax capital bridge, ${i.year}`],
    ['Positive differences mean tax capital is higher than book capital.'],
    [],
    ['1. The fund', 'Book', 'Tax', 'Tax less book'],
    ['Beginning capital', b.beginning, t.beginning, diff(t.beginning, b.beginning)],
    ['Contributions', b.contributions, t.contributions, diff(t.contributions, b.contributions)],
    ['Distributions', b.distributions, t.distributions, diff(t.distributions, b.distributions)],
    ['Income (loss)', periodIncome(b), periodIncome(t), diff(periodIncome(t), periodIncome(b))],
    ['Transfers between partners', b.transfers, t.transfers, diff(t.transfers, b.transfers)],
    ['Ending capital', b.ending, t.ending, diff(t.ending, b.ending)],
    [],
    ['2. What makes the difference', 'Entries', 'Effect on capital'],
  ]

  const year = String(i.year)
  const opening = groupEntries(i.priorTaxEntries, i.typeOfCode, e => `${e.entryDate.slice(0, 4)} · ${bridgeCategory(e)}`)
  const openingExplained = cents(opening.reduce((s, g) => s + g.amount, 0))
  const openingDiff = diff(t.beginning, b.beginning)
  rows.push([`Opening difference, from tax-book entries before ${year}`])
  for (const g of opening) rows.push([`  ${g.label}`, g.entries, g.amount])
  rows.push(['  Not explained by the tax book', '', cents(openingDiff - openingExplained)])
  rows.push(['Opening difference', '', openingDiff])

  // The year's entries one line per memo within each category, so each holding's K-1 and each
  // imported entry shows by name.
  const current = groupEntries(i.yearTaxEntries, i.typeOfCode, e => `${bridgeCategory(e)}${e.memo ? ` · ${e.memo}` : ''}`)
  const currentExplained = cents(current.reduce((s, g) => s + g.amount, 0))
  const yearDiff = cents(diff(t.ending, b.ending) - openingDiff)
  rows.push([`Change in ${year}, from tax-book entries dated in ${year}`])
  for (const g of current) rows.push([`  ${g.label}`, g.entries, g.amount])
  rows.push(['  Not explained by the tax book', '', cents(yearDiff - currentExplained)])
  rows.push([`Change in ${year}`, '', yearDiff])
  rows.push(['Ending difference', '', diff(t.ending, b.ending)])
  rows.push([])

  rows.push(['3. Each partner',
    'Book beginning', 'Tax beginning', 'Beginning difference',
    'Book contributions', 'Tax contributions', 'Book distributions', 'Tax distributions',
    'Book income (loss)', 'Tax income (loss)', 'Income difference',
    'Book ending', 'Tax ending', 'Ending difference'])
  const taxById = new Map(i.tax.partners.map(p => [p.id, p]))
  const seen = new Set<string>()
  const partnerRow = (name: string, bp: CapitalAccount | null, tp: CapitalAccount | null): Cell[] => {
    const z = (c: CapitalAccount | null, f: keyof CapitalAccount) => (c ? Number(c[f] ?? 0) : 0)
    const bi = bp ? periodIncome(bp) : 0
    const ti = tp ? periodIncome(tp) : 0
    return [name,
      z(bp, 'beginning'), z(tp, 'beginning'), diff(z(tp, 'beginning'), z(bp, 'beginning')),
      z(bp, 'contributions'), z(tp, 'contributions'), z(bp, 'distributions'), z(tp, 'distributions'),
      bi, ti, diff(ti, bi),
      z(bp, 'ending'), z(tp, 'ending'), diff(z(tp, 'ending'), z(bp, 'ending'))]
  }
  for (const bp of i.book.partners) {
    seen.add(bp.id)
    rows.push(partnerRow(bp.name, bp, taxById.get(bp.id) ?? null))
  }
  for (const tp of i.tax.partners as PartnerCapitalRow[]) {
    if (!seen.has(tp.id)) rows.push(partnerRow(tp.name, null, tp))
  }
  rows.push(partnerRow('Total', b, t))
  return rows
}
