import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

// ── GPU fleet (P2) ── The fee true-up counts every live `gpu-fee:<vehicle>:<month>` entry as fee
// already booked. QA showed a typed 1,000 entry under that ref making the true-up post 4,000 instead
// of 5,000. The ref is reserved, so no user path can write one, and the true-up books the full fee.

const s = vi.hoisted(() => ({ m: null as any, n: 0 }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => s.m.admin }))
vi.mock('@/lib/api-helpers', () => ({
  assertWriteAccess: async () => ({ fundId: 'f', userId: 'u', role: 'admin', need: 'write' }),
  assertReadAccess: async () => ({ fundId: 'f', userId: 'u', role: 'admin', need: 'read' }),
}))
vi.mock('@/lib/accounting/http-vehicle', () => ({ resolveGroupOr400: async (_a: any, _g: any, raw: string) => raw }))
vi.mock('@/lib/access/effective', async orig => ({ ...(await orig<any>()), loadAccessContext: async () => ({ grants: {}, defaults: {}, features: {}, role: 'admin', vehicles: { all: true, ids: [] } }) }))
vi.mock('@/lib/accounting/vehicle-id', async orig => ({ ...(await orig<any>()), vehicleIdByName: async () => 'v1', vehicleNameById: async () => 'GPU I' }))
vi.mock('@/lib/accounting/persist', async orig => ({
  ...(await orig<any>()),
  persistEntry: vi.fn(async (_a: unknown, fundId: string, _g: string, _u: unknown, entry: any, status = 'posted') => {
    const id = `je-${++s.n}`
    s.m.tables.journal_entries.push({ id, fund_id: fundId, vehicle_id: 'v1', book: 'actual', status, entry_date: entry.entryDate, source_ref: entry.sourceRef ?? null, source_type: entry.sourceType })
    for (const p of entry.postings) s.m.tables.journal_postings.push({ journal_entry_id: id, book: 'actual', fund_id: fundId, account_id: p.accountId, amount: p.amount })
    return { entryId: id }
  }),
}))

import { POST } from '@/app/api/accounting/journal/route'
import { assertUserRefAllowed, isReservedSourceRef } from '@/lib/accounting/reserved-refs'
import { accrueGrossRevenueFee } from '@/lib/gpu/fee'
import { persistEntry } from '@/lib/accounting/persist'

beforeEach(() => {
  vi.clearAllMocks()
  s.n = 0
  s.m = memoryAdmin({
    fund_settings: [{ fund_id: 'f', currency: 'USD' }], vendors: [],
    fund_vehicles: [{ id: 'v1', fund_id: 'f', name: 'GPU I', kind: 'gpu_spv', aliases: [] }],
    chart_of_accounts: [
      { id: 'cash', code: '1000', subtype: 'cash' }, { id: 'rev', code: '4000', subtype: 'rental_revenue' },
      { id: 'fee', code: '5000', subtype: 'management_fee' }, { id: 'dtm', code: '2100', subtype: 'due_to_gp' },
    ].map(a => ({ ...a, fund_id: 'f', vehicle_id: 'v1', name: a.code, type: 'asset' })),
    journal_entries: [{ id: 'e-rev', fund_id: 'f', vehicle_id: 'v1', book: 'actual', status: 'posted', entry_date: '2027-01-15', source_type: 'income', source_ref: null }],
    journal_postings: [
      { journal_entry_id: 'e-rev', book: 'actual', fund_id: 'f', account_id: 'cash', amount: 100_000 },
      { journal_entry_id: 'e-rev', book: 'actual', fund_id: 'f', account_id: 'rev', amount: -100_000 },
    ],
    vehicle_fee_terms: [{ fund_id: 'f', vehicle_id: 'v1', basis: 'gross_revenue', annual_rate: 0.05, revenue_subtypes: ['rental_revenue'], frequency: 'monthly', payee_vehicle_id: null, effective_from: '2027-01-01', effective_to: null }],
    intercompany_transactions: [],
  })
})

describe('gpu-fee: is a reserved source_ref', () => {
  it('is on the reserved list, refused for every user path, round trip included', () => {
    expect(isReservedSourceRef('gpu-fee:v1:2027-01')).toBe(true)
    expect(assertUserRefAllowed('gpu-fee:v1:2027-01')).toMatch(/reserved/)
    expect(assertUserRefAllowed('gpu-fee:v1:2027-01', { allowRoundTrip: true })).toMatch(/reserved/)
  })

  it('a typed 1,000 fee entry under the month ref is refused, and the true-up still books 5,000', async () => {
    const typed = await POST(new NextRequest('https://x.test/api/accounting/journal', {
      method: 'POST',
      body: JSON.stringify({ group: 'GPU I', entryDate: '2027-01-31', sourceRef: 'gpu-fee:v1:2027-01', postings: [{ accountId: 'fee', amount: 1_000 }, { accountId: 'dtm', amount: -1_000 }] }),
    }))
    expect(typed.status).toBe(400)
    expect((await typed.json()).error).toMatch(/reserved/)
    expect(persistEntry).not.toHaveBeenCalled()

    expect(await accrueGrossRevenueFee(s.m.admin, 'f', 'GPU I', 'u', '2027-01')).toMatchObject({ delta: 5_000 })
  })
})
