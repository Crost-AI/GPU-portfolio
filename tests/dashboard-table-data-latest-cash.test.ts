import { describe, it, expect, vi, beforeEach } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

// The dashboard table's latest cash is the latest reporting period's value (metric_values_latest),
// not the newest import of a year's values — and a failed read is an error, not a blank column.

const h = vi.hoisted(() => ({ m: null as any, reads: [] as { table: string; ids?: unknown[] }[] }))

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (t: string) => {
      const q = h.m.admin.from(t)
      const read = { table: t } as { table: string; ids?: unknown[] }
      h.reads.push(read)
      const inner = q.in
      q.in = (k: string, vs: unknown[]) => { read.ids = vs; return inner(k, vs) }
      return q
    },
  }),
}))
vi.mock('@/lib/access/entity-scope', () => ({ loadEntityScopeForUser: async () => ({ companyIds: null, vehicleNames: null }) }))

import { GET } from '@/app/api/dashboard/table-data/route'

const company = (i: number) => ({
  id: `k${i}`, fund_id: 'f1', name: `Co ${i}`, holding_type: 'company', status: 'active', tags: [], portfolio_group: [],
  metrics: [{ id: `cash${i}`, name: 'Cash', is_active: true, display_order: 1, value_type: 'number' }],
})

beforeEach(() => {
  h.reads = []
  h.m = memoryAdmin({
    fund_members: [{ user_id: 'u1', fund_id: 'f1', role: 'admin' }],
    companies: [company(0)],
    metric_values: [],
    // The view's one row per metric — what Postgres hands back after its ORDER BY.
    metric_values_latest: [{ metric_id: 'cash0', value_number: 900 }],
  })
})

describe('GET /api/dashboard/table-data — latest cash', () => {
  it('reads the latest-period view, not the metric history', async () => {
    const res = await GET()
    const body = await res.json()
    expect(body.companies[0].latestCash).toBe(900)
    expect(h.reads.some(r => r.table === 'metric_values_latest')).toBe(true)
    // metric_values is still read for the quarterly table, but not for cash.
    expect(h.reads.filter(r => r.table === 'metric_values')).toHaveLength(1)
  })

  it('asks for at most 200 metric ids per read', async () => {
    h.m.tables.companies = Array.from({ length: 450 }, (_, i) => company(i))
    h.m.tables.metric_values_latest = Array.from({ length: 450 }, (_, i) => ({ metric_id: `cash${i}`, value_number: i }))
    const body = await (await GET()).json()
    const chunks = h.reads.filter(r => r.table === 'metric_values_latest').map(r => r.ids!)
    expect(chunks.map(c => c.length)).toEqual([200, 200, 50])
    expect(new Set(chunks.flat())).toEqual(new Set(Array.from({ length: 450 }, (_, i) => `cash${i}`)))
    expect(body.companies.find((c: any) => c.id === 'k449').latestCash).toBe(449)
  })

  it('a failed read is a database error, not a blank cash column', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.m.failNext('metric_values_latest', 'select', 'boom')
    const res = await GET()
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'An unexpected error occurred.' })
    spy.mockRestore()
  })
})
