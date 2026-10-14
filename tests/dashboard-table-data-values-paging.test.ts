import { describe, it, expect, vi, beforeEach } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

// The dashboard table's quarterly values: every row since 2025, however many metrics and rows —
// read oldest first, a capped or truncated read would silently drop the newest quarters.

const h = vi.hoisted(() => ({ m: null as any, reads: [] as { table: string; ids?: unknown[]; paged: boolean }[] }))

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (t: string) => {
      const q = h.m.admin.from(t)
      const read = { table: t, paged: false } as { table: string; ids?: unknown[]; paged: boolean }
      h.reads.push(read)
      const [inner, range] = [q.in, q.range]
      q.in = (k: string, vs: unknown[]) => { read.ids = vs; return inner(k, vs) }
      q.range = (a: number, b: number) => { read.paged = true; return range(a, b) }
      return q
    },
  }),
}))
vi.mock('@/lib/access/entity-scope', () => ({ loadEntityScopeForUser: async () => ({ companyIds: null, vehicleNames: null }) }))

import { GET } from '@/app/api/dashboard/table-data/route'

const company = (i: number) => ({
  id: `k${i}`, fund_id: 'f1', name: `Co ${i}`, holding_type: 'company', status: 'active', tags: [], portfolio_group: [],
  metrics: [{ id: `m${i}`, name: 'Revenue', is_active: true, display_order: 1, value_type: 'number' }],
})
// The quarterly read is the paged one; the cash read is not.
const valueReads = () => h.reads.filter(r => r.table === 'metric_values' && r.paged)

beforeEach(() => {
  h.reads = []
  h.m = memoryAdmin({
    fund_members: [{ user_id: 'u1', fund_id: 'f1', role: 'admin' }],
    companies: [company(0)],
    metric_values: [],
    metric_values_latest: [],
  }, { maxRows: 1000 })
})

describe('GET /api/dashboard/table-data — quarterly values', () => {
  it('returns every row past the 1,000-row cap, newest quarters included', async () => {
    // 1,100 monthly values for one metric, Jan 2025 to Aug 2116: the cap would cut the last 100.
    h.m.tables.metric_values = Array.from({ length: 1100 }, (_, i) => ({
      id: `v${String(i).padStart(4, '0')}`, metric_id: 'm0', company_id: 'k0', fund_id: 'f1',
      period_year: 2025 + Math.floor(i / 12), period_quarter: null, period_month: (i % 12) + 1, value_number: i, value_text: null,
    }))
    const body = await (await GET()).json()
    const values = body.companies[0].metrics[0].values
    expect(Object.keys(values)).toHaveLength(367)   // 91 years of quarters, then Q1–Q3 2116
    expect(values['Q3 2116']).toBe(1099)
  })

  it('asks for at most 200 metric ids per read', async () => {
    h.m.tables.companies = Array.from({ length: 450 }, (_, i) => company(i))
    await GET()
    const chunks = valueReads().map(r => r.ids!)
    expect(chunks.map(c => c.length)).toEqual([200, 200, 50])
    expect(new Set(chunks.flat())).toEqual(new Set(Array.from({ length: 450 }, (_, i) => `m${i}`)))
  })

  it('a failed read is a database error, not an empty table', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.m.failNext('metric_values', 'select', 'boom')
    const res = await GET()
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'An unexpected error occurred.' })
    spy.mockRestore()
  })
})
