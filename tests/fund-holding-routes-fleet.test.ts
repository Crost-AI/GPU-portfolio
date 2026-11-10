import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

// ── GPU fleet (P3) ── The fund-holding routes upstream #149 adds (edit a register notice, recalculate
// distributions) answer "X is not a fund holding" for any other company — which names a GPU SPV's
// fleet company to a caller who may not know it exists (#91). They refuse it as not found first.

const s = vi.hoisted(() => ({ m: null as any, access: null as any, recalc: vi.fn(), edit: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => s.m.admin }))
vi.mock('@/lib/api-helpers', async (orig) => ({ ...(await orig<any>()), assertWriteAccess: async () => ({ fundId: 'f', userId: 'u', role: 'member' }) }))
vi.mock('@/lib/access/effective', async (orig) => ({ ...(await orig<any>()), loadAccessContext: async () => s.access }))
vi.mock('@/lib/portfolio/fund-register-write', async (orig) => ({ ...(await orig<any>()), recalculateFundDistributions: s.recalc, updateFundNotice: s.edit }))
import { POST as recalculate } from '@/app/api/portfolio/fund-holdings/[id]/distributions/recalculate/route'
import { PATCH as editNotice } from '@/app/api/portfolio/fund-holdings/[id]/events/[eventId]/route'

const member = (fleet: 'none' | 'write') => ({
  fundId: 'f', userId: 'u', role: 'member', features: { gpu_fleet: 'everyone', accounting: 'everyone' },
  grants: { portfolio: 'write', accounting: 'read', fleet }, defaults: {}, vehicles: { all: true, ids: [] },
})

beforeEach(() => {
  s.recalc.mockReset(); s.edit.mockReset()
  s.m = memoryAdmin({
    companies: [{ id: 'fleet-co', fund_id: 'f', name: 'GPU fleet', holding_type: 'gpu_fleet' }],
    fund_members: [{ fund_id: 'f', user_id: 'u', role: 'member' }],
  })
})

const req = (method: string) => new NextRequest('http://localhost/x', { method, body: JSON.stringify({}) })

describe('new fund-holding routes and a fleet company', () => {
  it('recalculate is not found without fleet write, and nothing runs', async () => {
    s.access = member('none')
    const res = await recalculate(req('POST'), { params: Promise.resolve({ id: 'fleet-co' }) })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Not found' })
    expect(s.recalc).not.toHaveBeenCalled()
  })

  it('editing a notice is not found without fleet write', async () => {
    s.access = member('none')
    const res = await editNotice(req('PATCH'), { params: Promise.resolve({ id: 'fleet-co', eventId: 'e1' }) })
    expect(res.status).toBe(404)
    expect(JSON.stringify(await res.json())).not.toMatch(/GPU fleet/)
  })

  it('with fleet write the request reaches the register (which refuses a non-fund holding itself)', async () => {
    s.access = member('write')
    const res = await recalculate(req('POST'), { params: Promise.resolve({ id: 'fleet-co' }) })
    expect(res.status).not.toBe(404)
  })
})
