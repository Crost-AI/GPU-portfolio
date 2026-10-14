import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// The account picker asks for the chart alone (no ?account); only a register needs the ledger.
const s = vi.hoisted(() => ({
  chart: [
    { id: 'a2', fundId: 'f', code: '2000', name: 'Payables', type: 'liability', subtype: null, lpEntityId: null, companyId: null },
    { id: 'a1', fundId: 'f', code: '1000', name: 'Cash', type: 'asset', subtype: null, lpEntityId: null, companyId: null },
  ] as any[],
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/api-helpers', async (orig) => ({ ...(await orig<any>()), assertReadAccess: async () => ({ fundId: 'f', userId: 'u', role: 'admin', need: 'read' }) }))
vi.mock('@/lib/accounting/http-vehicle', () => ({ resolveGroupOr400: async () => 'Fund I' }))
vi.mock('@/lib/accounting/load', async (orig) => ({
  ...(await orig<any>()),
  loadPostedLedger: vi.fn(async () => ({ accounts: s.chart, postings: [], capitalPostings: [], sourcedPostings: [] })),
}))
vi.mock('@/lib/accounting/chart-load', () => ({ loadChart: vi.fn(async () => s.chart) }))
import { GET } from '@/app/api/accounting/ledger/route'
import { loadPostedLedger } from '@/lib/accounting/load'
import { loadChart } from '@/lib/accounting/chart-load'

const get = (qs: string) => GET(new NextRequest(`http://x/api/accounting/ledger?group=Fund%20I&preset=itd${qs}`))

describe('GET ledger', () => {
  beforeEach(() => { vi.mocked(loadPostedLedger).mockClear(); vi.mocked(loadChart).mockClear() })

  it('serves the picker from the chart alone, without loading the ledger', async () => {
    const res = await get('')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.register).toBeNull()
    expect(body.accounts.map((a: any) => a.code)).toEqual(['1000', '2000'])
    expect(body.accounts[0]).toEqual({ id: 'a1', code: '1000', name: 'Cash', type: 'asset', subtype: null, lpEntityId: null, companyId: null })
    expect(loadChart).toHaveBeenCalledWith(expect.anything(), 'f', 'Fund I')
    expect(loadPostedLedger).not.toHaveBeenCalled()
  })

  it('loads the ledger for an account register', async () => {
    const res = await get('&account=1000')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.register).not.toBeNull()
    expect(body.accounts.map((a: any) => a.code)).toEqual(['1000', '2000'])
    expect(loadPostedLedger).toHaveBeenCalledTimes(1)
  })
})
