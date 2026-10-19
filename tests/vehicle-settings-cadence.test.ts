import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

// ── GPU fleet (P2) ── a vehicle's distribution cadence (Karl, Q4) on the vehicle-settings route:
// default quarterly, settable by an accounting writer, any other value refused.

const s = vi.hoisted(() => ({ m: null as any }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => s.m.admin }))
vi.mock('@/lib/api-helpers', async orig => ({ ...(await orig<any>()), assertWriteAccess: async () => ({ fundId: 'f', userId: 'u', role: 'member' }), assertReadAccess: async () => ({ fundId: 'f', userId: 'u', role: 'member' }) }))
vi.mock('@/lib/accounting/http-vehicle', () => ({ resolveGroupOr400: async () => 'GPU I' }))
vi.mock('@/lib/accounting/vehicle-id', () => ({ vehicleIdByName: async () => 'v1' }))

import { GET, PATCH } from '@/app/api/accounting/vehicle-settings/route'

const get = async () => (await GET(new NextRequest('http://localhost/api/accounting/vehicle-settings?group=GPU%20I'))).json()
const patch = (body: object) => PATCH(new NextRequest('http://localhost/api/accounting/vehicle-settings', { method: 'PATCH', body: JSON.stringify({ group: 'GPU I', ...body }) }))

beforeEach(() => { s.m = memoryAdmin({ vehicle_accounting_settings: [] }, { unique: [{ table: 'vehicle_accounting_settings', key: r => `${r.fund_id}|${r.vehicle_id}` }] }) })

describe('vehicle-settings: distributionCadence', () => {
  it('reads quarterly before anything is set', async () => {
    expect(await get()).toMatchObject({ distributionCadence: 'quarterly' })
  })

  it.each(['monthly', 'quarterly', 'annual', 'ad_hoc'])('round-trips %s', async cadence => {
    const res = await patch({ distributionCadence: cadence })
    expect(res.status).toBe(200)
    expect(s.m.tables.vehicle_accounting_settings[0]).toMatchObject({ fund_id: 'f', vehicle_id: 'v1', distribution_cadence: cadence })
    expect(await get()).toMatchObject({ distributionCadence: cadence })
  })

  it.each([['weekly'], [''], [null], [3]])('refuses %j with a 400 and writes nothing', async cadence => {
    const res = await patch({ distributionCadence: cadence })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/distributionCadence must be one of monthly, quarterly, annual, ad_hoc/)
    expect(s.m.tables.vehicle_accounting_settings).toEqual([])
  })

  it('sends only the cadence, so the upsert leaves the other settings as they were', async () => {
    await patch({ distributionCadence: 'annual' })
    const row = s.m.tables.vehicle_accounting_settings[0]
    expect(Object.keys(row).sort()).toEqual(['distribution_cadence', 'fund_id', 'id', 'updated_at', 'vehicle_id'])
  })
})
