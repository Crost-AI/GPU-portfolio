// A bank import reads persistEntry's lookups (currency, closed periods, vehicle, chart) a constant
// number of times, however many rows it drafts — not once per drafted row.
import { describe, expect, it, vi } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

vi.mock('@/lib/accounting/provision-accounts', () => ({ ensureVehicleAccounts: async () => {} }))
vi.mock('@/lib/accounting/vendors', () => ({ vendorResolver: () => async () => null }))
vi.mock('@/lib/accounting/import-review', () => ({ reviewImport: async () => ({ differences: [], token: 't' }) }))
import { importBankTransactions } from '@/lib/accounting/bank-import'

const LOOKUPS = ['fund_settings', 'fiscal_periods', 'fund_vehicles', 'chart_of_accounts'] as const

// A fresh fund per run: fundCurrency caches by fund id, which would hide the fund_settings read.
async function importDrafts(fund: string, n: number, prepare?: (m: ReturnType<typeof memoryAdmin>) => void) {
  const m = memoryAdmin({
    fund_settings: [{ fund_id: fund, currency: 'USD' }],
    fund_vehicles: [{ id: 'v', fund_id: fund, name: 'Fund I', aliases: [] }],
    fiscal_periods: [],
    chart_of_accounts: [
      { id: 'cash', fund_id: fund, vehicle_id: 'v', code: '1000', name: 'Cash', type: 'asset', subtype: 'cash' },
      { id: 'lp', fund_id: fund, vehicle_id: 'v', code: '3100', name: "Partners' capital — LP (unallocated)", type: 'equity', subtype: 'lp_capital' },
      { id: 'expense', fund_id: fund, vehicle_id: 'v', code: '5100', name: 'Partnership expenses', type: 'expense', subtype: 'partnership_expense' },
    ],
    journal_entries: [], journal_postings: [], bank_transactions: [],
  })
  prepare?.(m)
  const reads: Record<string, number> = {}
  const from = m.admin.from
  m.admin.from = (t: string) => {
    const q = from(t)
    const select = q.select
    q.select = (...a: any[]) => { reads[t] = (reads[t] ?? 0) + 1; return select(...a) }
    return q
  }
  const csv = ['Date,Description,Amount', ...Array.from({ length: n }, (_, i) => `2026-10-06,Software ${i},-${55 + i}`)].join('\n')
  const res = await importBankTransactions(m.admin, fund, 'Fund I', 'u', csv)
  return { res, m, lookups: Object.fromEntries(LOOKUPS.map(t => [t, reads[t] ?? 0])) }
}

describe('bank import and persistEntry lookups', () => {
  it('reads the lookups a constant number of times, not once per drafted row', async () => {
    const small = await importDrafts('f-small', 2)
    const large = await importDrafts('f-large', 30)

    expect(small.res).toMatchObject({ imported: 2, matched: 0, needsReview: 0, skipped: 0, errors: [] })
    expect(large.res).toMatchObject({ imported: 30, matched: 0, needsReview: 0, skipped: 0, errors: [] })
    expect(large.lookups).toEqual(small.lookups)
    expect(large.lookups.fund_settings).toBe(1)
    expect(large.lookups.fiscal_periods).toBe(1)
  })

  it('drafts every row exactly as before', async () => {
    const { m } = await importDrafts('f-rows', 3)
    expect(m.tables.journal_entries.map((e: any) => [e.status, e.vehicle_id])).toEqual([['draft', 'v'], ['draft', 'v'], ['draft', 'v']])
    expect(m.tables.bank_transactions.map((b: any) => b.status)).toEqual(['drafted', 'drafted', 'drafted'])
    expect(m.tables.journal_postings).toHaveLength(6)
  })

  it('refuses the whole import when the closed periods cannot be read, rather than reading them as none', async () => {
    const { res, m } = await importDrafts('f-periods', 3, m => m.failNext('fiscal_periods', 'select', 'connection reset'))

    expect(res).toEqual({ error: 'The closed periods could not be read: connection reset' })
    expect(m.tables.journal_entries).toEqual([])
    expect(m.tables.bank_transactions).toEqual([])
  })
})
