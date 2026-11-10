import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

// ── GPU fleet (P3) ── #129: upstream #181's `GET /api/companies?holdings=all` (the Jump to palette)
// drops the holding-type filter, so it must leave out a GPU SPV's fleet company for a caller
// without fleet read (#91), as every other per-row reader does.

const s = vi.hoisted(() => ({ m: null as any, access: null as any }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => s.m.admin }))
vi.mock('@/lib/access/entity-scope', async (orig) => ({ ...(await orig<any>()), loadEntityScopeForUser: async () => ({ companyIds: null, vehicleNames: null }) }))
vi.mock('@/lib/access/effective', async (orig) => ({ ...(await orig<any>()), loadAccessContext: async () => s.access }))
import { GET } from '@/app/api/companies/route'

const member = (fleet: 'none' | 'read') => ({
  fundId: 'f', userId: 'u', role: 'member', features: { gpu_fleet: 'everyone', accounting: 'everyone' },
  grants: { portfolio: 'read', accounting: 'read', fleet }, defaults: {}, vehicles: { all: true, ids: [] },
})

beforeEach(() => {
  s.m = memoryAdmin({
    fund_members: [{ fund_id: 'f', user_id: 'u', role: 'member' }],
    companies: [
      { id: 'acme', fund_id: 'f', name: 'Acme', status: 'active', holding_type: 'company', tags: [] },
      { id: 'fof', fund_id: 'f', name: 'Example Fund I', status: 'active', holding_type: 'fund', tags: [] },
      { id: 'fleet-co', fund_id: 'f', name: 'GPU fleet', status: 'active', holding_type: 'gpu_fleet', tags: [] },
    ],
  })
})

const list = async (q = '') => (await (await GET(new NextRequest(`http://localhost/api/companies${q}`))).json()).map((c: any) => c.id)

describe('GET /api/companies?holdings=all and a fleet company', () => {
  it('leaves the fleet company out for a caller without fleet read', async () => {
    s.access = member('none')
    expect((await list('?holdings=all')).sort()).toEqual(['acme', 'fof'])
  })

  it('lists it for a caller with fleet read', async () => {
    s.access = member('read')
    expect((await list('?holdings=all')).sort()).toEqual(['acme', 'fleet-co', 'fof'])
  })

  it('the default list is companies only, as before', async () => {
    s.access = member('read')
    expect(await list()).toEqual(['acme'])
  })
})
