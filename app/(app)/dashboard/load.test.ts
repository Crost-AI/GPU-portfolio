import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

let events: string[]
// Each read logs when it is awaited and again, a tick later, when it settles.
const timed = async <T>(name: string, value: T) => {
  events.push(`start:${name}`)
  await new Promise(r => setTimeout(r, 5))
  events.push(`end:${name}`)
  return value
}

vi.mock('@/lib/access/entity-scope', () => ({ entityScopeFor: async () => ({ companyIds: null, vehicleNames: null }) }))
vi.mock('@/lib/dashboard/entity-selection-load', () => ({
  loadActiveEntityOptions: () => timed('entity_options', []),
  loadSavedExcluded: () => timed('saved_excluded', null),
  loadFundDefaultExcluded: () => timed('fund_default_excluded', []),
}))
import { loadDashboardPage } from './load'

let m: ReturnType<typeof memoryAdmin>
let tables: string[]
const ctx = () => {
  const client = {
    from: (t: string) => {
      tables.push(t)
      const q = m.admin.from(t)
      if (t === 'companies') return q
      const run = q.then
      q.then = (resolve: any, reject: any) => timed(t, null).then(() => run(resolve, reject))
      return q
    },
  } as any
  return { supabase: client, admin: client, user: { id: 'u' }, page: { isAdmin: true, access: {}, role: 'admin', fundId: 'f' } as any }
}

beforeEach(() => {
  events = []
  tables = []
  m = memoryAdmin({
    companies: [{
      id: 'k1', name: 'Acme', holding_type: 'company', status: 'active', tags: [], portfolio_group: [],
      metrics: [{ id: 'cash', name: 'Cash', is_active: true, display_order: 1 }], parsing_reviews: [],
    }],
    metric_values_latest: [{ metric_id: 'cash', value_number: 900 }],
    metric_values_latest_by_company: [{ company_id: 'k1', period_year: 2026, period_quarter: 3, period_month: 9 }],
    investment_transactions: [],
  })
})

describe('loadDashboardPage', () => {
  it('shows the latest-period cash and the same period as the last report', async () => {
    const data = await loadDashboardPage(ctx())
    expect(data.companies[0].latestCash).toBe(900)
    expect(data.companies[0].lastReportAt).toBe('Sep 2026')
    expect(tables).not.toContain('metric_values')
  })

  it('starts the cash, period, transaction and entity-picker reads before any of them settles', async () => {
    await loadDashboardPage(ctx())
    const reads = ['metric_values_latest', 'metric_values_latest_by_company', 'investment_transactions', 'entity_options', 'saved_excluded', 'fund_default_excluded']
    const firstEnd = events.findIndex(e => e.startsWith('end:'))
    for (const r of reads) expect(events.indexOf(`start:${r}`), r).toBeGreaterThanOrEqual(0)
    for (const r of reads) expect(events.indexOf(`start:${r}`), r).toBeLessThan(firstEnd)
  })

  it('a failed latest-cash read throws rather than showing a blank cash column', async () => {
    m.failNext('metric_values_latest', 'select', 'boom')
    await expect(loadDashboardPage(ctx())).rejects.toThrow(/boom/)
  })
})
