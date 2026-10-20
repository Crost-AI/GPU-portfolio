import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { memoryAdmin } from '@/tests/helpers/memory-admin'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureVisibilityMap } from '@/lib/types/features'
import type { AccessContext } from '@/lib/access/effective'

// ── GPU fleet (P3) ── Claude review on #98, B2 and S1: entity-scoped, service-role readers of a
// company's updates, notes and interactions, the agent's get_updates, the v1 API's conversations,
// and filing an email under a company. A member with portfolio but not fleet must not reach the
// fleet company through any of them. The search RPC layer is stubbed (no RPC in memory); every
// route, scope and gate runs for real.

const s = vi.hoisted(() => ({ m: null as any, ctx: null as any, updates: [] as any[], artifacts: [] as any[], seen: null as any }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u' } } }) }, from: (t: string) => s.m.admin.from(t) }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => s.m.admin }))
vi.mock('@/lib/access/effective', async orig => ({ ...(await orig<any>()), loadAccessContext: async () => s.ctx }))
vi.mock('@/lib/company-updates/search', async orig => ({
  ...(await orig<any>()),
  // As the security definer RPC: filters on exactly the company ids it is given (none = all).
  searchCompanyUpdates: async (_a: unknown, params: any) => {
    const results = s.updates.filter(u => !params.companyIds || params.companyIds.includes(u.company_id))
    return { total: results.length, results, next_cursor: null, match_mode: 'all', order: 'newest' }
  },
  getCompanyUpdate: async (_a: unknown, { updateId }: any) => s.updates.find(u => u.id === updateId) ?? null,
  getCompanyUpdateArtifact: async (_a: unknown, { artifactId }: any) => s.artifacts.find(a => a.id === artifactId) ?? null,
}))
vi.mock('@/lib/company-updates/analyst', async orig => ({ ...(await orig<any>()), getUpdates: async (deps: any) => { s.seen = deps.visibleCompanyIds; return { ok: true } } }))

import { GET as search } from '@/app/api/company-updates/search/route'
import { GET as oneUpdate } from '@/app/api/company-updates/[id]/route'
import { GET as artifact } from '@/app/api/company-updates/[id]/artifacts/[artifactId]/route'
import { GET as notes } from '@/app/api/notes/route'
import { GET as interactions } from '@/app/api/interactions/route'
import { GET as analystThreads } from '@/app/api/analyst/conversations/route'
import { PATCH as patchEmail } from '@/app/api/emails/[id]/route'
import { PORTFOLIO_HANDLERS } from '@/lib/agent/portfolio-tools'
import { getConversation, listConversations } from '@/lib/api-v1/conversations'
import { FLEET_HIDDEN_SCAN_CAP, firstVisibleRows } from '@/lib/access/fleet-company'

const ctx = (over: Partial<AccessContext>): AccessContext => ({
  fundId: 'f', userId: 'u', role: 'member', vehicles: { all: true, ids: [] },
  features: { ...DEFAULT_FEATURE_VISIBILITY, accounting: 'everyone', gpu_fleet: 'everyone' } as FeatureVisibilityMap,
  grants: { portfolio: 'write', accounting: 'write', fleet: 'none' }, defaults: {}, ...over,
})
const NO_FLEET = () => ctx({})
const FLEET_READ = () => ctx({ grants: { portfolio: 'write', accounting: 'read', fleet: 'read' } })
const FLEET_WRITE = () => ctx({ grants: { portfolio: 'write', accounting: 'write', fleet: 'write' } })
// Claude B1: fleet without accounting read is no fleet at all.
const FLEET_NO_ACCOUNTING = () => ctx({ grants: { portfolio: 'write', accounting: 'none', fleet: 'write' } })

const req = (url: string, method = 'GET', body?: object) => new NextRequest(`http://localhost${url}`, body ? { method, body: JSON.stringify(body) } : { method })
const p = <T extends object>(v: T) => ({ params: Promise.resolve(v) })

beforeEach(() => {
  s.ctx = NO_FLEET()
  s.seen = null
  s.updates = [
    { id: 'up-fleet', fund_id: 'f', company_id: 'fleet', source_email_id: 'em-1', body_current: 'gross 25,920' },
    { id: 'up-vc', fund_id: 'f', company_id: 'vc', source_email_id: 'em-2', body_current: 'MRR 10' },
  ]
  s.artifacts = [{ id: 'art-1', update_id: 'up-fleet', filename: 'statement.pdf', storage_path: null }]
  s.m = memoryAdmin({
    fund_members: [{ fund_id: 'f', user_id: 'u', role: 'member', display_name: 'Me' }],
    fund_vehicles: [], fund_member_vehicles: [], note_reads: [],
    companies: [
      { id: 'fleet', fund_id: 'f', name: 'Fleet — GPU I', holding_type: 'gpu_fleet' },
      { id: 'vc', fund_id: 'f', name: 'Acme', holding_type: 'company' },
    ],
    company_notes: [
      { id: 'n-fleet', fund_id: 'f', company_id: 'fleet', user_id: 'u', content: 'payout late', created_at: '2026-10-02', pinned_at: null },
      { id: 'n-vc', fund_id: 'f', company_id: 'vc', user_id: 'u', content: 'board', created_at: '2026-10-01', pinned_at: null },
      { id: 'n-gen', fund_id: 'f', company_id: null, user_id: 'u', content: 'general', created_at: '2026-09-30', pinned_at: null },
    ],
    interactions: [
      { id: 'i-fleet', fund_id: 'f', company_id: 'fleet', interaction_date: '2026-10-02', tags: [] },
      { id: 'i-vc', fund_id: 'f', company_id: 'vc', interaction_date: '2026-10-01', tags: [] },
    ],
    inbound_emails: [{ id: 'em-9', fund_id: 'f', company_id: null }],
    analyst_conversations: [
      { id: 'c-fleet', fund_id: 'f', user_id: 'u', company_id: 'fleet', title: 'fleet', messages: [], updated_at: '2026-10-02', created_at: '2026-10-02' },
      { id: 'c-vc', fund_id: 'f', user_id: 'u', company_id: 'vc', title: 'vc', messages: [], updated_at: '2026-10-01', created_at: '2026-10-01' },
    ],
  })
  s.m.admin.auth = { admin: { getUserById: async () => ({ data: { user: { email: 'me@x' } } }) } }
})

const searchIds = async () => ((await (await search(req('/api/company-updates/search?q=gross'))).json()).results as any[]).map(r => r.id).sort()

describe('company updates (B2)', () => {
  it('search leaves the fleet company’s updates out without fleet, and keeps them with it', async () => {
    expect(await searchIds()).toEqual(['up-vc'])
    s.ctx = FLEET_NO_ACCOUNTING()
    expect(await searchIds()).toEqual(['up-vc'])
    s.ctx = FLEET_READ()
    expect(await searchIds()).toEqual(['up-fleet', 'up-vc'])
  })

  it('an update and its attachment by id are not found without fleet', async () => {
    expect((await oneUpdate(req('/api/company-updates/up-fleet'), p({ id: 'up-fleet' }))).status).toBe(404)
    expect((await oneUpdate(req('/api/company-updates/up-vc'), p({ id: 'up-vc' }))).status).toBe(200)
    expect((await artifact(req('/api/company-updates/up-fleet/artifacts/art-1'), p({ id: 'up-fleet', artifactId: 'art-1' }))).status).toBe(404)
    s.ctx = FLEET_READ()
    expect((await oneUpdate(req('/api/company-updates/up-fleet'), p({ id: 'up-fleet' }))).status).toBe(200)
  })

  it('the agent’s get_updates is given a visible set without the fleet company', async () => {
    const call = (access: AccessContext) => (PORTFOLIO_HANDLERS.get_updates as any)({ admin: s.m.admin, fundId: 'f', access }, { mode: 'search', query: 'revenue' })
    await call(NO_FLEET())
    expect(s.seen).toEqual(['vc'])
    await call(FLEET_READ())
    expect(s.seen).toBeNull()
  })
})

describe('notes and interactions (B2)', () => {
  it('the fund-wide lists drop rows about the fleet company without fleet; general rows stay', async () => {
    const noteIds = async () => ((await (await notes(req('/api/notes'))).json()) as any[]).map(n => n.id).sort()
    const interactionIds = async () => ((await (await interactions(req('/api/interactions'))).json()) as any[]).map(i => i.id).sort()
    expect(await noteIds()).toEqual(['n-gen', 'n-vc'])
    expect(await interactionIds()).toEqual(['i-vc'])
    s.ctx = FLEET_READ()
    expect(await noteIds()).toEqual(['n-fleet', 'n-gen', 'n-vc'])
    expect(await interactionIds()).toEqual(['i-fleet', 'i-vc'])
  })
})

// Codex r3 on #98: hidden rows are skipped BEFORE the limit, so a page full of fleet rows cannot
// push a visible row out of the list.
describe('hidden fleet rows never take a place in the limit', () => {
  const day = (n: number) => `2026-08-${String(n).padStart(2, '0')}`
  const ts = (i: number) => `2026-10-10T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`

  it('notes: 200 fleet notes ahead of a visible one; the visible note just beyond them is returned', async () => {
    for (let i = 0; i < 200; i++) s.m.tables.company_notes.push({ id: `n-h${i}`, fund_id: 'f', company_id: 'fleet', user_id: 'u', content: 'x', created_at: ts(i), pinned_at: null })
    s.m.tables.company_notes.push({ id: 'n-late', fund_id: 'f', company_id: 'vc', user_id: 'u', content: 'y', created_at: '2026-09-01', pinned_at: null })
    const ids = ((await (await notes(req('/api/notes'))).json()) as any[]).map(n => n.id)
    expect(ids).toEqual(['n-vc', 'n-gen', 'n-late'])
    s.ctx = FLEET_READ()
    expect(((await (await notes(req('/api/notes'))).json()) as any[])).toHaveLength(200)
  })

  it('interactions: a limit-full of fleet rows ahead of a visible one; the visible one is returned, in order', async () => {
    for (let i = 0; i < 200; i++) s.m.tables.interactions.push({ id: `i-h${i}`, fund_id: 'f', company_id: 'fleet', interaction_date: ts(i), tags: [] })
    s.m.tables.interactions.push({ id: 'i-late', fund_id: 'f', company_id: 'vc', interaction_date: day(1), tags: [] })
    const ids = ((await (await interactions(req('/api/interactions?limit=200'))).json()) as any[]).map(i => i.id)
    expect(ids).toEqual(['i-vc', 'i-late'])
  })

  it('analyst threads: 20 fleet threads ahead of a visible one; the visible one is returned', async () => {
    s.m.tables.analyst_conversations = []
    for (let i = 0; i < 20; i++) s.m.tables.analyst_conversations.push({ id: `c-h${i}`, fund_id: 'f', user_id: 'u', company_id: 'fleet', updated_at: ts(i) })
    s.m.tables.analyst_conversations.push({ id: 'c-late', fund_id: 'f', user_id: 'u', company_id: 'vc', updated_at: day(1) })
    const body = await (await analystThreads(req('/api/analyst/conversations'))).json()
    expect(body.conversations.map((c: any) => c.id)).toEqual(['c-late'])
  })

  it('v1 conversations: pages and their cursors skip hidden threads and keep the order', async () => {
    const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
    const iso = (i: number) => `2026-10-10T00:00:${String(i).padStart(2, '0')}.000Z`
    s.m.tables.analyst_conversations = []
    for (let i = 0; i < 5; i++) s.m.tables.analyst_conversations.push({ id: uuid(10 + i), fund_id: 'f', user_id: 'u', company_id: 'fleet', title: 'h', updated_at: iso(10 + i), created_at: iso(0) })
    for (const [n, company] of [[9, 'vc'], [8, null], [7, 'vc']] as const) {
      s.m.tables.analyst_conversations.push({ id: uuid(n), fund_id: 'f', user_id: 'u', company_id: company, title: `t${n}`, updated_at: iso(n), created_at: iso(0) })
    }
    const principal = { userId: 'u', fundId: 'f', role: 'member', access: NO_FLEET() } as any
    const first = await listConversations(s.m.admin, principal, { limit: 2 })
    expect(first.conversations.map((c: any) => c.id)).toEqual([uuid(9), uuid(8)])
    expect(first.nextCursor).not.toBeNull()
    const second = await listConversations(s.m.admin, principal, { limit: 2, cursor: first.nextCursor })
    expect(second.conversations.map((c: any) => c.id)).toEqual([uuid(7)])
    expect(second.nextCursor).toBeNull()
  })
})

// Security review on 4f08c2db (query amplification): skipping hidden rows reads pages of at least
// 200 whatever the caller's limit, growing to max_rows, and stops at FLEET_HIDDEN_SCAN_CAP rows.
describe('the hidden-row scan is bounded', () => {
  const ts = (i: number) => `2026-10-10T${String(Math.floor(i / 3600)).padStart(2, '0')}:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`

  it('interactions?limit=1 behind 1000 hidden rows: the visible row comes back in at most 5 page reads', async () => {
    for (let i = 0; i < 1000; i++) s.m.tables.interactions.push({ id: `i-h${i}`, fund_id: 'f', company_id: 'fleet', interaction_date: ts(i), tags: [] })
    s.m.tables.interactions = s.m.tables.interactions.filter((r: any) => r.id !== 'i-vc')
    s.m.tables.interactions.push({ id: 'i-late', fund_id: 'f', company_id: 'vc', interaction_date: '2026-09-01', tags: [] })
    const from = s.m.admin.from
    let reads = 0
    s.m.admin.from = (t: string) => { if (t === 'interactions') reads++; return from(t) }
    const ids = ((await (await interactions(req('/api/interactions?limit=1'))).json()) as any[]).map(i => i.id)
    expect(ids).toEqual(['i-late'])
    expect(reads).toBeGreaterThan(0)
    expect(reads).toBeLessThanOrEqual(5)
  })

  it('at the cap the list returns a partial page instead of reading on', async () => {
    const rows = [...Array.from({ length: 6000 }, (_, i) => ({ id: `h${i}`, company_id: 'fleet' })), { id: 'v', company_id: 'vc' }]
    const ranges: [number, number][] = []
    const out = await firstVisibleRows(async (a, b) => { ranges.push([a, b]); return { data: rows.slice(a, b + 1), error: null } }, 1, new Set(['fleet']))
    expect(out).toEqual({ data: [], error: null })
    expect(ranges.reduce((n, [a, b]) => n + b - a + 1, 0)).toBe(FLEET_HIDDEN_SCAN_CAP)
    expect(ranges.every(([a, b]) => b - a + 1 >= 200 && b - a + 1 <= 1000)).toBe(true)
  })

  it('v1: at the cap the page comes back short with a cursor past the last row read, and the next page carries on', async () => {
    const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
    const iso = (i: number) => new Date(Date.UTC(2026, 9, 10) + i * 1000).toISOString()
    s.m.tables.analyst_conversations = []
    const hiddenCount = FLEET_HIDDEN_SCAN_CAP + 10
    for (let i = 0; i < hiddenCount; i++) s.m.tables.analyst_conversations.push({ id: uuid(100 + i), fund_id: 'f', user_id: 'u', company_id: 'fleet', updated_at: iso(10 + i), created_at: iso(0) })
    for (const n of [3, 2]) s.m.tables.analyst_conversations.push({ id: uuid(n), fund_id: 'f', user_id: 'u', company_id: 'vc', updated_at: iso(n), created_at: iso(0) })
    const principal = { userId: 'u', fundId: 'f', role: 'member', access: NO_FLEET() } as any
    const first = await listConversations(s.m.admin, principal, { limit: 2 })
    expect(first.conversations).toEqual([])
    expect(first.nextCursor).not.toBeNull()
    const second = await listConversations(s.m.admin, principal, { limit: 2, cursor: first.nextCursor })
    expect(second.conversations.map((c: any) => c.id)).toEqual([uuid(3), uuid(2)])
    expect(second.nextCursor).toBeNull()
  })
})

describe('the v1 API’s conversations', () => {
  it('lists and fetches a fleet thread only with fleet read', async () => {
    const principal = (access: AccessContext) => ({ userId: 'u', fundId: 'f', role: 'member', access }) as any
    expect((await listConversations(s.m.admin, principal(NO_FLEET()), { limit: 10 })).conversations.map((c: any) => c.id)).toEqual(['c-vc'])
    expect(await getConversation(s.m.admin, principal(NO_FLEET()), 'c-fleet')).toBeNull()
    s.ctx = FLEET_READ()
    expect((await listConversations(s.m.admin, principal(FLEET_READ()), { limit: 10 })).conversations.map((c: any) => c.id)).toEqual(['c-fleet', 'c-vc'])
    expect(await getConversation(s.m.admin, principal(FLEET_READ()), 'c-fleet')).not.toBeNull()
  })
})

describe('filing an email under the fleet company (S1)', () => {
  it('needs fleet write: 403 for a fleet reader, allowed for a fleet writer; a VC company is unchanged', async () => {
    s.ctx = FLEET_READ()
    const denied = await patchEmail(req('/api/emails/em-9', 'PATCH', { companyId: 'fleet' }), p({ id: 'em-9' }))
    expect(denied.status).toBe(403)
    expect(s.m.tables.inbound_emails[0].company_id).toBeNull()
    expect((await patchEmail(req('/api/emails/em-9', 'PATCH', { companyId: 'vc' }), p({ id: 'em-9' }))).status).toBe(200)
    s.ctx = FLEET_WRITE()
    expect((await patchEmail(req('/api/emails/em-9', 'PATCH', { companyId: 'fleet' }), p({ id: 'em-9' }))).status).toBe(200)
    expect(s.m.tables.inbound_emails[0].company_id).toBe('fleet')
  })
})

describe('moving an email off the fleet company (security review on #98)', () => {
  it('reassigning or unmatching an email filed under the fleet company needs fleet write', async () => {
    s.m.tables.inbound_emails[0].company_id = 'fleet'
    s.ctx = FLEET_READ()
    expect(await isNotFound(await patchEmail(req('/api/emails/em-9', 'PATCH', { companyId: 'vc' }), p({ id: 'em-9' })))).toBe(true)
    expect(s.m.tables.inbound_emails[0].company_id).toBe('fleet')
    s.ctx = FLEET_WRITE()
    expect((await patchEmail(req('/api/emails/em-9', 'PATCH', { companyId: 'vc' }), p({ id: 'em-9' }))).status).toBe(200)
    expect(s.m.tables.inbound_emails[0].company_id).toBe('vc')
  })
})
const isNotFound = async (res: Response) => res.status === 404 && (await res.clone().json()).error === 'Not found'
