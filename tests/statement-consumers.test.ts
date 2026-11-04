import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { buildStatementPackageFromData, type LedgerData } from '@/lib/accounting/statement-package'
import { buildStatementsHtml } from '@/lib/accounting/statements-pdf'
import { buildStatementWorkbook } from '@/lib/accounting/statement-workbook'
import { vcLedger } from '@/tests/helpers/statement-fixtures'

/**
 * The statement package's renderers (the PDF and the xlsx workpaper). Every kind but a GPU SPV
 * renders byte-for-byte as before: these pins were committed against the renderers as they stood
 * before the investing section and the fleet schedule reached them.
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
