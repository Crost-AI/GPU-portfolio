import { describe, it, expect, vi, beforeEach } from 'vitest'

// Settings → Connected apps: a member lists and revokes their OWN fund OAuth connections. Never
// another person's, never another fund's, and never an investor-connector token (the portal lists
// and revokes those).

const MCP = 'https://app.example/api/mcp'
const PORTAL = 'https://app.example/api/portal/mcp'

const m = vi.hoisted(() => ({
  user: { id: 'u1' } as { id: string } | null,
  member: { fund_id: 'f1' } as { fund_id: string } | null,
  tokens: [] as any[],
  eqs: [] as [string, unknown][],
  revoked: [] as string[],
}))

function chain(table: string) {
  let op: 'select' | 'update' = 'select'
  const c: any = {
    select: () => c,
    is: () => c,
    gt: () => c,
    eq: (k: string, v: unknown) => { if (table === 'oauth_tokens') m.eqs.push([k, v]); return c },
    in: (_k: string, ids: string[]) => { if (op === 'update') m.revoked.push(...ids); return c },
    update: () => { op = 'update'; return c },
    maybeSingle: async () => ({ data: table === 'fund_members' ? m.member : null, error: null }),
    then: (res: any) => res({ data: op === 'select' ? m.tokens : null, error: null }),
  }
  return c
}

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: m.user } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: (t: string) => chain(t) }) }))

import { GET, DELETE } from '@/app/api/settings/connected-apps/route'

const del = (q: string) => DELETE({ nextUrl: new URL(`http://x/api/settings/connected-apps${q}`) } as any)

beforeEach(() => {
  m.user = { id: 'u1' }
  m.member = { fund_id: 'f1' }
  m.eqs = []
  m.revoked = []
  m.tokens = [
    { id: 't1', client_id: 'c1', scope: 'read write', resource: MCP, created_at: '2026-01-02', last_used_at: '2026-01-05', oauth_clients: { client_name: 'Example Assistant', redirect_uris: ['https://assistant.example/callback'] } },
    { id: 't2', client_id: 'c1', scope: 'read write', resource: null, created_at: '2026-01-01', last_used_at: '2026-01-09', oauth_clients: { client_name: 'Example Assistant', redirect_uris: ['https://assistant.example/callback'] } },
    { id: 't3', client_id: 'c2', scope: 'read', resource: PORTAL, created_at: '2026-01-03', last_used_at: null, oauth_clients: { client_name: 'Investor Assistant', redirect_uris: [] } },
  ]
})

describe('GET /api/settings/connected-apps', () => {
  it('requires a signed-in fund member', async () => {
    m.user = null
    expect((await GET()).status).toBe(401)
    m.user = { id: 'u1' }
    m.member = null
    expect((await GET()).status).toBe(403)
  })

  it('lists one row per assistant, scoped to the caller and their fund, without investor-connector tokens', async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    const { connections } = await res.json()
    expect(connections).toEqual([{
      clientId: 'c1',
      clientName: 'Example Assistant',
      redirectHost: 'assistant.example',
      canAct: true,
      connectedAt: '2026-01-02',
      lastUsedAt: '2026-01-09',
    }])
    expect(m.eqs).toEqual(expect.arrayContaining([['user_id', 'u1'], ['fund_id', 'f1'], ['kind', 'refresh']]))
  })
})

describe('DELETE /api/settings/connected-apps', () => {
  it('needs a client_id', async () => {
    expect((await del('')).status).toBe(400)
  })

  it('revokes only the caller\'s fund tokens for that assistant', async () => {
    m.tokens = m.tokens.map(t => ({ id: t.id, resource: t.resource }))
    const res = await del('?client_id=c1')
    expect(res.status).toBe(200)
    expect(m.eqs).toEqual(expect.arrayContaining([['user_id', 'u1'], ['fund_id', 'f1'], ['client_id', 'c1']]))
    // t3 is an investor-connector token: the portal revokes it, not this route.
    expect(m.revoked).toEqual(['t1', 't2'])
  })
})
