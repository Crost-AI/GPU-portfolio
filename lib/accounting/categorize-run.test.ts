import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ createMessage: vi.fn() }))
vi.mock('@/lib/ai', () => ({
  createFundAIProviderWithOverride: async () => ({ provider: { createMessage: mocks.createMessage }, model: 'test-model' }),
}))
vi.mock('@/lib/ai/keyless', () => ({ fundHasAIKey: async () => true, noKeyMessage: () => 'no key' }))
vi.mock('./load', () => ({
  loadPostedLedger: async () => ({ accounts: [
    { id: 'cash', code: '1000', name: 'Cash', type: 'asset' },
    { id: 'suspense', code: '1999', name: 'Suspense', type: 'asset' },
    { id: 'legal', code: '5200', name: 'Legal fees', type: 'expense' },
  ] }),
}))
vi.mock('./persist', () => ({
  accountIdByCode: async () => new Map([['1000', 'cash'], ['1999', 'suspense'], ['5200', 'legal']]),
}))
vi.mock('./vehicle-id', () => ({ vehicleIdByName: async () => 'vehicle' }))
import { runCategorization } from './categorize-run'

const TXN = { id: 'txn-1', journal_entry_id: 'entry-1', txn_date: '2026-03-01', amount: -500, description: 'Law firm', counterparty: null, raw: {} }

/** A mocked admin: the bank read, the postings read, the RPC, and a record of every direct write. */
function admin(opts: { rpc?: { data: unknown; error: unknown }; bankError?: { message: string } } = {}) {
  const writes: { table: string; op: string }[] = []
  const rpc = vi.fn(async () => opts.rpc ?? { data: true, error: null })
  const from = (table: string) => {
    const result = table === 'bank_transactions'
      ? { data: opts.bankError ? null : [TXN], error: opts.bankError ?? null }
      : table === 'journal_postings'
        ? { data: [{ id: 'p-cash', account_id: 'cash', amount: -500 }, { id: 'p-counter', account_id: 'suspense', amount: 500 }], error: null }
        : { data: null, error: null }
    const q: any = {
      select: () => q, eq: () => q, in: () => q, not: () => q, maybeSingle: async () => result,
      update: () => { writes.push({ table, op: 'update' }); return q },
      insert: () => { writes.push({ table, op: 'insert' }); return q },
      delete: () => { writes.push({ table, op: 'delete' }); return q },
      then: (ok: any, bad: any) => Promise.resolve(result).then(ok, bad),
    }
    return q
  }
  return { client: { from, rpc } as any, rpc, writes }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.createMessage.mockResolvedValue({ text: JSON.stringify([{ id: 'txn-1', accountCode: '5200', sourceType: 'partnership_expense' }]) })
})

describe('runCategorization applies each result in one draft-guarded call', () => {
  it('counts a row as updated only when the function applied it', async () => {
    const a = admin()
    const res = await runCategorization(a.client, 'fund', 'Fund I')
    expect(res).toEqual({ considered: 1, updated: 1, errors: [] })
    expect(a.rpc).toHaveBeenCalledWith('apply_bank_categorization', expect.objectContaining({
      p_fund_id: 'fund', p_entry_id: 'entry-1', p_posting_id: 'p-counter', p_account_id: 'legal',
      p_source_type: 'partnership_expense', p_bank_txn_id: 'txn-1', p_account_code: '5200',
      p_raw: { categorization: expect.objectContaining({ by: 'ai' }) },
    }))
    // The three writes happen inside the function, never as separate requests.
    expect(a.writes).toEqual([])
  })

  it('reports a skip, not an update, when the entry was posted in the meantime', async () => {
    const a = admin({ rpc: { data: false, error: null } })
    const res = await runCategorization(a.client, 'fund', 'Fund I')
    expect(res).toEqual({ considered: 1, updated: 0, errors: ['txn-1: skipped — its entry is no longer a draft'] })
    expect(a.writes).toEqual([])
  })

  it('reports a failed apply as an error and does not count it', async () => {
    const a = admin({ rpc: { data: null, error: { message: 'Posting p-counter is no longer on entry entry-1' } } })
    const res = await runCategorization(a.client, 'fund', 'Fund I')
    expect(res).toEqual({ considered: 1, updated: 0, errors: ['txn-1: Posting p-counter is no longer on entry entry-1'] })
    expect(a.writes).toEqual([])
  })

  it('returns the error when the bank transactions cannot be read, rather than "nothing to do"', async () => {
    const a = admin({ bankError: { message: 'statement timeout' } })
    const res = await runCategorization(a.client, 'fund', 'Fund I')
    expect(res).toEqual({ error: 'The bank transactions could not be read: statement timeout' })
    expect(a.rpc).not.toHaveBeenCalled()
  })
})
