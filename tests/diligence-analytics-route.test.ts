// tests/diligence-analytics-route.test.ts
import { describe, expect, it, vi } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

const s = vi.hoisted(() => ({ m: null as any, selects: [] as { table: string; cols: string }[] }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({
  // Record every table + column list the route asks for, so a test can prove the draft JSON is
  // never selected (memoryAdmin itself returns whole rows whatever the column list says).
  createAdminClient: () => ({
    ...s.m.admin,
    from: (t: string) => {
      const q = s.m.admin.from(t)
      const select = q.select
      q.select = (cols: string, o?: any) => { s.selects.push({ table: t, cols }); return select(cols, o) }
      return q
    },
  }),
}))
import { GET } from '@/app/api/diligence/analytics/route'

const ADMIN = { user_id: 'u', fund_id: 'f', role: 'admin', display_name: 'Ann' }

const flags = (over: Record<string, unknown>) => ({
  fund_id: 'f', has_ingestion: false, has_research: false, qa_count: 0, has_memo_draft: false,
  is_draft: true, finalized_at: null, created_at: '2026-01-05T00:00:00Z', ...over,
})

function seed(deals: any[], drafts: any[], opts: { maxRows?: number } = {}) {
  s.selects = []
  s.m = memoryAdmin({ fund_members: [ADMIN], diligence_deals: deals, diligence_memo_draft_flags: drafts }, opts)
}

describe('GET /api/diligence/analytics', () => {
  it('reads the flags view, never the drafts JSON, and builds the funnel from the flags', async () => {
    seed(
      [
        { id: 'd1', fund_id: 'f', name: 'A', sector: 'AI', deal_status: 'won', lead_partner_id: 'u', created_at: '2026-01-01T00:00:00Z' },
        { id: 'd2', fund_id: 'f', name: 'B', sector: null, deal_status: 'active', lead_partner_id: null, created_at: '2026-01-01T00:00:00Z' },
        { id: 'd3', fund_id: 'f', name: 'C', sector: 'AI', deal_status: 'passed', lead_partner_id: null, created_at: '2026-01-01T00:00:00Z' },
      ],
      [
        flags({ id: 'm1', deal_id: 'd1', has_ingestion: true, has_research: true, qa_count: 2, has_memo_draft: true, created_at: '2026-01-03T00:00:00Z' }),
        flags({ id: 'm2', deal_id: 'd1', has_memo_draft: true, is_draft: false, finalized_at: '2026-01-07T00:00:00Z', created_at: '2026-01-05T00:00:00Z' }),
        // qa_count 0 is not Q&A, even though the draft exists
        flags({ id: 'm3', deal_id: 'd2', has_ingestion: true, qa_count: 0 }),
        // another fund's draft is not counted
        flags({ id: 'm4', deal_id: 'd3', fund_id: 'other', has_ingestion: true, qa_count: 5 }),
      ],
    )

    const res = await GET({} as any)
    expect(res.status).toBe(200)
    const json = await res.json()

    expect(s.selects.some(x => x.table === 'diligence_memo_draft_flags')).toBe(true)
    expect(s.selects.some(x => x.table === 'diligence_memo_drafts')).toBe(false)
    expect(s.selects.some(x => /ingestion_output|memo_draft_output|research_output|qa_answers/.test(x.cols))).toBe(false)

    expect(json.funnel).toEqual({ created: 3, has_ingestion: 2, has_research: 1, has_qa: 1, has_memo_draft: 1, finalized: 1, won: 1 })
    expect(json.summary).toEqual({ total: 3, active: 1, passed: 1, won: 1, lost: 0, on_hold: 0 })
    expect(json.time_in_stage.median_days_created_to_draft).toBe(2)
    expect(json.time_in_stage.median_days_draft_to_final).toBe(4)
  })

  it('counts every deal and draft past the 1000-row cap', async () => {
    const deals = Array.from({ length: 1200 }, (_, i) => ({
      id: `d${String(i).padStart(5, '0')}`, fund_id: 'f', name: `D${i}`, sector: null, deal_status: 'active',
      lead_partner_id: null, created_at: '2026-01-01T00:00:00Z',
    }))
    const drafts = deals.map((d, i) => flags({ id: `m${String(i).padStart(5, '0')}`, deal_id: d.id, has_ingestion: true, qa_count: 1 }))
    seed(deals, drafts, { maxRows: 1000 })

    const json = await (await GET({} as any)).json()

    expect(json.summary.total).toBe(1200)
    expect(json.funnel.created).toBe(1200)
    expect(json.funnel.has_ingestion).toBe(1200)
    expect(json.funnel.has_qa).toBe(1200)
  })

  it('answers 500 rather than computing on partial data when a read fails', async () => {
    seed([{ id: 'd1', fund_id: 'f', name: 'A', sector: null, deal_status: 'active', created_at: null }], [])
    s.m.failNext('diligence_memo_draft_flags', 'select', 'permission denied for view diligence_memo_draft_flags')

    const res = await GET({} as any)

    expect(res.status).toBe(500)
    expect((await res.json()).error).toMatch(/diligence analytics/)
  })
})
