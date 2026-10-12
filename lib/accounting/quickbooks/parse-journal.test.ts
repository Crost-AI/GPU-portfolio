import { describe, it, expect } from 'vitest'
import { normalizeQbTransactions, parseQbJournal } from './parse-journal'

// The shape QuickBooks Online exports: header row, then one row per SPLIT LINE, with the
// transaction's date/type/num present only on its first line.
const EXPORT = [
  'Date,Transaction Type,Num,Name,Memo/Description,Account,Debit,Credit',
  '01/15/2024,Journal Entry,JE-1,,Capital call — Acme III,Investments:Acme Ventures III,"1,000,000.00",',
  ',,,,Capital call — Acme III,Bank:Operating,,"1,000,000.00"',
  '03/31/2024,Check,1043,Vendor Co,Audit fee,Professional Fees,"12,500.00",',
  ',,,Vendor Co,Audit fee,Bank:Operating,,"12,500.00"',
].join('\n')

describe('parseQbJournal', () => {
  it('groups continuation lines into their parent transaction', () => {
    const { transactions, errors } = parseQbJournal(EXPORT)
    expect(errors).toEqual([])
    expect(transactions).toHaveLength(2)
    expect(transactions[0].lines).toHaveLength(2)
    expect(transactions[1].lines).toHaveLength(2)
  })

  it('normalizes the date and carries type and num', () => {
    const { transactions } = parseQbJournal(EXPORT)
    expect(transactions[0]).toMatchObject({ date: '2024-01-15', type: 'Journal Entry', num: 'JE-1' })
    expect(transactions[1].date).toBe('2024-03-31')
  })

  it('reads debit and credit as separate positive columns', () => {
    const { transactions } = parseQbJournal(EXPORT)
    const [dr, cr] = transactions[0].lines
    expect(dr).toMatchObject({ account: 'Investments:Acme Ventures III', debit: 1_000_000, credit: 0 })
    expect(cr).toMatchObject({ account: 'Bank:Operating', debit: 0, credit: 1_000_000 })
  })

  it('summarizes distinct accounts with line counts and totals', () => {
    const { accounts } = parseQbJournal(EXPORT)
    const bank = accounts.find(a => a.account === 'Bank:Operating')!
    expect(bank.lineCount).toBe(2)
    expect(bank.totalCredit).toBe(1_012_500)
    expect(bank.totalDebit).toBe(0)
    // Sorted by activity so the mapping screen shows the accounts that matter first.
    expect(accounts[0].lineCount).toBeGreaterThanOrEqual(accounts[accounts.length - 1].lineCount)
  })

  it('flags an unbalanced transaction rather than importing it', () => {
    const bad = [
      'Date,Transaction Type,Num,Name,Memo/Description,Account,Debit,Credit',
      '01/15/2024,Journal Entry,JE-9,,Bad,Investments:Acme Ventures III,"1,000.00",',
      ',,,,Bad,Bank:Operating,,"900.00"',
    ].join('\n')
    const { transactions, errors } = parseQbJournal(bad)
    expect(transactions).toHaveLength(0)
    expect(errors.join(' ')).toMatch(/JE-9/)
    expect(errors.join(' ')).toMatch(/balance/i)
  })

  it('skips the report’s total rows', () => {
    const withTotals = EXPORT + '\n,,,,,TOTAL,"1,012,500.00","1,012,500.00"'
    const { transactions } = parseQbJournal(withTotals)
    expect(transactions).toHaveLength(2)
  })

  it('reports a missing required column instead of guessing by position', () => {
    const { transactions, errors } = parseQbJournal('Date,Num,Memo\n01/15/2024,1,x')
    expect(transactions).toEqual([])
    expect(errors.join(' ')).toMatch(/account|debit|credit/i)
  })

  it('handles a transaction with more than two splits', () => {
    const multi = [
      'Date,Transaction Type,Num,Name,Memo/Description,Account,Debit,Credit',
      '06/30/2024,Journal Entry,JE-2,,Call,Investments:Acme Ventures III,"900.00",',
      ',,,,Call,Management Fees,"100.00",',
      ',,,,Call,Bank:Operating,,"1,000.00"',
    ].join('\n')
    const { transactions, errors } = parseQbJournal(multi)
    expect(errors).toEqual([])
    expect(transactions[0].lines).toHaveLength(3)
  })

  it('reports a split line that appears before any dated row', () => {
    // Orphaned line: attaching it to whatever came before would silently move money.
    const orphan = [
      'Date,Transaction Type,Num,Name,Memo/Description,Account,Debit,Credit',
      ',,,,No parent,Bank:Operating,"100.00",',
    ].join('\n')
    const { transactions, errors } = parseQbJournal(orphan)
    expect(transactions).toEqual([])
    expect(errors.join(' ')).toMatch(/no transaction date/i)
  })

  it('handles tab-separated exports as readily as CSV', () => {
    // Written out rather than converted from the CSV: the thousands separators inside the
    // amounts are exactly what a naive comma→tab conversion corrupts.
    const tsv = [
      'Date\tTransaction Type\tNum\tName\tMemo/Description\tAccount\tDebit\tCredit',
      '01/15/2024\tJournal Entry\tJE-1\t\tCapital call\tInvestments:Acme Ventures III\t"1,000,000.00"\t',
      '\t\t\t\tCapital call\tBank:Operating\t\t"1,000,000.00"',
    ].join('\n')
    const { transactions, errors } = parseQbJournal(tsv)
    expect(errors).toEqual([])
    expect(transactions).toHaveLength(1)
    expect(transactions[0].lines[0].debit).toBe(1_000_000)
  })
})

describe('normalizeQbTransactions', () => {
  const structured = [
    { date: '2024-01-15', type: 'Journal Entry', num: 'JE-1', memo: 'Capital call', lines: [
      { account: 'Investments:Acme Ventures III', debit: 1_000_000 },
      { account: 'Bank:Operating', credit: '1,000,000.00' },
    ] },
  ]

  it('accepts what a connector sends and summarises it like a parsed export', () => {
    const { transactions, accounts, errors } = normalizeQbTransactions(structured)
    expect(errors).toEqual([])
    expect(transactions[0].lines.map(l => [l.debit, l.credit])).toEqual([[1_000_000, 0], [0, 1_000_000]])
    expect(accounts.map(a => a.account).sort()).toEqual(['Bank:Operating', 'Investments:Acme Ventures III'])
  })

  it('agrees with the export parser on the same journal', () => {
    const fromApi = normalizeQbTransactions([
      { date: '2024-01-15', type: 'Journal Entry', num: 'JE-1', memo: 'Capital call — Acme III', lines: [
        { account: 'Investments:Acme Ventures III', memo: 'Capital call — Acme III', debit: 1_000_000 },
        { account: 'Bank:Operating', memo: 'Capital call — Acme III', credit: 1_000_000 },
      ] },
    ])
    expect(fromApi.transactions[0]).toEqual(parseQbJournal(EXPORT).transactions[0])
  })

  it('drops an unbalanced transaction by the same rule as an export', () => {
    const { transactions, errors } = normalizeQbTransactions([{ ...structured[0], lines: [structured[0].lines[0]] }])
    expect(transactions).toEqual([])
    expect(errors[0]).toMatch(/does not balance/)
  })

  it('refuses an unreadable amount rather than reading it as zero', () => {
    const { transactions, errors } = normalizeQbTransactions([{ date: '2024-01-15', lines: [
      { account: 'A', debit: 'abc' }, { account: 'B', credit: 0 },
    ] }])
    expect(transactions).toEqual([])
    expect(errors[0]).toMatch(/unreadable amount/)
  })

  it('names a transaction with no date or no lines', () => {
    expect(normalizeQbTransactions([{ lines: [] }]).errors[0]).toMatch(/date/)
    expect(normalizeQbTransactions([{ date: '2024-01-01', lines: [] }]).errors[0]).toMatch(/no lines/)
    expect(normalizeQbTransactions('nope').errors[0]).toMatch(/array/)
  })
})
