import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
const mocks = vi.hoisted(() => ({ getUser: vi.fn(), gate: vi.fn(), rpc: vi.fn(), group: vi.fn(), vehicle: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: mocks.getUser } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ rpc: mocks.rpc }) }))
vi.mock('@/lib/api-helpers', () => ({ assertReadAccess: mocks.gate, assertWriteAccess: mocks.gate }))
vi.mock('@/lib/accounting/http-vehicle', () => ({ resolveGroupOr400: mocks.group }))
vi.mock('@/lib/accounting/vehicle-id', () => ({ vehicleIdByName: mocks.vehicle }))
vi.mock('@/lib/accounting/capital-calls', () => ({ loadSettlements: vi.fn() }))
vi.mock('@/lib/accounting/settlement-reviews', async (actual) => ({ ...(await actual<typeof import('@/lib/accounting/settlement-reviews')>()), loadSettlementReviews: vi.fn() }))
import { POST } from '@/app/api/accounting/settlements/route'
const line = '00000000-0000-0000-0000-000000000001'
const entry = '00000000-0000-0000-0000-000000000002'
function request(body: unknown) { return new NextRequest('http://localhost/api/accounting/settlements?group=Fund', { method: 'POST', body: JSON.stringify(body) }) }
const valid = { kind: 'call', lineId: line, links: [{ entryId: entry, amount: 80 }], separateRemainder: false }
beforeEach(() => {
  vi.clearAllMocks()
  mocks.getUser.mockResolvedValue({ data: { user: { id: 'user' } } })
  mocks.gate.mockResolvedValue({ fundId: 'tenant', role: 'admin' })
  mocks.group.mockResolvedValue('Fund')
  mocks.vehicle.mockResolvedValue('vehicle')
  mocks.rpc.mockResolvedValue({ error: null })
})
describe('payment reconciliation route', () => {
  it('requires identity and write authorization', async () => {
    mocks.getUser.mockResolvedValueOnce({ data: { user: null } })
    expect((await POST(request(valid))).status).toBe(401)
    mocks.gate.mockResolvedValueOnce(NextResponse.json({ error: 'Forbidden' }, { status: 403 }))
    expect((await POST(request(valid))).status).toBe(403)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })
  it('uses the authenticated tenant and resolved vehicle, ignoring supplied scope', async () => {
    expect((await POST(request({ ...valid, fundId: 'attacker', vehicleId: 'elsewhere' }))).status).toBe(200)
    expect(mocks.rpc).toHaveBeenCalledWith('review_capital_settlement', expect.objectContaining({ p_fund_id: 'tenant', p_vehicle_id: 'vehicle', p_user_id: 'user' }))
  })
  it('rejects invalid amounts before writing and surfaces changed or overallocated payments', async () => {
    expect((await POST(request({ ...valid, links: [{ entryId: entry, amount: -1 }] }))).status).toBe(400)
    expect(mocks.rpc).not.toHaveBeenCalled()
    mocks.rpc.mockResolvedValueOnce({ error: { message: 'This payment amount is already allocated' } })
    const response = await POST(request(valid))
    expect(response.status).toBe(409)
    expect((await response.json()).error).toContain('already allocated')
  })
})
