// list_receipts' match suggestions: opt-in, capped, and computed with bounded concurrency — never
// two serial reads per receipt for every receipt on the entity.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const s = vi.hoisted(() => ({ receipts: [] as any[], calls: 0, inFlight: 0, maxInFlight: 0, failOn: null as string | null }))

vi.mock('@/lib/accounting/vehicle-id', () => ({ vehicleIdByName: async () => 'v1' }))
vi.mock('@/lib/accounting/persist', () => ({ accountIdByCode: async () => new Map() }))
vi.mock('@/lib/accounting/http-vehicle', () => ({ resolveVehicleWithAccess: async () => { throw new Error('unused') } }))
vi.mock('@/lib/accounting/partnership-invoices', () => ({}))
vi.mock('@/lib/accounting/receipts', () => ({
  listReceipts: async () => s.receipts,
  getReceipt: async (_a: unknown, _f: unknown, id: string) => s.receipts.find(r => r.id === id) ?? null,
  receiptFileUrl: async () => 'https://files/r',
  matchCandidates: async (_a: unknown, _f: unknown, r: any) => {
    s.calls++
    s.inFlight++
    s.maxInFlight = Math.max(s.maxInFlight, s.inFlight)
    await new Promise(res => setTimeout(res, 1))
    s.inFlight--
    if (r.id === s.failOn) throw new Error('match failed')
    return [{ kind: 'entry', id: `je-${r.id}` }]
  },
}))

import { RECEIPT_HANDLERS } from './receipt-tools'

const ctx = { admin: {} as any, fundId: 'f1', portfolioGroup: 'Fund I', userId: 'u1', access: { vehicles: { all: false, ids: ['v1'] } } as any }
const receipt = (i: number, over: Record<string, unknown> = {}) => ({
  id: `r${i}`, fund_id: 'f1', vehicle_id: 'v1', status: 'unmatched', amount: 100 + i, receipt_date: '2026-09-01', ...over,
})

beforeEach(() => {
  s.calls = 0
  s.inFlight = 0
  s.maxInFlight = 0
  s.failOn = null
})

describe('list_receipts suggestions', () => {
  it('computes no suggestions unless asked, and says how to get them', async () => {
    s.receipts = Array.from({ length: 200 }, (_, i) => receipt(i))

    const res = await RECEIPT_HANDLERS.list_receipts(ctx, {})

    expect(s.calls).toBe(0)
    expect(res.receipts).toHaveLength(200)
    expect(res.receipts.every((r: any) => r.suggestions === undefined)).toBe(true)
    expect(res.note).toMatch(/includeSuggestions/)
    expect(res.note).toMatch(/get_receipt/)
  })

  it('with includeSuggestions, computes at most 40, at most 5 at a time, and flags the truncation', async () => {
    s.receipts = Array.from({ length: 200 }, (_, i) => receipt(i))

    const res = await RECEIPT_HANDLERS.list_receipts(ctx, { includeSuggestions: true })

    expect(s.calls).toBe(40)
    expect(s.maxInFlight).toBeLessThanOrEqual(5)
    expect(s.maxInFlight).toBeGreaterThan(1)
    expect(res.suggestionsTruncated).toBe(true)
    expect(res.note).toMatch(/get_receipt/)
    // the first 40 in list order carry their own suggestions; the rest carry none
    expect(res.receipts.slice(0, 40).every((r: any) => r.suggestions?.[0]?.id === `je-${r.id}`)).toBe(true)
    expect(res.receipts.slice(40).every((r: any) => r.suggestions === undefined)).toBe(true)
  })

  it('stops taking new receipts once one suggestion fails', async () => {
    s.receipts = Array.from({ length: 200 }, (_, i) => receipt(i))
    s.failOn = 'r0'

    await expect(RECEIPT_HANDLERS.list_receipts(ctx, { includeSuggestions: true })).rejects.toThrow('match failed')

    // the 5 already in flight finish; nothing past them is started
    expect(s.calls).toBe(5)
  })

  it('only suggests for unmatched receipts filed here, and does not flag a list under the cap', async () => {
    s.receipts = [
      receipt(1),
      receipt(2, { status: 'matched' }),
      receipt(3, { vehicle_id: null }),
      receipt(4, { amount: null }),
    ]

    const res = await RECEIPT_HANDLERS.list_receipts(ctx, { includeSuggestions: true })

    expect(s.calls).toBe(1)
    expect(res.suggestionsTruncated).toBeUndefined()
    expect(res.receipts.map((r: any) => r.suggestions)).toEqual([[{ kind: 'entry', id: 'je-r1' }], undefined, undefined, []])
  })
})

describe('get_receipt', () => {
  it('still returns suggestions for one unmatched receipt', async () => {
    s.receipts = [receipt(7)]

    const res = await RECEIPT_HANDLERS.get_receipt(ctx, { receiptId: 'r7' })

    expect(s.calls).toBe(1)
    expect(res.suggestions).toEqual([{ kind: 'entry', id: 'je-r7' }])
  })
})
