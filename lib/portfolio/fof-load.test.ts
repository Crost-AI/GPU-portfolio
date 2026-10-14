import { describe, expect, it } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'
import { loadFofRaw } from './fof-load'

/**
 * The fund-of-funds register is read oldest first, so a read truncated at PostgREST's max_rows
 * (1000, supabase/config.toml) loses exactly the rows that matter: the latest manager NAV and the
 * latest notices. Every client here enforces that cap.
 */
const day = (i: number) => new Date(Date.UTC(2015, 0, 1) + i * 86_400_000).toISOString().slice(0, 10)
const seed = (navs: number, events: number) => ({
  fund_vehicles: [{ id: 'v1', fund_id: 'f', name: 'Fund I' }],
  companies: [{ id: 'h1', fund_id: 'f', name: 'Acme Ventures III', holding_type: 'fund' }],
  fund_holding_terms: [{ id: 'term1', fund_id: 'f', company_id: 'h1', vehicle_id: 'v1', commitment: 5000 }],
  fund_capital_events: Array.from({ length: events }, (_, i) => ({
    id: `ev${String(i).padStart(5, '0')}`, fund_id: 'f', company_id: 'h1', vehicle_id: 'v1', kind: 'call', event_date: day(i), amount: 1, status: 'confirmed',
  })),
  fund_nav_statements: Array.from({ length: navs }, (_, i) => ({
    id: `nav${String(i).padStart(5, '0')}`, fund_id: 'f', company_id: 'h1', vehicle_id: 'v1', as_of_date: day(i), reported_nav: i,
  })),
  chart_of_accounts: [],
})

describe('loadFofRaw reads past the 1000-row cap', () => {
  it('returns every NAV statement and notice, the newest included', async () => {
    const { admin } = memoryAdmin(seed(1200, 1100), { maxRows: 1000 })
    const raw = (await loadFofRaw(admin as any, 'f', 'Fund I'))!
    expect(raw.navs).toHaveLength(1200)
    expect(raw.navs.at(-1)).toMatchObject({ as_of_date: day(1199), reported_nav: 1199 })
    expect(raw.events).toHaveLength(1100)
    expect(raw.events.at(-1)!.event_date).toBe(day(1099))
  })

  it('throws, naming the register, when a read fails', async () => {
    const m = memoryAdmin(seed(2, 2), { maxRows: 1000 })
    m.failNext('fund_nav_statements', 'select', 'connection reset')
    await expect(loadFofRaw(m.admin as any, 'f', 'Fund I')).rejects.toThrow('The fund register could not be loaded: connection reset')
  })
})
