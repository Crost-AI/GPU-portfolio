import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

vi.mock('@/lib/access/entity-scope', () => ({ entityScopeFor: async () => ({ companyIds: null, vehicleNames: null }) }))
vi.mock('@/lib/access/page-gate', () => ({ canViewPage: () => true }))
vi.mock('@/lib/portfolio/holding-entities', () => ({ holdingEntities: async () => [] }))
import { loadCompanyPage } from './load'

let m: ReturnType<typeof memoryAdmin>
let tables: string[]
const ctx = () => {
  const supabase = { from: (t: string) => { tables.push(t); return m.admin.from(t) } } as any
  return { supabase, admin: supabase, user: { id: 'u' }, page: { isAdmin: true, access: {} } as any }
}

beforeEach(() => {
  tables = []
  m = memoryAdmin({
    companies: [{ id: 'k1', fund_id: 'f', holding_type: 'company', portfolio_group: [] }],
    fund_settings: [{ fund_id: 'f', currency: 'USD' }],
    metrics: [
      { id: 'cash', company_id: 'k1', slug: 'cash', name: 'Cash', is_active: true, display_order: 1 },
      { id: 'mrr', company_id: 'k1', slug: 'mrr', name: 'MRR', is_active: true, display_order: 2 },
    ],
    // The view's one row per metric — what Postgres hands back after its ORDER BY.
    metric_values_latest: [
      { metric_id: 'cash', value_number: 900, period_label: 'Sep 2026' },
      { metric_id: 'mrr', value_number: 40, period_label: 'Q3 2026' },
    ],
    company_updates: [],
  })
})

describe('loadCompanyPage — latest MRR and cash', () => {
  it('reads the latest-period view, not the metric history', async () => {
    const data = await loadCompanyPage(ctx(), { id: 'k1' })
    expect(data?.latestCash).toMatchObject({ value: 900, period: 'Sep 2026' })
    expect(data?.latestMrr).toMatchObject({ value: 40, period: 'Q3 2026' })
    expect(tables).toContain('metric_values_latest')
    expect(tables).not.toContain('metric_values')
  })

  it('a failed read throws rather than showing no cash', async () => {
    m.failNext('metric_values_latest', 'select', 'boom')
    await expect(loadCompanyPage(ctx(), { id: 'k1' })).rejects.toThrow(/boom/)
  })
})
