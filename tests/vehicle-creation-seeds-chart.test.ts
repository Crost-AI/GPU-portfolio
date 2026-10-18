import { describe, it, expect, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

const s = vi.hoisted(() => ({ m: null as any, seeded: [] as string[], role: 'admin', fail: false, real: false, access: {} as any }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => s.m.admin }))
vi.mock('@/lib/api-helpers', async (orig) => ({ ...(await orig<any>()), assertWriteAccess: async () => ({ fundId: 'f', userId: 'u', role: s.role }) }))
vi.mock('@/lib/access/effective', async (orig) => ({ ...(await orig<any>()), loadAccessContext: async () => s.access }))
vi.mock('@/lib/access/scope', async (orig) => ({ ...(await orig<any>()), entityIdentityChangeDenial: () => null }))
vi.mock('@/lib/accounting/provision-accounts', async (orig) => {
  const real = await orig<any>()
  return { ensureVehicleAccounts: vi.fn(async (a: any, f: string, name: string) => {
    if (s.fail) throw new Error('boom')
    s.seeded.push(name)
    if (s.real) await real.ensureVehicleAccounts(a, f, name)
  }) }
})
import { POST as createVehicle, PATCH as updateVehicle } from '@/app/api/vehicles/route'
import { DEFAULT_CHART, GPU_SPV_CHART } from '@/lib/accounting/chart'
import { DEFAULT_FEATURE_VISIBILITY } from '@/lib/types/features'
import { POST as createManco } from '@/app/api/manco/vehicles/route'

const req = (body: object) => new NextRequest('http://x', { method: 'POST', body: JSON.stringify(body) })

describe('creating an entity seeds its chart', () => {
  it('a fund', async () => {
    s.m = memoryAdmin({ fund_vehicles: [] }); s.seeded = []
    expect((await createVehicle(req({ name: 'Fund IV', kind: 'fund' }))).status).toBe(200)
    expect(s.seeded).toEqual(['Fund IV'])
  })
  it('a management company', async () => {
    s.m = memoryAdmin({ fund_vehicles: [] }); s.seeded = []
    expect((await createManco(req({ name: 'Mgmt LLC' }))).status).toBe(200)
    expect(s.seeded).toEqual(['Mgmt LLC'])
  })
  it('a seed failure leaves the entity created and the creator granted', async () => {
    s.m = memoryAdmin({ fund_vehicles: [], fund_member_vehicles: [] }); s.seeded = []; s.role = 'member'; s.fail = true
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect((await createVehicle(req({ name: 'Fund V', kind: 'fund' }))).status).toBe(200)
      expect(s.m.tables.fund_member_vehicles).toHaveLength(1)
    } finally { s.role = 'admin'; s.fail = false; err.mockRestore() }
  })
})

// ── GPU fleet (P1) ──
const fleetAccess = (features: object, grants: object, role = 'member') => ({
  fundId: 'f', userId: 'u', role, vehicles: { all: true, ids: [] },
  features: { ...DEFAULT_FEATURE_VISIBILITY, accounting: 'everyone', ...features }, grants, defaults: { accounting: 'write' },
})
const FLEET_ON = { gpu_fleet: 'everyone' }
const patch = (body: object) => new NextRequest('http://x', { method: 'PATCH', body: JSON.stringify(body) })
const codes = (rows: any[], name: string) => rows.filter(r => r.portfolio_group === name).map(r => r.code).sort()

describe('creating a GPU SPV', () => {
  it('seeds GPU_SPV_CHART; a fund and an SPV still seed DEFAULT_CHART', async () => {
    s.m = memoryAdmin({ fund_vehicles: [], chart_of_accounts: [] }); s.seeded = []; s.real = true
    s.access = fleetAccess(FLEET_ON, { fleet: 'write' })
    try {
      for (const [name, kind] of [['H200 SPV I', 'gpu_spv'], ['Fund IV', 'fund'], ['Acme SPV', 'spv']]) {
        expect((await createVehicle(req({ name, kind }))).status, kind).toBe(200)
      }
      const chart = s.m.tables.chart_of_accounts
      expect(codes(chart, 'H200 SPV I')).toEqual(GPU_SPV_CHART.map(a => a.code).sort())
      expect(codes(chart, 'Fund IV')).toEqual(DEFAULT_CHART.map(a => a.code).sort())
      expect(codes(chart, 'Acme SPV')).toEqual(DEFAULT_CHART.map(a => a.code).sort())
    } finally { s.real = false; s.access = {} }
  })

  it('is refused without fleet write: switch off (admins included), or a member with only accounting', async () => {
    for (const access of [
      fleetAccess({}, {}, 'admin'),
      fleetAccess(FLEET_ON, { fleet: 'read' }),
      fleetAccess(FLEET_ON, { fleet: 'write', accounting: 'none' }),
    ]) {
      s.m = memoryAdmin({ fund_vehicles: [] }); s.seeded = []; s.access = access
      expect((await createVehicle(req({ name: 'H200 SPV I', kind: 'gpu_spv' }))).status).toBe(403)
      expect(s.m.tables.fund_vehicles).toEqual([])
    }
    s.access = {}
  })
})

describe('changing an entity into or out of a GPU SPV', () => {
  const seed = () => memoryAdmin({ fund_vehicles: [
    { id: 'v-fund', fund_id: 'f', name: 'Fund IV', kind: 'fund', aliases: [], active: true },
    { id: 'v-gpu', fund_id: 'f', name: 'H200 SPV I', kind: 'gpu_spv', aliases: [], active: true },
  ] })
  const kindOf = (id: string) => s.m.tables.fund_vehicles.find((v: any) => v.id === id).kind

  it('is refused in both directions, 409, even with fleet write: the chart would not match', async () => {
    for (const access of [fleetAccess({}, {}, 'admin'), fleetAccess(FLEET_ON, { fleet: 'write' }), fleetAccess(FLEET_ON, {}, 'admin')]) {
      s.m = seed(); s.access = access
      expect((await updateVehicle(patch({ id: 'v-fund', kind: 'gpu_spv' }))).status).toBe(409)
      expect((await updateVehicle(patch({ id: 'v-gpu', kind: 'spv' }))).status).toBe(409)
      expect([kindOf('v-fund'), kindOf('v-gpu')]).toEqual(['fund', 'gpu_spv'])
    }
    s.access = {}
  })

  it('a fund to SPV change, and re-sending a GPU SPV its own kind, work as before', async () => {
    s.m = seed(); s.access = fleetAccess({}, {})
    expect((await updateVehicle(patch({ id: 'v-fund', kind: 'spv' }))).status).toBe(200)
    expect(kindOf('v-fund')).toBe('spv')
    expect((await updateVehicle(patch({ id: 'v-gpu', kind: 'gpu_spv', active: false }))).status).toBe(200)
    expect(s.m.tables.fund_vehicles.find((v: any) => v.id === 'v-gpu')).toMatchObject({ kind: 'gpu_spv', active: false })
    s.access = {}
  })
})

describe('merging across GPU-ness', () => {
  const seed = () => memoryAdmin({ fund_vehicles: [
    { id: 'v-fund', fund_id: 'f', name: 'Fund IV', kind: 'fund', aliases: [], active: true },
    { id: 'v-spv', fund_id: 'f', name: 'Acme SPV', kind: 'spv', aliases: [], active: true },
    { id: 'v-gpu', fund_id: 'f', name: 'H200 SPV I', kind: 'gpu_spv', aliases: [], active: true },
    { id: 'v-gpu2', fund_id: 'f', name: 'H200 SPV II', kind: 'gpu_spv', aliases: [], active: true },
  ] })

  it('refuses a GPU SPV into a fund or an SPV, and either into a GPU SPV, 409, leaving all', async () => {
    for (const [from, into] of [['v-gpu', 'v-fund'], ['v-fund', 'v-gpu'], ['v-gpu', 'v-spv'], ['v-spv', 'v-gpu']]) {
      s.m = seed(); s.access = fleetAccess(FLEET_ON, { fleet: 'write' }, 'admin')
      const res = await updateVehicle(patch({ id: from, mergeIntoId: into }))
      expect(res.status, `${from} -> ${into}`).toBe(409)
      expect((await res.json()).error).toMatch(/only be merged with another GPU SPV/)
      expect(s.m.tables.fund_vehicles).toHaveLength(4)
    }
    s.access = {}
  })

  it('still merges two VC vehicles', async () => {
    s.m = seed(); s.access = fleetAccess({}, {}, 'admin')
    expect((await updateVehicle(patch({ id: 'v-spv', mergeIntoId: 'v-fund' }))).status).toBe(200)
    expect(s.m.tables.fund_vehicles.map((v: any) => v.id).sort()).toEqual(['v-fund', 'v-gpu', 'v-gpu2'])
    s.access = {}
  })

  it('still merges two GPU SPVs', async () => {
    s.m = seed(); s.access = fleetAccess(FLEET_ON, { fleet: 'write' }, 'admin')
    expect((await updateVehicle(patch({ id: 'v-gpu2', mergeIntoId: 'v-gpu' }))).status).toBe(200)
    expect(s.m.tables.fund_vehicles.map((v: any) => v.id).sort()).toEqual(['v-fund', 'v-gpu', 'v-spv'])
    expect(s.m.tables.fund_vehicles.find((v: any) => v.id === 'v-gpu').aliases).toContain('H200 SPV II')
    s.access = {}
  })
})
