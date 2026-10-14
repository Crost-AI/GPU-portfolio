// Matched and held bank rows are written in one batched insert, not one request per row — with
// the same counters, and the same "lost the claim → hold it for review" outcome on a conflict.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

const s = vi.hoisted(() => ({ m: null as any, drafts: 0, bankInserts: [] as any[] }))
vi.mock('@/lib/accounting/persist', () => ({
  accountIdByCode: async () => new Map([['1000', 'cash'], ['5100', 'expense']]),
  buildPersistContext: async (_a: any, _f: string, _g: string, known: any) => ({ currency: 'USD', closedRanges: [], vehicleId: known.vehicleId, accountIds: known.accountIds }),
  persistEntry: vi.fn(async (_a: any, fundId: string, _g: string, _u: any, entry: any, status: string) => {
    const id = `draft-${++s.drafts}`
    s.m.tables.journal_entries.push({ id, fund_id: fundId, vehicle_id: 'v', book: 'actual', status, source_type: entry.sourceType, entry_date: entry.entryDate })
    return { entryId: id }
  }),
}))
vi.mock('@/lib/accounting/vehicle-id', () => ({ vehicleIdByName: async () => 'v', vehicleNameById: async () => 'Fund I' }))
vi.mock('@/lib/accounting/provision-accounts', () => ({ ensureVehicleAccounts: async () => {} }))
vi.mock('@/lib/accounting/vendors', () => ({ vendorResolver: () => async () => null }))
vi.mock('@/lib/accounting/import-review', () => ({ reviewImport: async () => ({ differences: [], token: 't' }) }))
import { importBankTransactions } from '@/lib/accounting/bank-import'

const id = (i: number) => `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`
/** A posted investment entry whose cash leg is `amount` — a bank row of that amount matches it. */
const entry = (i: number, amount: number) => ({
  id: id(i), fund_id: 'f', vehicle_id: 'v', book: 'actual', status: 'posted', entry_date: '2026-10-05',
  memo: `Investment ${i}`, source_ref: `txn:${id(i)}`, source_type: 'investment', _cash: amount,
})

function seed(entries: ReturnType<typeof entry>[], race?: (payload: any, tables: any) => void) {
  s.drafts = 0
  s.bankInserts = []
  s.m = memoryAdmin({
    journal_entries: entries.map(({ _cash, ...e }) => e),
    journal_postings: entries.map(e => ({ journal_entry_id: e.id, book: 'actual', fund_id: 'f', account_id: 'cash', amount: e._cash })),
    bank_transactions: [],
    chart_of_accounts: [
      { id: 'cash', fund_id: 'f', vehicle_id: 'v', code: '1000', name: 'Cash', type: 'asset', subtype: 'cash' },
      { id: 'lp', fund_id: 'f', vehicle_id: 'v', code: '3100', name: "Partners' capital — LP (unallocated)", type: 'equity', subtype: 'lp_capital' },
      { id: 'expense', fund_id: 'f', vehicle_id: 'v', code: '5100', name: 'Partnership expenses', type: 'expense', subtype: 'partnership_expense' },
    ],
    investment_transactions: entries.map(e => ({ id: e.id, fund_id: 'f' })),
  }, {
    unique: [
      { table: 'bank_transactions', key: (r: any) => r.journal_entry_id ?? null },
      { table: 'bank_transactions', key: (r: any) => (r.dedup_hash ? `${r.vehicle_id}|${r.dedup_hash}` : null) },
    ],
    before: (table: string, op: string, payload: any, tables: any) => {
      if (table !== 'bank_transactions' || op !== 'insert') return
      s.bankInserts.push(payload)
      race?.(payload, tables)
    },
  })
}
const csv = (rows: [string, string, number][]) => ['Date,Description,Amount', ...rows.map(r => r.join(','))].join('\n')
const ingest = (text: string) => importBankTransactions(s.m.admin, 'f', 'Fund I', 'u', text)
const bank = () => s.m.tables.bank_transactions as any[]

beforeEach(() => { s.drafts = 0 })

describe('bank import batches matched and held rows', () => {
  it('writes 50 matched rows with one insert, with the counters unchanged', async () => {
    const entries = Array.from({ length: 50 }, (_, i) => entry(i + 1, -(1000 + i)))
    seed(entries)

    const res = await ingest(csv(entries.map((e, i) => ['2026-10-06', `Wire ${i}`, e._cash])))

    expect(res).toMatchObject({ imported: 50, matched: 50, needsReview: 0, skipped: 0, errors: [] })
    expect(s.bankInserts).toHaveLength(1)
    expect(s.bankInserts[0]).toHaveLength(50)
    expect(bank().every(r => r.status === 'reconciled')).toBe(true)
    expect(new Set(bank().map(r => r.journal_entry_id))).toEqual(new Set(entries.map(e => e.id)))
    expect(s.drafts).toBe(0)
  })

  it('drafts unmatched rows one by one as before, alongside the batched matched rows', async () => {
    seed([entry(1, -1000), entry(2, -2000)])

    const res = await ingest(csv([['2026-10-06', 'Wire A', -1000], ['2026-10-06', 'Software', -55], ['2026-10-06', 'Wire B', -2000]]))

    expect(res).toMatchObject({ imported: 3, matched: 2, needsReview: 0 })
    expect(s.drafts).toBe(1)
    // the drafted row's own insert, then one batch for both matched rows
    expect(s.bankInserts.map(p => (Array.isArray(p) ? p.length : 'row'))).toEqual(['row', 2])
    expect(bank().map(r => r.status).sort()).toEqual(['drafted', 'reconciled', 'reconciled'])
  })

  it('a claim lost to a concurrent import inside a batch still holds that row for review', async () => {
    const E1 = id(1)
    seed([entry(1, -1000), entry(2, -2000)], (payload, tables) => {
      // A concurrent import claims E1 just before our batch lands.
      if (Array.isArray(payload) && !tables.bank_transactions.length) {
        tables.bank_transactions.push({ id: 'racer', vehicle_id: 'v', journal_entry_id: E1, dedup_hash: 'other' })
      }
    })

    const res = await ingest(csv([['2026-10-06', 'Wire A', -1000], ['2026-10-06', 'Wire B', -2000]]))

    expect(res).toMatchObject({ imported: 2, matched: 1, needsReview: 1, errors: [] })
    const ours = bank().filter(r => r.id !== 'racer')
    expect(ours.find(r => r.description === 'Wire A')).toMatchObject({ status: 'unmatched', journal_entry_id: null })
    expect(ours.find(r => r.description === 'Wire B')).toMatchObject({ status: 'reconciled', journal_entry_id: id(2) })
    // the batch, then row by row: A's claim, A held, B
    expect(s.bankInserts.map(p => (Array.isArray(p) ? p.length : p.journal_entry_id))).toEqual([2, E1, null, id(2)])
  })

  it('retries a batch that failed for another reason row by row, so one bad request loses nothing', async () => {
    seed([entry(1, -1000), entry(2, -2000)])
    s.m.failNext('bank_transactions', 'insert', 'value too long for type character varying')

    const res = await ingest(csv([['2026-10-06', 'Wire A', -1000], ['2026-10-06', 'Wire B', -2000]]))

    // the batch fails as a whole, then each row lands on its own
    expect(res).toMatchObject({ imported: 2, matched: 2, needsReview: 0, errors: [] })
    expect(bank()).toHaveLength(2)
  })
})
