import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * The investor connector endpoint: an LP's own portal over MCP. Its token, its switch and its
 * scope are checked on every call; its tools are the web portal's functions.
 */

const resolveAccessToken = vi.fn(async (_a: unknown, token: string, _aud: string): Promise<any> =>
  token === 'good' ? { userId: 'u1', fundId: 'fund-1', clientId: 'c1', scope: 'read', resource: 'https://x/api/portal/mcp' }
    : token === 'writer' ? { userId: 'u1', fundId: 'fund-1', clientId: 'c1', scope: 'read write', resource: 'https://x/api/portal/mcp' }
      : null)
const lpConnectorEnabled = vi.fn(async () => true)
const connectorPrincipal = vi.fn(async (): Promise<any> => ({ userId: 'u1', lpAccountId: 'acct-1', investorIds: ['inv-1'] }))
const acknowledgeCapitalCall = vi.fn(async () => ({ ok: true, lineId: 'line-1' }))
const portalLetter = vi.fn(async (): Promise<any> => ({ id: 'l1', period_label: 'Q3 2026', status: 'final', full_draft: 'Dear LPs', portfolio_table_html: '<table><tr><td>Acme</td><td>1x</td></tr></table>', company_narratives: null }))
let source: string | undefined

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/rate-limit', () => ({ rateLimit: async () => null }))
vi.mock('@/lib/oauth/store', () => ({ resolveAccessToken: (a: unknown, t: string, aud: string) => resolveAccessToken(a, t, aud) }))
vi.mock('@/lib/portal/principal', () => ({
  lpConnectorEnabled: () => lpConnectorEnabled(),
  connectorPrincipal: () => connectorPrincipal(),
}))
vi.mock('@/lib/portal/service', async importOriginal => {
  const { currentChangeSource } = await import('@/lib/audit/source')
  const real = await importOriginal<typeof import('@/lib/portal/service')>()
  return {
    ...real,
    portalOverview: async () => { source = currentChangeSource(); return { investorName: 'Pat', currency: 'USD', hasData: false } },
    portalLetter: () => portalLetter(),
    acknowledgeCapitalCall: (...a: unknown[]) => (acknowledgeCapitalCall as any)(...a),
    portalDocumentUrl: async () => { throw new real.PortalError(404, 'Not found') },
  }
})

import { POST } from '@/app/api/portal/mcp/route'

const rpc = (body: unknown, token: string | null = 'good') =>
  POST(new NextRequest('https://fund.example.com/api/portal/mcp', {
    method: 'POST',
    headers: { host: 'fund.example.com', 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }))
const call = (name: string, args: Record<string, unknown> = {}, token?: string) =>
  rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, token)

beforeEach(() => vi.clearAllMocks())

describe('authentication', () => {
  it('answers 401 with the investor resource metadata when there is no token', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, null)
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toContain('/.well-known/oauth-protected-resource/api/portal/mcp')
  })

  it('resolves the token for the portal audience only', async () => {
    await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' })
    expect(resolveAccessToken.mock.calls[0][2]).toBe('portal')
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, 'fund-token')).status).toBe(401)
  })

  it('refuses every call once the fund turns the connector off', async () => {
    lpConnectorEnabled.mockResolvedValueOnce(false)
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(403)
  })

  it('refuses an investor whose access to the fund has ended', async () => {
    connectorPrincipal.mockResolvedValueOnce(null)
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(403)
  })
})

describe('tools', () => {
  it('shows a read-only connection no write tools, and refuses them if called', async () => {
    const list = await (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).json()
    const names = list.result.tools.map((t: { name: string }) => t.name)
    expect(names).toContain('portal_overview')
    expect(names).not.toContain('acknowledge_capital_call')
    expect(names).not.toContain('send_message')
    const res = await (await call('acknowledge_capital_call', { line_id: 'line-1' })).json()
    expect(res.result.isError).toBe(true)
    expect(acknowledgeCapitalCall).not.toHaveBeenCalled()
  })

  it('lets a connection that may act acknowledge a wire', async () => {
    const list = await (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'writer')).json()
    expect(list.result.tools.map((t: { name: string }) => t.name)).toContain('acknowledge_capital_call')
    const res = await (await call('acknowledge_capital_call', { line_id: 'line-1', wired_on: '2026-10-01' }, 'writer')).json()
    expect(res.result.isError).toBeUndefined()
    expect(acknowledgeCapitalCall).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ lpAccountId: 'acct-1' }), expect.objectContaining({ lineId: 'line-1', wiredOn: '2026-10-01' }))
  })

  it('runs the portal functions as MCP, so the access log records the channel', async () => {
    const res = await (await call('portal_overview')).json()
    expect(res.result.structuredContent.investorName).toBe('Pat')
    expect(source).toBe('mcp')
  })

  it('gives a letter as text', async () => {
    const res = await (await call('read_letter', { letter_id: 'l1' })).json()
    expect(res.result.structuredContent.portfolioTable).toContain('Acme')
    expect(res.result.structuredContent.portfolioTable).not.toContain('<')
  })

  it('answers "not yours" without detail', async () => {
    const res = await (await call('get_document', { document_id: 'd1' })).json()
    expect(res.result.isError).toBe(true)
    expect(res.result.content[0].text).toMatch(/not shared with you/)
  })
})
