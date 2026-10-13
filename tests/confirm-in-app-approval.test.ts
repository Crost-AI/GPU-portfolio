import { describe, it, expect, vi, beforeEach } from 'vitest'

// An action marked confirmInApp (publishing notices to LPs) is approved only through the browser's
// route, which supplies its executor, and only with the second confirmation. Anywhere else the row
// stays pending (lib/pending-actions/service.ts).

const m = vi.hoisted(() => ({ preview: vi.fn(), refuse: vi.fn(), executor: vi.fn() }))
vi.mock('@/lib/pending-actions/registry', () => ({
  getWriteAction: () => ({
    domain: 'lp_relations', accessFeature: 'lp_portal', entity: 'required', confirmInApp: true,
    preview: m.preview, execute: m.refuse,
  }),
}))

import { approvePendingAction } from '@/lib/pending-actions/service'

const ROW = {
  id: '00000000-0000-4000-8000-000000000001', fund_id: 'f1', vehicle_id: 'v1', domain: 'lp_relations',
  action_type: 'publish_call_notices', args: { vehicle: 'Fund I', callId: 'call1', previewToken: 't' },
  preview: { summary: 'Publish 2 notices', details: {} }, status: 'pending', created_by: 'member', created_via: 'mcp',
  created_credential: 'oauth:abc', approved_by: null, approved_at: null, applied_result: null, error: null,
  created_at: '2026-10-13T00:00:00Z', updated_at: '2026-10-13T00:00:00Z',
}

function admin() {
  const updates: any[] = []
  return {
    updates,
    from: () => {
      const chain: any = {
        select: () => chain, eq: () => chain,
        update: (u: any) => { updates.push(u); return chain },
        maybeSingle: async () => ({ data: ROW, error: null }),
      }
      return chain
    },
  } as any
}

const features = new Proxy({}, { get: () => 'everyone' }) as any
const principal = (role: 'admin' | 'member') => ({
  userId: 'u1', fundId: 'f1', role,
  access: { fundId: 'f1', userId: 'u1', role, features, grants: { lp_relations: 'write' }, defaults: {}, vehicles: { all: true, ids: [] } },
}) as any

describe('approving what publishes to LPs', () => {
  beforeEach(() => {
    m.preview.mockReset().mockResolvedValue({ summary: 'ok', details: {} })
    m.refuse.mockReset().mockRejectedValue(new Error('refused'))
    m.executor.mockReset().mockResolvedValue({ published: 2 })
  })

  it('is refused off the browser route, leaving the row pending', async () => {
    const a = admin()
    await expect(approvePendingAction(a, principal('admin'), ROW.id)).rejects.toMatchObject({ status: 409, code: 'CONFIRM_IN_APP' })
    expect(a.updates).toEqual([])
    expect(m.refuse).not.toHaveBeenCalled()
  })

  it('needs the second confirmation even in the app', async () => {
    const a = admin()
    await expect(approvePendingAction(a, principal('admin'), ROW.id, { executors: { publish_call_notices: m.executor } }))
      .rejects.toMatchObject({ status: 428, code: 'CONFIRMATION_REQUIRED' })
    expect(a.updates).toEqual([])
    expect(m.executor).not.toHaveBeenCalled()
  })

  it('needs an admin', async () => {
    await expect(approvePendingAction(admin(), principal('member'), ROW.id, { confirmed: true, executors: { publish_call_notices: m.executor } }))
      .rejects.toMatchObject({ status: 403, code: 'ADMIN_ONLY' })
  })

  it('publishes once confirmed in the app', async () => {
    const out = await approvePendingAction(admin(), principal('admin'), ROW.id, { confirmed: true, executors: { publish_call_notices: m.executor } })
    expect(out.result).toEqual({ published: 2 })
    expect(m.executor).toHaveBeenCalledTimes(1)
    expect(m.refuse).not.toHaveBeenCalled()
  })
})
