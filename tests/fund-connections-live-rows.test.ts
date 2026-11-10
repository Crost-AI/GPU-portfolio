import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

// What a connected fund adds to our LP's report card and PDF (upstream #124; Bugbot on #131): its
// vehicles are named with the fund, and a fund reporting in another currency is left out and named,
// since nothing converts. And the pairing reads go past PostgREST's row cap.

const s = vi.hoisted(() => ({ reports: {} as Record<string, any[]> }))
vi.mock('@/lib/accounting/live-report', () => ({ generateLiveReport: async (_db: unknown, fundId: string) => ({ rows: s.reports[fundId] ?? [] }) }))
vi.mock('@/lib/accounting/lp-positions', async (orig) => ({ ...(await orig<any>()), lastDataDates: async (_db: unknown, _f: string, groups: string[]) => new Map(groups.map(g => [g, '2026-06-30'])) }))
import { connectionPairs, linkedLiveRows } from '@/lib/fund-connections'

const row = (entity_id: string, portfolio_group: string, nav: number) => ({ entity_id, portfolio_group, nav, commitment: 100 })
const connection = (id: string, other: string) => ({ id, requester_fund_id: 'home', recipient_fund_id: other, status: 'active' })
const link = (connection_id: string, ours: string, theirs: string) => ({
  id: `l-${connection_id}`, connection_id, requester_investor_id: ours, recipient_investor_id: theirs,
  requester_approved_at: '2026-01-01', recipient_approved_at: '2026-01-01', approved: true,
})

let m: ReturnType<typeof memoryAdmin>
beforeEach(() => {
  s.reports = { usd: [row('e-usd', 'Fund I', 10)], eur: [row('e-eur', 'Fund I', 20)] }
  m = memoryAdmin({
    fund_connections: [connection('c-usd', 'usd'), connection('c-eur', 'eur')],
    lp_investor_links: [link('c-usd', 'inv-1', 'their-usd'), link('c-eur', 'inv-1', 'their-eur')],
    lp_entities: [
      { id: 'e-usd', fund_id: 'usd', entity_name: 'Example LP', investor_id: 'their-usd' },
      { id: 'e-eur', fund_id: 'eur', entity_name: 'Example LP', investor_id: 'their-eur' },
    ],
    funds: [{ id: 'usd', name: 'Dollar Fund' }, { id: 'eur', name: 'Euro Fund' }],
    fund_settings: [{ fund_id: 'home', currency: 'USD' }, { fund_id: 'usd', currency: 'USD' }, { fund_id: 'eur', currency: 'EUR' }],
  }, { maxRows: 1000 })
})

describe('linkedLiveRows', () => {
  it('names a connected vehicle with its fund, on the row and its date', async () => {
    const out = await linkedLiveRows(m.admin, { fundId: 'home', investorIds: ['inv-1'] })
    expect(out.rows.map(r => r.row.portfolio_group)).toEqual(['Dollar Fund: Fund I'])
    expect(out.vehicleDates).toEqual([{ vehicle: 'Dollar Fund: Fund I', date: '2026-06-30' }])
  })

  it('leaves out a fund in another currency, and names it, rather than add its figures to ours', async () => {
    const out = await linkedLiveRows(m.admin, { fundId: 'home', investorIds: ['inv-1'] })
    expect(out.rows.some(r => r.fundId === 'eur')).toBe(false)
    expect(out.vehicleDates.some(v => v.vehicle.startsWith('Euro Fund'))).toBe(false)
    expect(out.omitted).toEqual([{ investorId: 'inv-1', label: 'Euro Fund (reported in EUR)' }])
  })

  it('a fund in the same currency once settings agree is included', async () => {
    m.tables.fund_settings.find(f => f.fund_id === 'eur')!.currency = 'USD'
    const out = await linkedLiveRows(m.admin, { fundId: 'home', investorIds: ['inv-1'] })
    expect(out.rows.map(r => r.fundId).sort()).toEqual(['eur', 'usd'])
    expect(out.omitted).toEqual([])
  })
})

describe('pairing reads', () => {
  it('reach investors past the 1000-row cap', async () => {
    m.tables.lp_investors = Array.from({ length: 1005 }, (_, i) => ({ id: `home-${String(i).padStart(4, '0')}`, fund_id: 'home', name: `LP ${String(i).padStart(4, '0')}`, contact_email: null }))
    m.tables.lp_investor_links = []
    const out = await connectionPairs(m.admin, { fundId: 'home', connectionId: 'c-usd' })
    expect(out.unpaired).toHaveLength(1005)
    expect(out.unpaired.map(u => u.id)).toContain('home-1004')
  })
})
