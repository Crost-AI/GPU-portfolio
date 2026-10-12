import { describe, it, expect, vi, beforeEach } from 'vitest'

// Entity groups: managed by admins only, an entity can only be put in its own fund's group, and the
// read route shows a scoped member only the entities (and groups) they can see.

const m = vi.hoisted(() => ({
  role: 'admin',
  access: { vehicles: { all: true, ids: [] as string[] } },
  groups: [] as any[],
  vehicles: [] as any[],
  updates: [] as { table: string; row: any; eqs: [string, unknown][] }[],
}))

function chain(table: string) {
  const eqs: [string, unknown][] = []
  let op: 'select' | 'update' = 'select'
  let row: any = null
  const rows = () => {
    const src = table === 'vehicle_groups' ? m.groups : table === 'fund_vehicles' ? m.vehicles : []
    return src.filter(r => eqs.every(([k, v]) => r[k] === v))
  }
  const c: any = {
    select: () => c, order: () => c, limit: () => c, not: () => c,
    eq: (k: string, v: unknown) => { eqs.push([k, v]); return c },
    update: (r: any) => { op = 'update'; row = r; return c },
    maybeSingle: async () => (table === 'fund_members'
      ? { data: { fund_id: 'f1', role: m.role }, error: null }
      : { data: rows()[0] ?? null, error: null }),
    then: (res: any) => {
      if (op === 'update') m.updates.push({ table, row, eqs })
      return res({ data: rows(), error: null })
    },
  }
  return c
}

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: (t: string) => chain(t) }) }))
vi.mock('@/lib/access/effective', async (orig) => ({ ...(await orig<any>()), loadAccessContext: async () => m.access }))

import { PATCH, POST } from '@/app/api/settings/vehicle-groups/route'
import { GET as getGroups } from '@/app/api/vehicle-groups/route'

const req = (method: string, body: unknown) => new Request('http://x', { method, body: JSON.stringify(body) }) as any

beforeEach(() => {
  m.role = 'admin'
  m.access = { vehicles: { all: true, ids: [] } }
  m.groups = [
    { id: 'g1', fund_id: 'f1', name: 'Flagship', position: 0 },
    { id: 'gX', fund_id: 'f2', name: 'Elsewhere', position: 0 },
  ]
  m.vehicles = [
    { id: 'v1', fund_id: 'f1', name: 'Fund I', aliases: [], group_id: 'g1' },
    { id: 'v2', fund_id: 'f1', name: 'SPV A', aliases: [], group_id: null },
  ]
  m.updates = []
})

describe('api/settings/vehicle-groups', () => {
  it('refuses a non-admin', async () => {
    m.role = 'member'
    expect((await POST(req('POST', { name: 'SPVs' }))).status).toBe(403)
    expect((await PATCH(req('PATCH', { vehicleId: 'v2', groupId: 'g1' }))).status).toBe(403)
  })

  it('puts an entity in its own fund’s group', async () => {
    const res = await PATCH(req('PATCH', { vehicleId: 'v2', groupId: 'g1' }))
    expect(res.status).toBe(200)
    const u = m.updates.find(x => x.table === 'fund_vehicles')!
    expect(u.row.group_id).toBe('g1')
    expect(u.eqs).toContainEqual(['fund_id', 'f1'])
  })

  it('refuses another fund’s group', async () => {
    const res = await PATCH(req('PATCH', { vehicleId: 'v2', groupId: 'gX' }))
    expect(res.status).toBe(404)
    expect(m.updates).toHaveLength(0)
  })
})

describe('api/vehicle-groups', () => {
  it('shows a scoped member only their entities and the groups holding them', async () => {
    m.access = { vehicles: { all: false, ids: ['v2'] } }
    const body = await (await getGroups()).json()
    expect(body.assignments).toEqual([])
    expect(body.groups).toEqual([])
  })

  it('lists every assignment for a caller who sees every entity', async () => {
    const body = await (await getGroups()).json()
    expect(body.groups.map((g: any) => g.id)).toEqual(['g1'])
    expect(body.assignments).toEqual([{ vehicleId: 'v1', name: 'Fund I', aliases: [], groupId: 'g1' }])
  })
})
