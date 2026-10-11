// A CSV writer. Pure, and deliberately plain: RFC 4180 quoting, LF line endings, numbers to two
// decimals with no thousands separator — the form every spreadsheet, every tax package importer
// and this repo's own bank/QuickBooks parsers (lib/accounting/bank.ts) read without a settings
// dialog. A locale-formatted "1,234.56" would be two cells to half of them.
//
// String cells go through lib/csv/escape.ts, which also neutralises spreadsheet formulas (a memo
// or counterparty name starting with = + - @). Numbers are typed and never prefixed: -5 is -5.00.

import { csvField } from '@/lib/csv/escape'

export type CsvCell = string | number | null | undefined

export function csvCell(v: CsvCell): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'number') return Number.isFinite(v) ? v.toFixed(2) : ''
  return csvField(v)
}

export function toCsv(rows: CsvCell[][]): string {
  return rows.map(r => r.map(csvCell).join(',')).join('\n') + '\n'
}
