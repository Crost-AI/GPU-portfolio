import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * ── GPU fleet (P1) ── The middleware's half of the /api/fleet gate: the real proxy, with the
 * access_context RPC stubbed (as in access-lockdown.test.ts). Every fleet route is `fleet`; a write
 * needs fleet write, and nothing passes while gpu_fleet is off, admins included.
 */

const getUser = vi.hoisted(() => vi.fn())
const rpc = vi.hoisted(() => vi.fn())
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: { getUser, mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: null }) } },
    from: () => { const c: any = { select: () => c, eq: () => c, in: () => c, maybeSingle: async () => ({ data: null, error: null }) }; return c },
    rpc,
  }),
}))

import { proxy } from '@/proxy'
import { ROUTE_DOMAINS } from '@/lib/access/route-domains'
import { DEFAULT_FEATURE_VISIBILITY } from '@/lib/types/features'

let role = 'member'
let features: Record<string, string> = {}
let grants: Record<string, string> = {}
const req = (pathname: string, method = 'GET') => ({
  nextUrl: { pathname, search: '', clone: () => new URL(`https://x${pathname}`) },
  cookies: { getAll: () => [], set: () => {} },
  method, headers: new Headers(),
  clone: () => ({ json: async () => ({}) }),
}) as any
const status = async (pathname: string, method = 'GET') => (await proxy(req(pathname, method)))?.status ?? 200

beforeEach(() => {
  role = 'member'
  features = { accounting: 'everyone', gpu_fleet: 'everyone' }
  grants = { accounting: 'write', fleet: 'read' }
  getUser.mockResolvedValue({ data: { user: { id: 'u1' } } })
  rpc.mockImplementation(async () => ({
    data: { fund_id: 'f1', role, features: { ...DEFAULT_FEATURE_VISIBILITY, ...features }, grants, defaults: {}, vehicles_all: true, vehicles: [] },
    error: null,
  }))
})

const ID = '00000000-0000-4000-8000-000000000001'

describe('the fleet gate', () => {
  it('maps every fleet route to the fleet domain', () => {
    const fleet = Object.entries(ROUTE_DOMAINS).filter(([k]) => k.startsWith('api/fleet/'))
    // 9 register routes (P1) + 5 operations routes (P3: ops/import, ops/earnings, ops/payouts,
    // ops/settings, kpis).
    expect(fleet.length).toBe(14)
    expect(fleet.every(([, v]) => v.domain === 'fleet')).toBe(true)
  })

  it('fleet read-only: reads pass, purchase, dispose and capex are 403', async () => {
    expect(await status(`/api/fleet/assets`)).not.toBe(403)
    for (const action of ['purchase', 'dispose', 'capex']) expect(await status(`/api/fleet/assets/${ID}/${action}`, 'POST')).toBe(403)
    expect(await status('/api/fleet/datacenter-contracts', 'POST')).toBe(403)
  })

  it('fleet write passes the gate to the handler', async () => {
    grants = { accounting: 'write', fleet: 'write' }
    expect(await status(`/api/fleet/assets/${ID}/purchase`, 'POST')).not.toBe(403)
  })

  it('gpu_fleet off: denied for everyone, admins included', async () => {
    features = { accounting: 'everyone' }
    role = 'admin'
    expect(await status('/api/fleet/assets')).toBe(403)
    expect(await status(`/api/fleet/assets/${ID}/purchase`, 'POST')).toBe(403)
  })
})
