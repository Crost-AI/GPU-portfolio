// lib/portfolio/sheet-load.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

vi.mock('@/lib/accounting/statement-package', () => ({
  buildStatementPackage: async () => ({
    payload: { scheduleOfInvestments: { rows: [{ companyId: 'k1', name: 'Listed Co', holdingType: 'company', cost: 100, fairValue: 150 }] } },
  }),
}))
import { loadPortfolioSheet } from './sheet-load'

let m: ReturnType<typeof memoryAdmin>
let tables: string[]
const admin = () => ({ from: (t: string) => { tables.push(t); return m.admin.from(t) } }) as any
beforeEach(() => {
  tables = []
  // 1,500 older quotes ahead of the latest: an across-feeds read capped at a row limit would miss it.
  const old = Array.from({ length: 1500 }, (_, i) => ({
    fund_id: 'f', feed_id: 'p1', price: 1, basis: 'close',
    as_of_date: new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
  }))
  m = memoryAdmin({
    companies: [{ id: 'k1', fund_id: 'f', stage: null, status: 'active' }],
    inbound_emails: [], metrics: [], metric_values_latest: [],
    price_feeds: [{ id: 'p1', fund_id: 'f', company_id: 'k1', symbol: 'LCO', active_from: '2019-01-01', active_until: null }],
    price_observations: [...old, { fund_id: 'f', feed_id: 'p1', price: 42.5, basis: 'close', as_of_date: '2024-06-28' }],
  })
})

describe('loadPortfolioSheet — listed prices', () => {
  it('shows the latest quote on or before today for each live feed', async () => {
    const sheet = await loadPortfolioSheet(admin(), 'f', ['Fund I'])
    expect(sheet.companies[0].listed).toEqual({ symbol: 'LCO', price: 42.5, asOf: '2024-06-28' })
    expect(sheet.quoteWarning).toBeUndefined()
  })

  it('a failed quotes read shows the listing with no price, and says so', async () => {
    m.failNext('price_observations', 'select', 'boom')
    const sheet = await loadPortfolioSheet(admin(), 'f', ['Fund I'])
    expect(sheet.companies[0].listed).toEqual({ symbol: 'LCO', price: null, asOf: null })
    expect(sheet.quoteWarning).toMatch(/could not be read/)
  })

  it('a failed feeds read says so too', async () => {
    m.failNext('price_feeds', 'select', 'boom')
    const sheet = await loadPortfolioSheet(admin(), 'f', ['Fund I'])
    expect(sheet.companies[0].listed).toBeNull()
    expect(sheet.quoteWarning).toMatch(/could not be read/)
  })
})

describe('loadPortfolioSheet — latest cash', () => {
  beforeEach(() => {
    m.tables.metrics.push({ id: 'cash', company_id: 'k1', name: 'Cash', is_active: true })
    // The view's one row per metric — the latest reporting period, not the latest import.
    m.tables.metric_values_latest.push({ metric_id: 'cash', value_number: '900' })
  })

  it('reads the latest-period view, not the metric history', async () => {
    const sheet = await loadPortfolioSheet(admin(), 'f', ['Fund I'])
    expect(sheet.companies[0].latestCash).toBe(900)
    expect(tables).toContain('metric_values_latest')
    expect(tables).not.toContain('metric_values')
  })

  it('a failed read throws rather than showing no cash', async () => {
    m.failNext('metric_values_latest', 'select', 'boom')
    await expect(loadPortfolioSheet(admin(), 'f', ['Fund I'])).rejects.toThrow(/boom/)
  })
})
