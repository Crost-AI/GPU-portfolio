import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import type { AccessContext, AccessLevel } from '@/lib/access/effective'
import type { Domain } from '@/lib/access/domains'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureVisibilityMap } from '@/lib/types/features'
import { memoryAdmin } from './helpers/memory-admin'

/**
 * Writes from Claude/ChatGPT (MCP, OAuth) and from scripts (/api/agent, API keys) go through one
 * dispatcher (lib/agent/dispatch.ts): an assistant's write is staged until a person approves it, a
 * key's write applies at once, every write is audited with its source and credential, and a retry
 * under the same idempotency key does not write twice. The routes, authorization, staging and
 * approval are real; the database is in memory and the one write handler is a stand-in.
 */

let scopes = ['read', 'write']
let keyId = 'oauth:claude'
let access: AccessContext
let store: ReturnType<typeof memoryAdmin>
const addChartAccount = vi.fn(async (_a: unknown, _f: string, _g: string, input: any) => ({ account: { code: input.code, name: input.name } }))

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => store.admin }))
vi.mock('@/lib/oauth/enabled', () => ({ agentApiEnabled: async () => true }))
vi.mock('@/lib/rate-limit', () => ({ rateLimit: async () => null }))
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
import { isDraftOnlyCall, shouldStage, auditInput } from '@/lib/agent/dispatch'
import { getTool } from '@/lib/accounting/agent-tools'
import { visibleTo } from '@/lib/audit/read'
import { recordAudit } from '@/lib/audit/events'
import { currentChangeSource, withChangeSource } from '@/lib/audit/source'

const member = (grants: Partial<Record<Domain, AccessLevel>>, role: 'admin' | 'member' | 'viewer' = 'member'): AccessContext => ({
  fundId: 'fund-1', userId: 'user-me', vehicles: { all: true, ids: [] }, role,
  features: Object.fromEntries(Object.keys(DEFAULT_FEATURE_VISIBILITY).map(k => [k, 'everyone'])) as FeatureVisibilityMap,
  grants, defaults: {},
})

async function callTool(name: string, args: Record<string, unknown>, meta?: Record<string, unknown>) {
  const res = await mcpPost(new NextRequest('https://fund.test/api/mcp', {
    method: 'POST',
    headers: { host: 'fund.test', 'content-type': 'application/json', authorization: 'Bearer mcp_at_test' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) } }),
  }))
  const body = await res.json()
  const result = body.result
  return { isError: !!result?.isError, text: result?.content?.[0]?.text as string, json: (() => { try { return JSON.parse(result?.content?.[0]?.text) } catch { return null } })() }
}

async function callAgent(tool: string, input: Record<string, unknown>, headers: Record<string, string> = {}) {
  const res = await agentPost(new NextRequest('https://fund.test/api/agent', {
    method: 'POST',
    headers: { host: 'fund.test', 'content-type': 'application/json', authorization: 'Bearer lk_test', ...headers },
    body: JSON.stringify({ tool, input }),
  }))
  return { status: res.status, body: await res.json() }
}

const audit = () => store.tables.accounting_audit_events ?? []

beforeEach(() => {
  scopes = ['read', 'write']
  keyId = 'oauth:claude'
  access = member({ accounting: 'write' })
  addChartAccount.mockClear()
  store = memoryAdmin({
    fund_members: [{ fund_id: 'fund-1', user_id: 'user-me', role: 'member' }],
    fund_vehicles: [{ id: 'v1', fund_id: 'fund-1', name: 'Fund I', active: true, kind: 'fund', aliases: null }],
    pending_actions: [],
    accounting_audit_events: [],
    api_idempotency_keys: [],
  }, { unique: [{ table: 'api_idempotency_keys', key: r => `${r.fund_id}|${r.client_id}|${r.endpoint}|${r.key}` }] })
})

describe('a chat assistant (OAuth over MCP)', () => {
  it('stages a write instead of applying it, and records who staged it from where', async () => {
    const out = await callTool('add_account', { code: '6100', name: 'Legal', type: 'expense' })
    expect(out.isError).toBe(false)
    expect(out.json).toMatchObject({ staged: true, summary: expect.stringContaining('add_account on Fund I') })
    expect(addChartAccount).not.toHaveBeenCalled()

    const [row] = store.tables.pending_actions
    expect(row).toMatchObject({
      action_type: 'agent_tool_call', domain: 'accounting', vehicle_id: 'v1', created_via: 'mcp', created_by: 'user-me',
      args: { tool: 'add_account', input: { code: '6100', name: 'Legal', type: 'expense', vehicle: 'Fund I' } },
    })
    expect(audit()).toEqual([expect.objectContaining({
      action: 'pending_action.stage', source: 'mcp', actor_id: 'user-me', subject_id: row.id,
      details: expect.objectContaining({ credentialId: 'oauth:claude' }),
    })])
  })

  it('applies the staged write when the person approves it in the chat', async () => {
    const staged = await callTool('add_account', { code: '6100', name: 'Legal', type: 'expense' })
    const approved = await callTool('approve_action', { id: staged.json.pendingActionId })
    expect(approved.isError).toBe(false)
    expect(approved.json).toMatchObject({ applied: true, result: { tool: 'add_account', result: { code: '6100' } } })
    expect(addChartAccount).toHaveBeenCalledTimes(1)
    expect(store.tables.pending_actions[0].status).toBe('applied')
    expect(audit().map(e => [e.action, e.source])).toEqual([['pending_action.stage', 'mcp'], ['pending_action.approve', 'mcp']])

    // A second approval replays rather than writing twice.
    await callTool('approve_action', { id: staged.json.pendingActionId })
    expect(addChartAccount).toHaveBeenCalledTimes(1)
  })

  it('applies nothing when the person declines', async () => {
    const staged = await callTool('add_account', { code: '6100', name: 'Legal', type: 'expense' })
    const rejected = await callTool('reject_action', { id: staged.json.pendingActionId })
    expect(rejected.json).toMatchObject({ rejected: true })
    expect(addChartAccount).not.toHaveBeenCalled()
    expect(store.tables.pending_actions[0].status).toBe('rejected')
  })

  it('lists what is waiting', async () => {
    await callTool('add_account', { code: '6100', name: 'Legal', type: 'expense' })
    const listed = await callTool('list_pending_actions', {})
    expect(listed.json.actions).toEqual([expect.objectContaining({ actionType: 'agent_tool_call', stagedVia: 'mcp' })])
  })

  it('cannot approve on a read-only connection', async () => {
    const staged = await callTool('add_account', { code: '6100', name: 'Legal', type: 'expense' })
    scopes = ['read']
    const out = await callTool('approve_action', { id: staged.json.pendingActionId })
    expect(out.isError).toBe(true)
    expect(out.text).toMatch(/read-only/)
    expect(addChartAccount).not.toHaveBeenCalled()
  })

  it('approves only with the approver’s own write access to the change', async () => {
    const staged = await callTool('add_account', { code: '6100', name: 'Legal', type: 'expense' })
    access = member({ accounting: 'read' })
    const out = await callTool('approve_action', { id: staged.json.pendingActionId })
    expect(out.isError).toBe(true)
    expect(addChartAccount).not.toHaveBeenCalled()
  })

  it('is refused a write its owner has no grant for, as the web is', async () => {
    access = member({ accounting: 'read' })
    const out = await callTool('add_account', { code: '6100', name: 'Legal', type: 'expense' })
    expect(out.isError).toBe(true)
    expect(store.tables.pending_actions).toHaveLength(0)
  })
})

describe('a script (API key over /api/agent)', () => {
  beforeEach(() => { keyId = 'key-1' })

  it('applies the write at once and audits it with its source and key', async () => {
    const out = await callAgent('add_account', { code: '6100', name: 'Legal', type: 'expense' })
    expect(out.status).toBe(200)
    expect(out.body.result).toEqual({ code: '6100', name: 'Legal' })
    expect(addChartAccount).toHaveBeenCalledTimes(1)
    expect(store.tables.pending_actions).toHaveLength(0)
    expect(audit()).toEqual([expect.objectContaining({
      action: 'agent.write', source: 'api', actor_id: 'user-me', vehicle_id: 'v1', subject_id: 'add_account',
      details: expect.objectContaining({ tool: 'add_account', credentialId: 'key-1', domain: 'accounting' }),
    })])
  })

  it('does not write twice when a retry repeats its Idempotency-Key', async () => {
    const first = await callAgent('add_account', { code: '6100', name: 'Legal', type: 'expense' }, { 'idempotency-key': 'k1' })
    const retry = await callAgent('add_account', { code: '6100', name: 'Legal', type: 'expense' }, { 'idempotency-key': 'k1' })
    expect(retry.body.result).toEqual(first.body.result)
    expect(addChartAccount).toHaveBeenCalledTimes(1)

    const reused = await callAgent('add_account', { code: '6200', name: 'Audit', type: 'expense' }, { 'idempotency-key': 'k1' })
    expect(reused.status).toBe(400)
    expect(addChartAccount).toHaveBeenCalledTimes(1)
  })
})

describe('MCP idempotency', () => {
  beforeEach(() => { keyId = 'key-1' })

  it('replays a retried call that names the same _meta.idempotencyKey', async () => {
    const a = await callTool('add_account', { code: '6100', name: 'Legal', type: 'expense' }, { idempotencyKey: 'abc' })
    const b = await callTool('add_account', { code: '6100', name: 'Legal', type: 'expense' }, { idempotencyKey: 'abc' })
    expect(b.json).toEqual(a.json)
    expect(addChartAccount).toHaveBeenCalledTimes(1)
  })
})

describe('what waits for approval', () => {
  const oauth = { keyId: 'oauth:x' }
  it('stages an assistant’s writes, never its reads or a key’s writes', () => {
    expect(shouldStage(getTool('add_account')!, {}, oauth)).toBe(true)
    expect(shouldStage(getTool('list_accounts')!, {}, oauth)).toBe(false)
    expect(shouldStage(getTool('add_account')!, {}, { keyId: 'key-1' })).toBe(false)
  })

  it('runs calls that only make drafts or previews directly', () => {
    expect(isDraftOnlyCall({ name: 'post_entry' }, { status: 'draft' })).toBe(true)
    expect(isDraftOnlyCall({ name: 'post_entry' }, {})).toBe(false)
    expect(isDraftOnlyCall({ name: 'allocation' }, { post: false })).toBe(true)
    expect(isDraftOnlyCall({ name: 'allocation' }, {})).toBe(false)
    expect(isDraftOnlyCall({ name: 'post_bank_transaction' }, {})).toBe(false)
  })

  it('keeps a huge input out of the trail', () => {
    expect(auditInput({ csv: 'x'.repeat(30_000) })).toEqual({ truncated: true, bytes: expect.any(Number) })
    expect(auditInput({ code: '6100' })).toEqual({ code: '6100' })
  })
})

describe('reading the trail', () => {
  it('shows an assistant’s write only to someone who may read what it touched', () => {
    const books = visibleTo(member({ accounting: 'read' }))
    const portfolio = visibleTo(member({ portfolio: 'read' }))
    const lps = visibleTo(member({ lp_capital: 'read' }))
    const event = { tool: 'add_partner', input: { name: 'Jane' } }
    expect(portfolio('agent.write', event)).toBe(false)
    expect(lps('agent.write', event)).toBe(true)
    // A carry allocation is GP economics, whoever can read the books.
    expect(books('agent.write', { tool: 'allocation', input: { action: 'carry' } })).toBe(false)
    expect(books('agent.write', { tool: 'no_such_tool', input: {} })).toBe(false)
  })

  it('gates a staged call by its tool', () => {
    const books = visibleTo(member({ accounting: 'read' }))
    const portfolio = visibleTo(member({ portfolio: 'read' }))
    const staged = (tool: string) => ({ actionType: 'agent_tool_call', args: { tool, input: {} } })
    expect(books('pending_action.stage', staged('add_account'))).toBe(true)
    expect(portfolio('pending_action.stage', staged('add_account'))).toBe(false)
    expect(portfolio('pending_action.stage', staged('record_investment'))).toBe(true)
    expect(books('pending_action.stage', staged('no_such_tool'))).toBe(false)
  })
})

describe('the source of a change', () => {
  it('is web outside any wrapper, and the wrapper’s inside one', async () => {
    expect(currentChangeSource()).toBe('web')
    await withChangeSource('api', async () => {
      await Promise.resolve()
      expect(currentChangeSource()).toBe('api')
    })
  })

  it('is written on every audit event, and kept in details when the column is not there yet', async () => {
    const base = { fundId: 'fund-1', actorId: 'u', action: 'entry.post' as const, subjectType: 'journal_entry' }
    await withChangeSource('mcp', () => recordAudit(store.admin, base))
    expect(audit()[0]).toMatchObject({ source: 'mcp' })

    store.failNext('accounting_audit_events', 'insert', 'column "source" does not exist')
    // memoryAdmin's failures carry only a message; give this one Postgres' code.
    const from = store.admin.from
    let first = true
    store.admin.from = (t: string) => {
      const q = from(t)
      if (t !== 'accounting_audit_events' || !first) return q
      first = false
      const insert = q.insert
      q.insert = (rows: any) => { const r = insert(rows); const then = r.then; r.then = (res: any, rej: any) => then((v: any) => res({ ...v, error: v.error && { ...v.error, code: '42703' } }), rej); return r }
      return q
    }
    await recordAudit(store.admin, base)
    store.admin.from = from
    expect(audit()[1]).toMatchObject({ details: { source: 'web' } })
    expect(audit()[1].source).toBeUndefined()
  })
})

describe('the same access rules as the web', () => {
  // Each agent write and the web route that makes the same change. The tool must ask at least
  // what the route asks: the same domain and the same feature switch. (A tool may ask MORE, as
  // `allocation` does for carry.)
  const PAIRS: [tool: string, route: string][] = [
    ['post_entry', 'api/accounting/journal'],
    ['post_drafts', 'api/accounting/journal'],
    ['add_account', 'api/accounting/chart'],
    ['close_period', 'api/accounting/periods'],
    ['allocation', 'api/accounting/allocation'],
    ['post_bank_transaction', 'api/accounting/bank'],
    ['import_bank_transactions', 'api/accounting/bank'],
    ['add_partner', 'api/accounting/commitments'],
    ['book_capital_call', 'api/accounting/capital-calls'],
    ['record_investment', 'api/portfolio/investments'],
    ['forecast_update_plan', 'api/accounting/forecast/[id]'],
    ['forecast_publish', 'api/accounting/forecast/[id]/publish'],
    ['portfolio_construction_update', 'api/accounting/construction'],
  ]

  it.each(PAIRS)('%s is gated like %s', async (toolName, route) => {
    const { ROUTE_DOMAINS } = await import('@/lib/access/route-domains')
    const { accessDomainFor, accessFeatureFor } = await import('@/lib/accounting/agent-tools')
    const tool = getTool(toolName)!
    expect(tool.scope).toBe('write')
    expect(ROUTE_DOMAINS[route], route).toBeDefined()
    expect(accessDomainFor(tool)).toBe(ROUTE_DOMAINS[route].domain)
    expect(accessFeatureFor(tool) ?? null).toBe(ROUTE_DOMAINS[route].feature ?? null)
  })
})
