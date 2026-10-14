import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ persist: vi.fn(), currency: vi.fn() }))
vi.mock('./persist', () => ({ persistEntry: mocks.persist }))
vi.mock('./currency', () => ({ fundCurrency: mocks.currency }))
vi.mock('./vendors', () => ({ ensureVendor: async () => ({ id: 'vendor-1' }) }))
vi.mock('./intercompany', () => ({ ensureIntercompanyAccounts: vi.fn() }))
import { draftEntryFromReceipt } from './receipts'

const receipt = (over: Record<string, unknown> = {}) => ({
  id: 'rcpt-1', fund_id: 'fund', vehicle_id: 'vehicle', vendor_name: 'Hotel Adlon', description: 'Board dinner',
  receipt_date: '2026-03-10', amount: 100, currency: 'EUR', journal_entry_id: null, status: 'unmatched', ...over,
})

/** getReceipt, the entry check in attachReceipt, and the attach update all read one row. */
function admin(row: Record<string, unknown>) {
  const from = (table: string) => {
    const result = { data: table === 'journal_entries' ? { id: 'entry-1', vehicle_id: 'vehicle', status: 'draft' } : row, error: null }
    const q: any = { select: () => q, eq: () => q, update: () => q, maybeSingle: async () => result, single: async () => result }
    return q
  }
  return { from } as any
}

const draft = (row: Record<string, unknown>, reportingAmount?: number) =>
  draftEntryFromReceipt(admin(row), 'fund', 'Fund I', 'vehicle', 'user', 'rcpt-1', {
    debitAccountId: 'travel', creditAccountId: 'card', reportingAmount,
  })

beforeEach(() => {
  vi.clearAllMocks()
  mocks.currency.mockResolvedValue('USD')
  mocks.persist.mockResolvedValue({ entryId: 'entry-1' })
})

describe('drafting an entry from a receipt in another currency', () => {
  it('refuses a EUR receipt in a USD fund without the USD amount, and writes nothing', async () => {
    const res = await draft(receipt())
    expect(res).toEqual({
      error: 'This receipt is in EUR; the books are kept in USD. Enter the USD amount to draft it. If the currency was misread, correct it on the receipt.',
      status: 400,
    })
    expect(mocks.persist).not.toHaveBeenCalled()
  })

  it('refuses a reporting amount that rounds to zero cents rather than booking a zero entry', async () => {
    const res = await draft(receipt(), 0.004)
    expect(res).toMatchObject({ status: 400, error: expect.stringContaining('Enter the USD amount') })
    expect(mocks.persist).not.toHaveBeenCalled()
  })

  it.each([true, '108.50'])('refuses a reporting amount of %j that is not a number', async value => {
    expect(await draft(receipt(), value as any)).toMatchObject({ status: 400 })
    expect(mocks.persist).not.toHaveBeenCalled()
  })

  it('books the reporting-currency amount and keeps the receipt figure in the memo', async () => {
    const res = await draft(receipt(), 108.5)
    expect(res).toMatchObject({ entryId: 'entry-1' })
    const entry = mocks.persist.mock.calls[0][4]
    expect(entry.postings).toEqual([
      { accountId: 'travel', amount: 108.5, currency: 'USD', lpEntityId: null },
      { accountId: 'card', amount: -108.5, currency: 'USD', lpEntityId: null },
    ])
    expect(entry.memo).toBe('Hotel Adlon — Board dinner (EUR 100.00 on receipt)')
  })

  it('drafts a receipt in the fund\'s own currency at its own amount', async () => {
    await draft(receipt({ currency: 'usd' }))
    const entry = mocks.persist.mock.calls[0][4]
    expect(entry.postings[0]).toMatchObject({ amount: 100, currency: 'USD' })
    expect(entry.memo).toBe('Hotel Adlon — Board dinner')
  })

  it('takes a receipt with no currency to be in the fund\'s currency', async () => {
    mocks.currency.mockResolvedValue('EUR')
    await draft(receipt({ currency: null }))
    const entry = mocks.persist.mock.calls[0][4]
    expect(entry.postings[0]).toMatchObject({ amount: 100, currency: 'EUR' })
  })

  it('refuses when the fund\'s currency cannot be read, rather than assuming dollars', async () => {
    mocks.currency.mockRejectedValue(new Error("The fund's currency could not be read: timeout"))
    const res = await draft(receipt({ currency: null }))
    expect(res).toEqual({ error: "The fund's currency could not be read: timeout", status: 400 })
    expect(mocks.persist).not.toHaveBeenCalled()
  })
})
