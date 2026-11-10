import { describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

// The bank reconciliation route needs the feed's first date (upstream #114's opening balance) and
// every row, so it pages past PostgREST's row cap, as bank_reconciliation and close readiness do
// (Bugbot on #118).

const s = vi.hoisted(() => ({ m: null as any }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => s.m.admin }))
vi.mock('@/lib/api-helpers', async (orig) => ({ ...(await orig<any>()), assertReadAccess: async () => ({ fundId: 'f', userId: 'u', role: 'member' }) }))
vi.mock('@/lib/accounting/http-vehicle', () => ({ resolveGroupOr400: async () => 'Fund I' }))
vi.mock('@/lib/accounting/vehicle-id', async (orig) => ({ ...(await orig<any>()), vehicleIdByName: async () => 'v1' }))
vi.mock('@/lib/accounting/load', async (orig) => ({
  ...(await orig<any>()),
  loadPostedLedger: async () => ({
    accounts: [{ id: 'cash', code: '1000', name: 'Cash', type: 'asset', subtype: 'cash' }],
    // Cash from mid-2020: after the feed's real first row, before the first row a capped read sees.
    postings: [{ accountId: 'cash', amount: 500, currency: 'USD', entryDate: '2020-06-01' }],
    sourcedPostings: [],
  }),
}))
import { GET } from '@/app/api/accounting/bank/reconcile/route'

describe('GET /api/accounting/bank/reconcile', () => {
  it('reads the whole feed past the row cap: every row, and its true first date', async () => {
    // The feed's earliest row sorts last by id, so a capped read loses it and some of the others.
    const rows = Array.from({ length: 1004 }, (_, i) => ({ id: `a-${String(i).padStart(4, '0')}`, fund_id: 'f', vehicle_id: 'v1', txn_date: '2021-01-01', amount: 1, status: 'reconciled', journal_entry_id: null }))
    rows.push({ id: 'z-first', fund_id: 'f', vehicle_id: 'v1', txn_date: '2020-01-01', amount: 1, status: 'reconciled', journal_entry_id: null })
    s.m = memoryAdmin({ bank_transactions: rows }, { maxRows: 1000 })
    const res = await GET(new NextRequest('http://localhost/api/accounting/bank/reconcile?group=Fund%20I'))
    // No opening balance (nothing before the true first date), and all 1005 rows: 1005, not 1500.
    expect((await res.json()).bankEndingBalance).toBe(1005)
  })
})
