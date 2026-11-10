import { describe, expect, it } from 'vitest'
import { emptyAccount } from './capital-account'
import { bookTaxBridgeRows, bridgeCategory, capitalEffect } from './book-tax-bridge'
import type { ExportEntry } from './journal-export'

const acct = (o: Partial<ReturnType<typeof emptyAccount>>) => ({ ...emptyAccount(), ...o })
const types = new Map([['1100', 'asset'], ['1700-x', 'asset'], ['3200', 'equity'], ['3900', 'equity'], ['4610-x', 'income'], ['4200', 'income'], ['1200', 'asset']])
const entry = (o: Partial<ExportEntry> & { postings: ExportEntry['postings'] }): ExportEntry =>
  ({ id: 'e', entryDate: '2025-12-31', memo: null, sourceType: null, sourceRef: null, status: 'posted', ...o })
const line = (accountCode: string, amount: number) => ({ accountCode, accountName: accountCode, amount, currency: 'USD' })

describe('the book-to-tax capital bridge', () => {
  it('names each kind of tax-book entry', () => {
    expect(bridgeCategory({ sourceRef: 'tax-k1:2025:co', sourceType: null })).toBe('Lower-tier K-1 pass-through')
    expect(bridgeCategory({ sourceRef: 'tax:2025', sourceType: null })).toBe('Book-to-tax adjustments run')
    expect(bridgeCategory({ sourceRef: 'qb:JE-7', sourceType: 'quickbooks' })).toBe('Imported tax-basis entries')
    expect(bridgeCategory({ sourceRef: null, sourceType: 'manual' })).toBe('Hand-entered tax entries')
  })

  it('measures an entry by what it does to net assets, however it reaches capital', () => {
    // A write-up of an investment against retained earnings raises capital by the write-up.
    expect(capitalEffect(entry({ postings: [line('1100', 5_000), line('3900', -5_000)] }), types)).toBe(5_000)
    // Reversing unrealized appreciation lowers it.
    expect(capitalEffect(entry({ postings: [line('4200', 2_000), line('1200', -2_000)] }), types)).toBe(-2_000)
  })

  it('explains the opening and the year\'s difference, and shows what is left over', () => {
    const book = {
      partners: [{ id: 'a', name: 'Jane Doe', ...acct({ beginning: 100_000, contributions: 10_000, realizedGains: 20_000, ending: 130_000 }) }],
      totals: acct({ beginning: 100_000, contributions: 10_000, realizedGains: 20_000, ending: 130_000 }),
    }
    const tax = {
      partners: [{ id: 'a', name: 'Jane Doe', ...acct({ beginning: 105_000, contributions: 10_000, unclassified: 12_000, ending: 127_000 }) }],
      totals: acct({ beginning: 105_000, contributions: 10_000, unclassified: 12_000, ending: 127_000 }),
    }
    const rows = bookTaxBridgeRows({
      year: 2025, book, tax, typeOfCode: types,
      priorTaxEntries: [entry({ entryDate: '2024-12-31', sourceType: 'quickbooks', postings: [line('1100', 5_000), line('3900', -5_000)] })],
      yearTaxEntries: [entry({ sourceRef: 'tax-k1:2025:co', memo: 'Northwind Fund II K-1', postings: [line('1700-x', -10_000), line('4610-x', 10_000)] })],
    })
    const find = (label: string) => rows.find(r => r[0] === label)!
    expect(find('Beginning capital')).toEqual(['Beginning capital', 100_000, 105_000, 5_000])
    expect(find('Income (loss)')).toEqual(['Income (loss)', 20_000, 12_000, -8_000])
    expect(find('Ending capital')).toEqual(['Ending capital', 130_000, 127_000, -3_000])
    expect(find('  2024 · Imported tax-basis entries')).toEqual(['  2024 · Imported tax-basis entries', 1, 5_000])
    expect(find('Opening difference')[2]).toBe(5_000)
    expect(find('  Lower-tier K-1 pass-through · Northwind Fund II K-1')).toEqual(['  Lower-tier K-1 pass-through · Northwind Fund II K-1', 1, -10_000])
    expect(find('Change in 2025')[2]).toBe(-8_000)
    // The K-1 explains 10,000 of an 8,000 change; the 2,000 left over is said, not absorbed.
    expect(rows.filter(r => r[0] === '  Not explained by the tax book').map(r => r[2])).toEqual([0, 2_000])
    expect(find('Jane Doe')).toEqual(['Jane Doe', 100_000, 105_000, 5_000, 10_000, 10_000, 0, 0, 20_000, 12_000, -8_000, 130_000, 127_000, -3_000])
  })
})
