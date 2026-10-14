import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// GET /api/accounting/receipts runs the real resolveGroupOr400 chain; only the access RPC and the
// reads around it are stubbed. One request, one access_context.
const s = vi.hoisted(() => ({ listed: [] as any[] }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => {
      const chain: any = { select: () => chain, eq: () => chain, in: () => chain, contains: () => chain, maybeSingle: async () => ({ data: { kind: 'fund' }, error: null }) }
      return chain
    },
  }),
}))
vi.mock('@/lib/api-helpers', async (orig) => ({ ...(await orig<any>()), assertReadAccess: async () => ({ fundId: 'f1', userId: 'u1', role: 'member', need: 'read' }) }))
vi.mock('@/lib/access/effective', async (orig) => ({ ...(await orig<any>()), loadAccessContext: vi.fn() }))
vi.mock('@/lib/accounting/vehicle-resolver', async (orig) => ({ ...(await orig<any>()), resolveVehicle: async () => 'Fund I' }))
vi.mock('@/lib/accounting/vehicle-id', () => ({ vehicleIdByName: async () => 'v1' }))
vi.mock('@/lib/accounting/receipts', async (orig) => ({
  ...(await orig<any>()),
  listReceipts: vi.fn(async (_a: any, _f: string, opts: any) => { s.listed.push(opts); return [] }),
}))
import { GET } from '@/app/api/accounting/receipts/route'
import { loadAccessContext } from '@/lib/access/effective'

const sees = (vehicles: { all: boolean; ids: string[] }) => vi.mocked(loadAccessContext).mockResolvedValue({
  fundId: 'f1', userId: 'u1', role: 'member', features: {} as any, grants: {}, defaults: {}, vehicles,
})
const get = () => GET(new NextRequest('http://x/api/accounting/receipts?group=Fund%20I'))

describe('GET receipts resolves access once', () => {
  beforeEach(() => { s.listed = []; vi.mocked(loadAccessContext).mockReset() })

  it('includes the unassigned receipts for a caller who sees every entity', async () => {
    sees({ all: true, ids: [] })
    expect((await get()).status).toBe(200)
    expect(loadAccessContext).toHaveBeenCalledTimes(1)
    expect(s.listed).toEqual([expect.objectContaining({ vehicleId: 'v1', includeUnassigned: true })])
  })

  it('leaves them out for a caller granted only this entity', async () => {
    sees({ all: false, ids: ['v1'] })
    expect((await get()).status).toBe(200)
    expect(loadAccessContext).toHaveBeenCalledTimes(1)
    expect(s.listed).toEqual([expect.objectContaining({ vehicleId: 'v1', includeUnassigned: false })])
  })

  it('still refuses an entity the caller was not granted', async () => {
    sees({ all: false, ids: ['v2'] })
    expect((await get()).status).toBe(403)
    expect(s.listed).toEqual([])
  })
})
