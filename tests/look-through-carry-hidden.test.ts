import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { memoryAdmin } from '@/tests/helpers/memory-admin'
import { DEFAULT_FEATURE_VISIBILITY } from '@/lib/types/features'

// Crost #141: a linked associate's position is replaced by one row per member, each holding a share
// of the carry by carry points. A caller without gp_economics sees those members WITHOUT the carry.
// The proof these tests lean on: for that caller, nothing in the response depends on the carry at all,
// so no field, total or difference between two figures can give it back. The real report runs here,
// through the real routes; only the loaders under it are stubbed.

const s = vi.hoisted(() => ({
  m: null as any,
  scope: null as any,
  access: null as any,
  // The associate's carry on the served fund's books, and each member's points.
  carry: 0,
  paid: 0,
  points: {} as Record<string, number>,
  html: [] as string[],
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => s.m.admin }))
vi.mock('@/lib/api-helpers', async (orig) => ({ ...(await orig<any>()), assertReadAccess: async () => ({ fundId: 'home', userId: 'u', role: 'member' }) }))
vi.mock('@/lib/oauth/enabled', () => ({ agentApiEnabled: async () => true }))
vi.mock('@/lib/rate-limit', () => ({ rateLimit: async () => null }))
vi.mock('@/lib/access/effective', async (orig) => ({ ...(await orig<any>()), loadAccessContext: async () => s.access }))
vi.mock('@/lib/access/entity-scope', async (orig) => ({ ...(await orig<any>()), loadEntityScope: async () => s.scope, entityScopeFor: async () => s.scope }))
vi.mock('@/lib/access/carry-visibility', async (orig) => ({ ...(await orig<any>()), carryRecipientIds: async () => new Set(['assoc-home', 'assoc-other']) }))
vi.mock('@/lib/accounting/lp-positions', async (orig) => ({ ...(await orig<any>()), lastDataDates: async (_d: unknown, _f: string, g: string[]) => new Map(g.map(x => [x, '2026-06-30'])) }))
vi.mock('@/lib/accounting/load', async (orig) => ({
  ...(await orig<any>()),
  listVehicles: async () => ['Fund I', 'GP LLC'],
  loadOwnership: async () => [],
}))
vi.mock('@/lib/accounting/gp-links', async (orig) => ({
  ...(await orig<any>()),
  loadVehicleGpLinks: async (_d: unknown, fundId: string) => [{ gpVehicleId: `gp-${fundId}`, servedVehicleId: `fund-${fundId}`, lpEntityId: `assoc-${fundId}` }],
}))
vi.mock('@/lib/accounting/terms', async (orig) => ({
  ...(await orig<any>()),
  loadCommitmentEvents: async () => [],
  loadPartnerTerms: async (_d: unknown, fundId: string) => Object.entries(s.points).filter(([id]) => id.endsWith(`-${fundId}`))
    .map(([id, weight]) => ({ lpEntityId: id, category: 'carried_interest', participates: true, weightOverride: weight })),
}))
const fundPostings = (fundId: string) => [
  { lpEntityId: `assoc-${fundId}`, amount: -1000, sourceType: 'contribution', entryDate: '2025-01-01' },
  { lpEntityId: `assoc-${fundId}`, amount: -200.01, sourceType: 'valuation', entryDate: '2025-06-30' },
  { lpEntityId: `assoc-${fundId}`, amount: -s.carry, sourceType: 'carried_interest', entryDate: '2025-12-31' },
  { lpEntityId: `assoc-${fundId}`, amount: s.paid, sourceType: 'carry_distribution', entryDate: '2026-03-31' },
]
vi.mock('@/lib/accounting/capital-source', async (orig) => ({
  ...(await orig<any>()),
  loadCapitalPostings: async (_d: unknown, fundId: string, group: string) => ({ source: 'ledger', postings: group === 'Fund I' ? fundPostings(fundId) : [], receivableByLp: new Map(), commitmentByLp: new Map() }),
}))
vi.mock('@/lib/accounting/reporting-capital', () => ({
  loadReportingCapital: async (_d: unknown, fundId: string, group: string) => group === 'Fund I'
    ? { source: 'ledger', postings: fundPostings(fundId), receivableByLp: new Map(), commitmentByLp: new Map([[`assoc-${fundId}`, 2000]]), evidenceByLp: new Map() }
    // The associate's own books: who owns it. `carry-only` committed nothing.
    : { source: 'ledger', postings: [], receivableByLp: new Map(), commitmentByLp: new Map([[`big-${fundId}`, 75], [`small-${fundId}`, 25]]), evidenceByLp: new Map() },
}))
vi.mock('puppeteer-core', () => ({
  default: {
    launch: async () => ({
      newPage: async () => ({
        setJavaScriptEnabled: async () => {},
        setContent: async (html: string) => { s.html.push(html) },
        pdf: async () => Buffer.from('%PDF'),
      }),
      close: async () => {},
    }),
  },
}))
vi.mock('@/lib/vehicle-letterhead', () => ({ documentLetterhead: async () => ({ name: 'Home Fund', logo: null }), contactBlock: () => null }))

import { GET as cards } from '@/app/api/lps/live-cards/route'
import { GET as report } from '@/app/api/agent/reports/[token]/route'
import { signReportLink } from '@/lib/agent/report-links'

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-key-for-report-links'
// puppeteer is mocked above, so no browser is launched; getChromeConfig still looks for one on disk
// and throws on a host without Chrome. Any existing file satisfies it.
process.env.CHROME_EXECUTABLE_PATH = process.execPath

const access = (gp: 'none' | 'read') => ({
  fundId: 'home', userId: 'u', role: 'member', vehicles: { all: true, ids: [] }, defaults: {},
  features: Object.fromEntries(Object.keys(DEFAULT_FEATURE_VISIBILITY).map(k => [k, 'everyone'])),
  grants: { lp_capital: 'read', gp_economics: gp },
})
const as = (gp: 'none' | 'read') => {
  s.access = access(gp)
  s.scope = { access: s.access, vehicleNames: null, companyIds: null }
}

const seed = () => {
  const fund = (id: string, name: string, inv: string) => ({
    fund: { id, name },
    vehicles: [
      { id: `fund-${id}`, fund_id: id, name: 'Fund I', kind: 'fund', active: true, aliases: null },
      { id: `gp-${id}`, fund_id: id, name: 'GP LLC', kind: 'associate', active: true, aliases: null },
    ],
    entities: [
      { id: `assoc-${id}`, fund_id: id, entity_name: 'GP LLC', investor_id: `assoc-inv-${id}` },
      { id: `big-${id}`, fund_id: id, entity_name: 'Big Member', investor_id: inv },
      { id: `small-${id}`, fund_id: id, entity_name: 'Small Member', investor_id: `small-inv-${id}` },
      { id: `carry-only-${id}`, fund_id: id, entity_name: 'Carry Only Member', investor_id: `carry-only-inv-${id}` },
    ],
  })
  const home = fund('home', 'Home Fund', 'inv-big')
  const other = fund('other', 'Other Fund', 'their-big')
  s.m = memoryAdmin({
    funds: [home.fund, other.fund],
    fund_settings: [{ fund_id: 'home', currency: 'USD' }, { fund_id: 'other', currency: 'USD' }],
    fund_vehicles: [...home.vehicles, ...other.vehicles],
    lp_entities: [...home.entities, ...other.entities],
    lp_investors: [{ id: 'inv-big', fund_id: 'home', name: 'Big Member' }],
    fund_members: [{ fund_id: 'home', user_id: 'u', role: 'member' }],
    fund_connections: [{ id: 'c1', requester_fund_id: 'home', recipient_fund_id: 'other', status: 'active' }],
    lp_investor_links: [{ id: 'l1', connection_id: 'c1', requester_investor_id: 'inv-big', recipient_investor_id: 'their-big', requester_approved_at: '2026-01-01', recipient_approved_at: '2026-01-01', approved: true }],
  })
}

const NO_CARRY = { carry: 0, paid: 0, points: { 'big-home': 1, 'small-home': 3, 'carry-only-home': 1, 'big-other': 1, 'small-other': 3, 'carry-only-other': 1 } }
const CARRY = { carry: 300, paid: 40, points: NO_CARRY.points }
// Every point on a different member: a share computed from them would move.
const OTHER_POINTS = { carry: 900, paid: 0, points: { 'big-home': 7, 'small-home': 1, 'carry-only-home': 5, 'big-other': 7, 'small-other': 1, 'carry-only-other': 5 } }

const cardsBody = async (books: typeof CARRY) => {
  Object.assign(s, books)
  return (await cards(new NextRequest('http://localhost/api/lps/live-cards'))).json()
}
const rowsOf = (body: any) => body.investors.flatMap((i: any) => i.rows)
const big = (body: any, group = 'Fund I') => rowsOf(body).find((r: any) => r.entityName === 'Big Member' && r.portfolioGroup === group)

const pdfHtml = async (books: typeof CARRY) => {
  Object.assign(s, books)
  s.html = []
  const { token } = signReportLink({ fundId: 'home', userId: 'u', kind: 'lp_report_card', args: { investor: 'inv-big' } })
  const res = await report(new NextRequest(`https://fund.test/api/agent/reports/${token}`), { params: Promise.resolve({ token }) })
  expect(res.status).toBe(200)
  expect(s.html).toHaveLength(1)
  return s.html[0]
}

beforeEach(seed)

describe('look-through members on the live cards', () => {
  it('with gp_economics: the share of the carry is there, so the rest of this file proves something', async () => {
    as('read')
    // Capital 1200.01 by ownership: 900.01 (75%). Carry net of what was paid, 260, by points: 52 (1 of 5).
    expect(big(await cardsBody(CARRY)).nav).toBeCloseTo(900.01 + 52, 2)
    expect((await cardsBody(CARRY)).excludedNotes).toEqual([])
  })

  it('without it: home and connected rows hold the member\'s capital and none of the carry', async () => {
    as('none')
    const body = await cardsBody(CARRY)
    expect(big(body).nav).toBeCloseTo(900.01, 2)
    expect(big(body, 'Other Fund: Fund I').nav).toBeCloseTo(900.01, 2)
  })

  it('every figure on the row is built on the same carry-free capital: no field gives the carry back by subtraction', async () => {
    as('none')
    for (const r of [big(await cardsBody(CARRY)), big(await cardsBody(CARRY), 'Other Fund: Fund I')]) {
      expect(r.paidInCapital).toBe(750)
      expect(r.totalValue).toBeCloseTo(r.nav + r.distributions, 2)
      expect(r.rvpi).toBeCloseTo(r.nav / r.paidInCapital, 3)
      expect(r.tvpi).toBeCloseTo(r.totalValue / r.paidInCapital, 3)
      expect(r.irr).toBeNull()
    }
  })

  it('the whole response is the same whatever the carry and whoever holds the points', async () => {
    as('none')
    const none = await cardsBody(NO_CARRY)
    expect(await cardsBody(CARRY)).toEqual(none)
    expect(await cardsBody(OTHER_POINTS)).toEqual(none)
  })

  it('and the members\' rows still add up to the associate\'s capital, with nothing left over to subtract', async () => {
    as('none')
    const home = rowsOf(await cardsBody(CARRY)).filter((r: any) => r.portfolioGroup === 'Fund I')
    expect(home.reduce((n: number, r: any) => n + r.nav, 0)).toBeCloseTo(1200.01, 2)
  })

  it('a member holding only carry points has no row: an empty one would name them as a carry participant', async () => {
    as('none')
    expect(rowsOf(await cardsBody(CARRY)).map((r: any) => r.entityName)).not.toContain('Carry Only Member')
    as('read')
    expect(rowsOf(await cardsBody(CARRY)).map((r: any) => r.entityName)).toContain('Carry Only Member')
  })

  it('says so on the card, for every member alike, so the figure is not read as the whole position', async () => {
    as('none')
    const notes = (await cardsBody(CARRY)).excludedNotes
    expect(notes).toContainEqual({ investorId: 'inv-big', label: 'Carried interest on positions held via GP LLC' })
    expect(notes).toContainEqual({ investorId: 'inv-big', label: 'Carried interest on positions held via Other Fund: GP LLC' })
    expect(notes).toContainEqual({ investorId: 'small-inv-home', label: 'Carried interest on positions held via GP LLC' })
  })

  it('a member with no carry points gets the same row as one with them', async () => {
    as('none')
    const withPoints = await cardsBody(CARRY)
    const without = await cardsBody({ ...CARRY, points: { ...CARRY.points, 'big-home': 0, 'big-other': 0 } })
    expect(without).toEqual(withPoints)
  })
})

describe('look-through members on the investor report PDF', () => {
  it('with gp_economics: the share of the carry is in the report', async () => {
    as('read')
    expect(await pdfHtml(CARRY)).not.toEqual(await pdfHtml(NO_CARRY))
  })

  it('without it: the document is the same whatever the carry and whoever holds the points, totals included', async () => {
    as('none')
    const none = await pdfHtml(NO_CARRY)
    expect(await pdfHtml(CARRY)).toEqual(none)
    expect(await pdfHtml(OTHER_POINTS)).toEqual(none)
  })

  it('shows the capital, home and connected, and says the carry is left out', async () => {
    as('none')
    const html = await pdfHtml(CARRY)
    expect(html).toContain('900')
    expect(html).toContain('Other Fund: Fund I')
    expect(html).toContain('Carried interest on positions held via GP LLC')
    expect(html).toContain('Carried interest on positions held via Other Fund: GP LLC')
    expect(html).not.toContain('Carry Only Member')
  })
})
