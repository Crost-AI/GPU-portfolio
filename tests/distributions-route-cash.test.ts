import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// The distributions route hands a GPU SPV's declaration fields to declareDistribution unchanged,
// and surfaces its refusals as 400s.

const s = vi.hoisted(() => ({ declare: vi.fn(), preview: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/api-helpers', async orig => ({ ...(await orig<any>()), assertWriteAccess: async () => ({ fundId: 'f', userId: 'u', role: 'admin' }), assertReadAccess: async () => ({ fundId: 'f', userId: 'u', role: 'admin' }) }))
vi.mock('@/lib/accounting/http-vehicle', () => ({ resolveGroupOr400: async () => 'GPU I' }))
vi.mock('@/lib/accounting/vehicle-id', () => ({ vehicleIdByName: async () => 'v1' }))
vi.mock('@/lib/audit/events', () => ({ recordAudit: async () => undefined }))
vi.mock('@/lib/accounting/distributions', () => ({
  declareDistribution: (...a: any[]) => s.declare(...a),
  previewDistribution: (...a: any[]) => s.preview(...a),
  listDistributions: async () => [],
}))

import { POST } from '@/app/api/accounting/distributions/route'

const post = (body: object) => POST(new NextRequest('http://localhost/api/accounting/distributions', { method: 'POST', body: JSON.stringify({ group: 'GPU I', ...body }) }))
const cash = { prefDue: 10, prefCarriedForward: 0, unreturnedAfter: 900, profitToLP: 0, managerRocShare: 0, contingencyReturn: 100 }

beforeEach(() => {
  s.declare.mockReset().mockResolvedValue({ entryId: 'e1', carryEntryId: null, carryRealizedEntryId: null, distributionId: 'd1' })
  s.preview.mockReset().mockResolvedValue({ lines: [] })
})

describe('POST /api/accounting/distributions: distributable_cash passthrough', () => {
  it('declare passes available, reserve, cash and the tiers contingency through', async () => {
    const res = await post({
      action: 'declare', distributionDate: '2027-02-01', lines: [{ lpEntityId: 'lp', amount: 110 }],
      splitMethod: 'waterfall', tiers: { returnOfCapital: 0, preferred: 10, catchUp: 0, carry: 0, profitToLP: 0, toLP: 110, toGP: 0, contingencyReturn: 100 },
      available: 150, reserve: 40, cash,
    })
    expect(res.status).toBe(200)
    const input = s.declare.mock.calls[0][4]
    expect(input).toMatchObject({ available: 150, reserve: 40, cash, tiers: { contingencyReturn: 100 } })
  })

  it('a top-level contingencyReturn fills the cash object when it lacks one', async () => {
    const { contingencyReturn: _, ...rest } = cash
    await post({ action: 'declare', distributionDate: '2027-02-01', lines: [{ lpEntityId: 'lp', amount: 110 }], splitMethod: 'waterfall', cash: rest, contingencyReturn: 60 })
    expect(s.declare.mock.calls[0][4].cash.contingencyReturn).toBe(60)
  })

  it('a refusal from declareDistribution is a 400 with its message', async () => {
    s.declare.mockResolvedValue({ error: 'The available cash less the reserve must equal the distribution declared' })
    const res = await post({ action: 'declare', distributionDate: '2027-02-01', lines: [{ lpEntityId: 'lp', amount: 100 }], available: 1_000, reserve: 0 })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/less the reserve/)
  })

  it('preview passes available, reserve and contingencyReturn, and a refusal is a 400', async () => {
    s.preview.mockResolvedValue({ error: 'A reserve of at least 0 and less than the available cash is required' })
    const res = await post({ action: 'preview', asOf: '2027-06-30', available: 500, reserve: 500, contingencyReturn: 20 })
    expect(res.status).toBe(400)
    expect(s.preview.mock.calls[0].slice(3, 7)).toEqual([NaN, '2027-06-30', 'waterfall', { available: 500, reserve: 500, contingencyReturn: 20 }])
  })
})
