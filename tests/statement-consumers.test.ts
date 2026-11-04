import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { buildStatementPackageFromData, type LedgerData } from '@/lib/accounting/statement-package'
import { buildStatementsHtml } from '@/lib/accounting/statements-pdf'
import { buildStatementWorkbook } from '@/lib/accounting/statement-workbook'
import { gpuLedger, vcLedger } from '@/tests/helpers/statement-fixtures'

/**
 * The statement package's renderers (the PDF and the xlsx workpaper). Every kind but a GPU SPV
 * renders byte-for-byte as before: these pins were committed against the renderers as they stood
 * before the investing section and the fleet schedule reached them. A GPU SPV's renders its
 * equipment as investing, so the sections shown add up to the net change, and its fleet schedule.
 */

// The year 2027 alone, and its second half with the first beside it: a custom window's comparison is
// the window of the same length before it, and the year's would end before the ledger starts.
const YEAR_QS = () => new URLSearchParams({ preset: 'custom', start: '2027-01-01', end: '2027-12-31' })
const H2_VS_H1 = () => new URLSearchParams({ preset: 'custom', start: '2027-07-01', end: '2027-12-31', compare: '1' })
const pkgOf = (data: LedgerData, qs: URLSearchParams) => {
  const pkg = buildStatementPackageFromData(data, qs)
  if (qs.has('compare')) expect(pkg.comparisons?.map(c => c.period.end)).toEqual(['2027-06-30'])
  return pkg
}
const PDF_META = { fundName: 'Northgate', vehicle: 'V', currency: 'USD', generatedAt: '2028-01-05T00:00:00.000Z' }
const BOOK_META = { fundName: 'Northgate', vehicle: 'V', generatedAt: '2028-01-05T00:00:00.000Z' }
const csvSheets = (wb: XLSX.WorkBook) => Object.fromEntries(wb.SheetNames.map(n => [n, XLSX.utils.sheet_to_csv(wb.Sheets[n])]))

describe('a fund: the PDF and the workbook are unchanged', () => {
  it('the PDF, one period and with a comparison', () => {
    expect(buildStatementsHtml(pkgOf(vcLedger(), YEAR_QS()), PDF_META)).toMatchSnapshot()
    expect(buildStatementsHtml(pkgOf(vcLedger(), H2_VS_H1()), PDF_META)).toMatchSnapshot()
  })

  it('the workbook, one period and with a comparison', () => {
    expect(csvSheets(buildStatementWorkbook(pkgOf(vcLedger(), YEAR_QS()), BOOK_META))).toMatchSnapshot()
    expect(csvSheets(buildStatementWorkbook(pkgOf(vcLedger(), H2_VS_H1()), BOOK_META))).toMatchSnapshot()
  })
})

/** "$1,234.50" / "($1,234.50)" / "—" → a number. */
const parseMoney = (t: string) => {
  const v = t.trim()
  if (v === '—' || v === '') return 0
  const n = Number(v.replace(/[^0-9.]/g, ''))
  return v.startsWith('(') || v.startsWith('-') ? -n : n
}

describe("a GPU SPV: the PDF shows investing, foots, and carries the fleet schedule", () => {
  const html = buildStatementsHtml(pkgOf(gpuLedger(), YEAR_QS()), PDF_META)
  const total = (label: string) => {
    const m = new RegExp(`>${label}</td>\\s*<td[^>]*>([^<]*)</td>`).exec(html)
    expect(m, label).toBeTruthy()
    return parseMoney(m![1])
  }

  it('purchases and disposal proceeds are two lines under investing, between operating and financing', () => {
    expect(html).toContain('Purchases of equipment and capitalized costs')
    expect(html).toContain('Proceeds from disposal of equipment')
    const [op, inv, fin] = ['Total Operating activities', 'Total Investing activities', 'Total Financing activities'].map(l => html.indexOf(l))
    expect(op).toBeGreaterThan(0)
    expect(inv).toBeGreaterThan(op)
    expect(fin).toBeGreaterThan(inv)
  })

  it('operating + investing + financing = the net change printed', () => {
    expect(total('Total Investing activities')).toBe(-372_000)
    expect(total('Total Operating activities') + total('Total Investing activities') + total('Total Financing activities')).toBe(total('Net change in cash'))
    expect(total('Net change in cash')).toBe(648_000)
  })

  it('the fleet schedule: the server still held, totalling the net equipment', () => {
    expect(html).toContain('Fleet schedule')
    expect(html).toContain('GPU equipment at cost — srv-2')
    expect(html).not.toContain('GPU equipment at cost — srv-1')
    expect(total('Total equipment, net')).toBe(335_000)
  })
})

describe("a GPU SPV: the workbook shows investing, foots, and has a fleet schedule sheet", () => {
  // H2 (the disposal) with H1 (the purchases) beside it.
  const wb = buildStatementWorkbook(pkgOf(gpuLedger(), H2_VS_H1()), BOOK_META)
  const rows = (name: string) => XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, blankrows: false })
  const row = (sheet: string, first: string) => rows(sheet).find(r => r[0] === first)!

  it('investing sits between operating and financing, each line in its own period\'s column', () => {
    const cf = rows('Cash Flows').map(r => r[0])
    expect(cf.indexOf('Investing activities')).toBeGreaterThan(cf.indexOf('Total Operating activities'))
    expect(cf.indexOf('Total Financing activities')).toBeGreaterThan(cf.indexOf('Total Investing activities'))
    const line = (name: string) => rows('Cash Flows').find(r => r[1] === name)!.slice(2, 4)
    expect(line('Proceeds from disposal of equipment')).toEqual([50_000, ''])
    expect(line('Purchases of equipment and capitalized costs')).toEqual(['', -422_000])
  })

  it('in every period, operating + investing + financing = the net change', () => {
    const [op, inv, fin, net] = ['Total Operating activities', 'Total Investing activities', 'Total Financing activities', 'Net change in cash'].map(l => row('Cash Flows', l))
    expect(net.slice(2, 4).every(v => typeof v === 'number')).toBe(true)
    for (const c of [2, 3]) expect(Number(op[c]) + Number(inv[c]) + Number(fin[c]), `column ${c}`).toBe(Number(net[c]))
    expect(inv.slice(2, 4)).toEqual([50_000, -422_000])
  })

  it('the fleet schedule sheet follows the schedule of investments and totals the net equipment', () => {
    expect(wb.SheetNames).toEqual(['Cover', 'Trial Balance', 'Balance Sheet', 'Income Statement', 'Partners Capital', 'Schedule of Investments', 'Fleet Schedule', 'Cash Flows', 'GL Detail'])
    expect(row('Fleet Schedule', 'Total equipment, net').slice(6)).toEqual([335_000, -5_000, 330_000])
  })
})
