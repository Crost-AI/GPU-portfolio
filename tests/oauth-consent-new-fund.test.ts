import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * Someone with no fund connecting Claude or ChatGPT: the consent screen asks them to name a fund,
 * and Allow creates it (agent access on) so the assistant can set the rest up. Deny creates nothing.
 */

const createFund = vi.fn(async () => ({ ok: true as const, fundId: 'new-fund', webhookToken: 't' }))
const fundCreationRefusal = vi.fn(async (): Promise<string | null> => null)
const issueAuthorizationCode = vi.fn(async (_admin: unknown, _args: { fundId: string }) => 'code-1')

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1', email: 'gp@firm.com' } } }) } }) }))
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
  issueAuthorizationCode: (admin: unknown, args: { fundId: string }) => issueAuthorizationCode(admin, args),
  grantableScope: () => 'read write',
}))
vi.mock('@/lib/access/effective', () => ({ loadAccessContext: async () => ({}), canWriteAnywhere: () => true }))
vi.mock('@/lib/oauth/enabled', () => ({ agentApiEnabled: async () => true }))
vi.mock('@/lib/rate-limit', () => ({ rateLimit: async () => null }))
vi.mock('@/lib/onboarding/create-fund', () => ({ createFund: (...a: unknown[]) => (createFund as any)(...a), fundCreationRefusal: () => fundCreationRefusal() }))

import { POST } from '@/app/api/oauth/consent/route'

const consent = (body: Record<string, unknown>) =>
  POST(new NextRequest('https://fund.example.com/api/oauth/consent', {
    method: 'POST',
    headers: { host: 'fund.example.com', 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: 'c1', redirect_uri: 'https://claude.ai/cb', code_challenge: 'x', scope: 'read write', ...body }),
  }))

describe('consent with no fund yet', () => {
  beforeEach(() => vi.clearAllMocks())

  it('creates the named fund with agent access on, and issues the code for it', async () => {
    const res = await consent({ approve: true, fund_name: ' Hemrock Ventures ' })
    expect(res.status).toBe(200)
    expect(createFund).toHaveBeenCalledWith(expect.anything(), { userId: 'u1', email: 'gp@firm.com', fundName: 'Hemrock Ventures', agentApiEnabled: true })
    expect(issueAuthorizationCode.mock.calls[0][1].fundId).toBe('new-fund')
  })

  it('needs a name', async () => {
    const res = await consent({ approve: true })
    expect(res.status).toBe(400)
    expect(createFund).not.toHaveBeenCalled()
  })

  it('creates nothing on Deny', async () => {
    const body = await (await consent({ approve: false, fund_name: 'Hemrock' })).json()
    expect(body.redirect).toContain('error=access_denied')
    expect(createFund).not.toHaveBeenCalled()
  })

  it('refuses an LP account', async () => {
    fundCreationRefusal.mockResolvedValueOnce('This is an investor portal account.')
    const res = await consent({ approve: true, fund_name: 'Hemrock' })
    expect(res.status).toBe(403)
    expect(createFund).not.toHaveBeenCalled()
  })
})
