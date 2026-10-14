import { describe, it, expect, vi, beforeEach } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

// A per-LP split is validated as it will be POSTED — each leg rounded once — so a split whose
// raw amounts total the outflow but whose rounded legs do not is refused, not booked as a cash
// movement a cent away from the bank's.

const persistEntry = vi.fn(async (admin: any, fundId: string, _g: string, _u: string, entry: any) => {
  await admin.from('journal_entries').insert({ id: 'je-1', fund_id: fundId, vehicle_id: 'v1', status: 'draft', book: 'actual' })
  persisted.push(entry)
  return { entryId: 'je-1' }
})
let persisted: any[] = []
vi.mock('./persist', async importOriginal => ({
  ...(await importOriginal<typeof import('./persist')>()),
  accountIdByCode: async () => new Map([['1000', 'cash']]),
  ensureCapitalAccounts: async () => new Map([['a', 'cap-a'], ['b', 'cap-b'], ['c', 'cap-c']]),
  persistEntry: (...args: unknown[]) => (persistEntry as any)(...args),
}))

import { bookDistributionFromOutflow, resolveDistributionSplit } from './bank-match'

// Raw total 314,518.254; rounded legs 314,452.56 + 4.17 + 61.53 = 314,518.26.
const split = () => new Map([['a', 314_452.559], ['b', 4.165], ['c', 61.53]])
const seed = (amount: number) => ({
  fund_vehicles: [{ id: 'v1', fund_id: 'f', name: 'Fund I' }],
  bank_transactions: [{ id: 't1', fund_id: 'f', vehicle_id: 'v1', amount, txn_date: '2026-06-30', description: 'Wire', status: 'unmatched', raw: null, journal_entry_id: null }],
})

beforeEach(() => { persistEntry.mockClear(); persisted = [] })

describe('booking a distribution from an outflow with a per-LP split', () => {
  it('refuses a split whose rounded legs miss the outflow by a cent, and writes nothing', async () => {
    const m = memoryAdmin(seed(-314_518.25))
    const out = await bookDistributionFromOutflow(m.admin, 'f', 'Fund I', 'u', 't1', split())
    expect(out).toEqual({ error: 'The per-LP amounts total 314518.26, but the transaction is 314518.25.' })
    expect(persistEntry).not.toHaveBeenCalled()
    expect(m.tables.journal_entries ?? []).toHaveLength(0)
    expect(m.tables.bank_transactions[0]).toMatchObject({ journal_entry_id: null, status: 'unmatched' })
  })

  it('books the same split against the outflow its rounded legs do total, cash equal to the bank', async () => {
    const m = memoryAdmin(seed(-314_518.26))
    const out = await bookDistributionFromOutflow(m.admin, 'f', 'Fund I', 'u', 't1', split())
    expect(out).toEqual({ entryId: 'je-1' })
    const cash = persisted[0].postings.find((p: any) => p.accountId === 'cash')
    expect(cash.amount).toBe(-314_518.26)
    expect(m.tables.bank_transactions[0].journal_entry_id).toBe('je-1')
  })
})

describe('resolveDistributionSplit rounding', () => {
  it('returns the rounded legs it validated', () => {
    const r = resolveDistributionSplit(314_518.26, { perLpOverride: split() })
    expect('perLp' in r && Object.fromEntries(r.perLp)).toEqual({ a: 314_452.56, b: 4.17, c: 61.53 })
  })
})
