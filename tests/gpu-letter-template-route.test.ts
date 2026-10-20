import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { memoryAdmin } from './helpers/memory-admin'

/** POST /api/lp-letters/templates { template: 'gpu_quarterly' }: only for a fund with a GPU SPV; once. */

const mocks = vi.hoisted(() => ({ admin: null as any }))
vi.mock('@/lib/supabase/server', () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => mocks.admin }))
vi.mock('@/lib/api-helpers', () => ({ assertWriteAccess: async () => ({ fundId: 'f1', userId: 'u1', role: 'admin' }) }))

import { POST } from '@/app/api/lp-letters/templates/route'
import { GPU_QUARTERLY_STYLE_GUIDE, GPU_QUARTERLY_TEMPLATE_NAME } from '@/lib/lp-letters/gpu-template'

const post = (body: unknown) => POST(new NextRequest('http://x/api/lp-letters/templates', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }))
let tables: Record<string, any[]>

beforeEach(() => {
  const m = memoryAdmin({ fund_vehicles: [{ id: 'v1', fund_id: 'f1', name: 'Fund I', kind: 'fund' }], lp_letter_templates: [] })
  mocks.admin = m.admin
  tables = m.tables
})

describe('seeding the GPU quarterly template', () => {
  it('refuses a fund with no GPU SPV', async () => {
    const res = await post({ template: 'gpu_quarterly' })
    expect(res.status).toBe(400)
    expect(tables.lp_letter_templates).toEqual([])
  })

  it('creates it once for a fund with a GPU SPV, not as the default', async () => {
    tables.fund_vehicles.push({ id: 'v2', fund_id: 'f1', name: 'GPU SPV I', kind: 'gpu_spv' })
    const first = await post({ template: 'gpu_quarterly' })
    expect(first.status).toBe(201)
    expect(await first.json()).toMatchObject({ name: GPU_QUARTERLY_TEMPLATE_NAME, style_guide: GPU_QUARTERLY_STYLE_GUIDE, is_default: false })
    const again = await post({ template: 'gpu_quarterly' })
    expect(again.status).toBe(200)
    expect(tables.lp_letter_templates).toHaveLength(1)
  })

  it('leaves the default path as it was', async () => {
    const res = await post({})
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ name: 'Default', is_default: true })
  })
})
