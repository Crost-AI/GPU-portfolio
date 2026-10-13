import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import type { AccessContext, AccessLevel } from '@/lib/access/effective'
import type { Domain } from '@/lib/access/domains'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureVisibilityMap } from '@/lib/types/features'
import { memoryAdmin } from './helpers/memory-admin'

/**
 * search_tools and call_tool (lib/mcp-apps/gateway.ts): the two fixed entry points that let a
 * conversation whose host cached an older tool list find and run a tool added since. The route,
 * authorization, staging and idempotency are real; the database is in memory and the one write
 * handler is a stand-in, as in agent-write-dispatch.test.ts.
 */

let scopes = ['read', 'write']
let keyId = 'oauth:claude'
let access: AccessContext
let store: ReturnType<typeof memoryAdmin>
const addChartAccount = vi.fn(async (_a: unknown, _f: string, _g: string, input: any) => ({ account: { code: input.code, name: input.name } }))
const rateKeys: string[] = []

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => store.admin }))
vi.mock('@/lib/oauth/enabled', () => ({ agentApiEnabled: async () => true }))
vi.mock('@/lib/rate-limit', () => ({ rateLimit: async ({ key }: { key: string }) => { rateKeys.push(key); return null } }))
vi.mock('@/lib/pending-actions/notify', () => ({ notifyAdminsOfStagedChange: async () => 0 }))
vi.mock('@/lib/accounting/chart-add', () => ({ addChartAccount: (...args: any[]) => (addChartAccount as any)(...args) }))
vi.mock('@/lib/accounting/api-keys', async importOriginal => {
  const credential = (req: Request) =>
    req.headers.get('authorization') ? { fundId: 'fund-1', keyId, userId: 'user-me', role: access.role, scopes } : null
  return {
    ...(await importOriginal<typeof import('@/lib/accounting/api-keys')>()),
    resolveAgentAuth: async (_admin: unknown, req: Request) => credential(req),
    resolveFundFromApiKey: async (_admin: unknown, req: Request) => credential(req),
    loadCredentialAccess: async () => access,
  }
})

import { POST as mcpPost } from '@/app/api/mcp/route'
import { POST as agentPost } from '@/app/api/agent/route'
import { closeMatches, GATEWAY_TOOLS, toolListVersion } from '@/lib/mcp-apps/gateway'
import { listableTools } from '@/lib/mcp-apps/server'

const member = (grants: Partial<Record<Domain, AccessLevel>>, role: 'admin' | 'member' | 'viewer' = 'member'): AccessContext => ({
  fundId: 'fund-1', userId: 'user-me', vehicles: { all: true, ids: [] }, role,
  features: Object.fromEntries(Object.keys(DEFAULT_FEATURE_VISIBILITY).map(k => [k, 'everyone'])) as FeatureVisibilityMap,
  grants, defaults: {},
})

async function rpc(method: string, params: Record<string, unknown> = {}) {
  const res = await mcpPost(new NextRequest('https://fund.test/api/mcp', {
    method: 'POST',
    headers: { host: 'fund.test', 'content-type': 'application/json', authorization: 'Bearer mcp_at_test' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }))
  return res.json()
}

async function callTool(name: string, args: Record<string, unknown>, meta?: Record<string, unknown>) {
  const body = await rpc('tools/call', { name, arguments: args, ...(meta ? { _meta: meta } : {}) })
  const result = body.result
  const text = result?.content?.[0]?.text as string
  return { body, result, isError: !!result?.isError, text, json: (() => { try { return JSON.parse(text) } catch { return null } })() }
}

const viaGateway = (name: string, args: Record<string, unknown>, meta?: Record<string, unknown>) =>
  callTool('call_tool', { name, arguments: args }, meta)

const audit = () => store.tables.accounting_audit_events ?? []

beforeEach(() => {
  scopes = ['read', 'write']
  keyId = 'oauth:claude'
  access = member({ accounting: 'write' })
  addChartAccount.mockClear()
  rateKeys.length = 0
  store = memoryAdmin({
    fund_members: [{ fund_id: 'fund-1', user_id: 'user-me', role: 'member' }],
    fund_vehicles: [{ id: 'v1', fund_id: 'fund-1', name: 'Fund I', active: true, kind: 'fund', aliases: null }],
    pending_actions: [],
    accounting_audit_events: [],
    api_idempotency_keys: [],
  }, { unique: [{ table: 'api_idempotency_keys', key: r => `${r.fund_id}|${r.client_id}|${r.endpoint}|${r.key}` }] })
})

describe('the tool list', () => {
  it('always ends with search_tools and call_tool, and carries its version', async () => {
    for (const a of [member({}, 'viewer'), member({ accounting: 'read' }), member({ portfolio: 'write' })]) {
      access = a
      const { result } = await rpc('tools/list')
      const names = result.tools.map((t: any) => t.name)
      expect(names.slice(-2)).toEqual(['search_tools', 'call_tool'])
      expect(result._meta.toolListVersion).toBe(toolListVersion(a))
    }
  })

  it('has a version that moves when the list does', () => {
    expect(toolListVersion(member({ accounting: 'read' }))).toBe(toolListVersion(member({ accounting: 'read' })))
    expect(toolListVersion(member({ accounting: 'read' }))).not.toBe(toolListVersion(member({ portfolio: 'write' })))
  })

  it('is described at initialize, with the version, and tells the model what to do when a tool is missing', async () => {
    const { result } = await rpc('initialize', { protocolVersion: '2025-06-18' })
    expect(result.instructions).toMatch(/search_tools.*call_tool/)
    expect(result.instructions).toContain(toolListVersion(access))
    expect(result._meta.toolListVersion).toBe(toolListVersion(access))
  })

  it('annotates call_tool as not read-only, so a host asks before running it', () => {
    const call = GATEWAY_TOOLS.find(t => t.name === 'call_tool')!
    expect(call.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true })
  })
})

describe('search_tools', () => {
  it('finds only tools the caller may use, as tools/list shows them', async () => {
    access = member({ accounting: 'read' })
    const narrow = await callTool('search_tools', { query: 'update investment' })
    expect(narrow.json.tools.map((t: any) => t.name)).not.toContain('update_investment')
    const listed = new Set(listableTools(access).map(t => t.name))
    for (const t of narrow.json.tools) expect(listed.has(t.name), t.name).toBe(true)

    access = member({ portfolio: 'write' })
    const wide = await callTool('search_tools', { query: 'update investment' })
    expect(wide.json.tools[0]).toMatchObject({
      name: 'update_investment', scope: 'write', staged: true,
      annotations: { readOnlyHint: false }, inputSchema: expect.objectContaining({ type: 'object' }),
    })
    expect(wide.json.toolListVersion).toBe(toolListVersion(access))
  })

  it('lists every usable tool compactly with no query, and describes named tools in full', async () => {
    access = member({ accounting: 'read' })
    const all = await callTool('search_tools', {})
    expect(all.json.count).toBe(listableTools(access).length)
    expect(all.json.tools[0]).toEqual({ name: expect.any(String), scope: expect.any(String), description: expect.any(String) })
    expect(all.json.tools.map((t: any) => t.name)).not.toContain('search_tools')

    const named = await callTool('search_tools', { names: ['list_accounts', 'update_investment'] })
    expect(named.json.tools.map((t: any) => t.name)).toEqual(['list_accounts'])
    expect(named.json.tools[0].inputSchema).toBeDefined()
    // A tool the caller cannot use is reported as not found, not described.
    expect(named.json.notFound).toEqual([expect.objectContaining({ name: 'update_investment' })])
  })

  it('says whether a write would be staged, applied, or refused for this credential', async () => {
    access = member({ accounting: 'write' })
    expect((await callTool('search_tools', { names: ['add_account'] })).json.tools[0]).toMatchObject({ staged: true })

    keyId = 'key-1'
    expect((await callTool('search_tools', { names: ['add_account'] })).json.tools[0]).toMatchObject({ staged: false })

    scopes = ['read']
    expect((await callTool('search_tools', { names: ['add_account'] })).json.tools[0]).toMatchObject({ refused: 'This credential is read-only.' })
  })
})

describe('call_tool', () => {
  it('returns exactly what a direct call returns for a read', async () => {
    await callTool('add_account', { code: '6100', name: 'Legal', type: 'expense' })
    const direct = await callTool('list_pending_actions', {})
    const gateway = await viaGateway('list_pending_actions', {})
    expect(gateway.isError).toBe(false)
    expect(gateway.result).toEqual(direct.result)
  })

  it('stages a write over OAuth exactly as a direct call does', async () => {
    const direct = await callTool('add_account', { code: '6100', name: 'Legal', type: 'expense' })
    const gateway = await viaGateway('add_account', { code: '6100', name: 'Legal', type: 'expense' })
    expect(gateway.json).toMatchObject({ staged: true, summary: direct.json.summary })
    expect(addChartAccount).not.toHaveBeenCalled()

    const [a, b] = store.tables.pending_actions
    const strip = ({ id: _id, created_at: _c, ...rest }: any) => rest
    expect(strip(b)).toEqual(strip(a))
    expect(audit().map(e => [e.action, e.source, e.details.credentialId])).toEqual([
      ['pending_action.stage', 'mcp', 'oauth:claude'], ['pending_action.stage', 'mcp', 'oauth:claude'],
    ])
    // Metered as a write, not as the read call_tool might look like.
    expect(rateKeys.at(-1)).toBe('accounting-agent:w:fund-1')
  })

  it('passes the idempotency key through, so a retry stages nothing new', async () => {
    const first = await viaGateway('add_account', { code: '6100', name: 'Legal', type: 'expense' }, { idempotencyKey: 'k1' })
    const retry = await viaGateway('add_account', { code: '6100', name: 'Legal', type: 'expense' }, { idempotencyKey: 'k1' })
    expect(retry.json.pendingActionId).toBe(first.json.pendingActionId)
    expect(store.tables.pending_actions).toHaveLength(1)
  })

  it('cannot write from a read-only credential', async () => {
    scopes = ['read']
    const out = await viaGateway('add_account', { code: '6100', name: 'Legal', type: 'expense' })
    expect(out.isError).toBe(true)
    expect(out.text).toBe('This credential is read-only.')
    expect(store.tables.pending_actions).toHaveLength(0)
    expect(addChartAccount).not.toHaveBeenCalled()
  })

  it('is refused what a direct call is refused, in the same words', async () => {
    access = member({ accounting: 'read' })
    const direct = await callTool('add_account', { code: '6100', name: 'Legal', type: 'expense' })
    const gateway = await viaGateway('add_account', { code: '6100', name: 'Legal', type: 'expense' })
    expect(gateway.result).toEqual(direct.result)
    expect(gateway.isError).toBe(true)
  })

  it('will not call itself or search_tools', async () => {
    for (const name of ['call_tool', 'search_tools']) {
      const out = await viaGateway(name, { name: 'add_account', arguments: {} })
      expect(out.isError, name).toBe(true)
      expect(out.text).toContain(`Call ${name} directly`)
    }
    expect(store.tables.pending_actions).toHaveLength(0)
  })

  it('answers an unknown name with the close matches the caller may use', async () => {
    access = member({ portfolio: 'write' })
    const out = await viaGateway('update_investmnt', {})
    expect(out.isError).toBe(true)
    expect(out.text).toMatch(/Unknown tool: update_investmnt\. Did you mean: .*update_investment/)
    expect(out.text).toContain('search_tools')

    // Never a name the caller could not see.
    access = member({ accounting: 'read' })
    expect(closeMatches('update_investmnt', access)).not.toContain('update_investment')
  })

  it('refuses a missing name or non-object arguments', async () => {
    expect((await callTool('call_tool', {})).text).toMatch(/needs "name"/)
    expect((await callTool('call_tool', { name: 'list_accounts', arguments: [1] })).text).toMatch(/must be an object/)
  })
})

describe('the REST twin', () => {
  it('does not take the gateway tools, and says why', async () => {
    keyId = 'key-1'
    for (const tool of ['search_tools', 'call_tool']) {
      const res = await agentPost(new NextRequest('https://fund.test/api/agent', {
        method: 'POST',
        headers: { host: 'fund.test', 'content-type': 'application/json', authorization: 'Bearer lk_test' },
        body: JSON.stringify({ tool, input: { name: 'add_account', arguments: { code: '6100', name: 'Legal', type: 'expense' } } }),
      }))
      expect(res.status).toBe(400)
      expect((await res.json()).error).toMatch(/MCP tool.*GET \/api\/agent lists every tool/)
    }
    expect(addChartAccount).not.toHaveBeenCalled()
  })
})
