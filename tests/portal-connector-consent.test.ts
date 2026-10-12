import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * The investor connector's consent: an LP connecting an assistant to their own portal for one fund.
 * Decided on investor grounds alone, with the token's resource forced to the investor endpoint so it
 * can never open the fund's boundaries, and never on the fund-creation path.
 */

const issueAuthorizationCode = vi.fn(async (_admin: unknown, _args: Record<string, unknown>) => 'code-1')
const createFund = vi.fn()
const lpConnectorEnabled = vi.fn(async () => true)
const connectorPrincipal = vi.fn(async (): Promise<unknown> => ({ userId: 'u1', lpAccountId: 'acct-1', investorIds: ['inv-1'] }))

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1', email: 'lp@example.com' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => {
      const q: any = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: null }) }
      return q
    },
  }),
}))
vi.mock('@/lib/oauth/store', () => ({
  getClient: async () => ({ id: 'c1', redirect_uris: ['https://claude.ai/cb'] }),
  redirectUriAllowed: () => true,
  issueAuthorizationCode: (admin: unknown, args: Record<string, unknown>) => issueAuthorizationCode(admin, args),
  grantableScope: () => 'read write',
}))
vi.mock('@/lib/access/effective', () => ({ loadAccessContext: async () => ({}), canWriteAnywhere: () => true }))
vi.mock('@/lib/oauth/enabled', () => ({ agentApiEnabled: async () => true }))
vi.mock('@/lib/rate-limit', () => ({ rateLimit: async () => null }))
vi.mock('@/lib/onboarding/create-fund', () => ({ createFund: (...a: unknown[]) => createFund(...a), fundCreationRefusal: async () => null }))
vi.mock('@/lib/portal/principal', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/portal/principal')>()),
  lpConnectorEnabled: () => lpConnectorEnabled(),
  connectorPrincipal: () => connectorPrincipal(),
}))

import { POST } from '@/app/api/oauth/consent/route'

const consent = (body: Record<string, unknown>) =>
  POST(new NextRequest('https://fund.example.com/api/oauth/consent', {
    method: 'POST',
    headers: { host: 'fund.example.com', 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: 'c1', redirect_uri: 'https://claude.ai/cb', code_challenge: 'x', approve: true, ...body }),
  }))

describe('investor consent', () => {
  beforeEach(() => vi.clearAllMocks())

  it('issues a code for the chosen fund, bound to the investor endpoint', async () => {
    const res = await consent({ investor: true, fund_id: 'fund-1', scope: 'read write', resource: null })
    expect(res.status).toBe(200)
    expect((await res.json()).redirect).toContain('iss=')
    const args = issueAuthorizationCode.mock.calls[0][1]
    expect(args).toMatchObject({ fundId: 'fund-1', userId: 'u1', scope: 'read write', resource: 'https://fund.example.com/api/portal/mcp' })
    expect(createFund).not.toHaveBeenCalled()
  })

  it('forces the investor resource even when another was named, and caps scope at read write', async () => {
    await consent({ investor: true, fund_id: 'fund-1', scope: 'read write admin', resource: 'https://fund.example.com/api/mcp' })
    expect(issueAuthorizationCode.mock.calls[0][1]).toMatchObject({ scope: 'read write', resource: 'https://fund.example.com/api/portal/mcp' })
  })

  it('takes the investor path when the resource names the investor endpoint', async () => {
    await consent({ fund_id: 'fund-1', scope: 'read', resource: 'https://fund.example.com/api/portal/mcp' })
    expect(issueAuthorizationCode.mock.calls[0][1]).toMatchObject({ scope: 'read', fundId: 'fund-1' })
    expect(createFund).not.toHaveBeenCalled()
  })

  it("refuses when the fund hasn't turned the connector on", async () => {
    lpConnectorEnabled.mockResolvedValueOnce(false)
    const res = await consent({ investor: true, fund_id: 'fund-1' })
    expect(res.status).toBe(403)
    expect(issueAuthorizationCode).not.toHaveBeenCalled()
  })

  it('refuses a fund they do not invest in', async () => {
    connectorPrincipal.mockResolvedValueOnce(null)
    const res = await consent({ investor: true, fund_id: 'fund-2' })
    expect(res.status).toBe(403)
    expect(issueAuthorizationCode).not.toHaveBeenCalled()
  })

  it('needs a fund', async () => {
    expect((await consent({ investor: true })).status).toBe(400)
  })
})
