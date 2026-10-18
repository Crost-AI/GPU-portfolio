import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

// The routes PR B adds or widens for a GPU SPV's distributable-cash waterfall.

const s = vi.hoisted(() => ({ m: null as any, postings: [] as any[], mancoWrite: true, sees: ['v1', 'mc', 'v2'] as string[] }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => s.m.admin }))
vi.mock('@/lib/api-helpers', async orig => ({ ...(await orig<any>()), assertWriteAccess: async () => ({ fundId: 'f', userId: 'u', role: 'admin' }), assertReadAccess: async () => ({ fundId: 'f', userId: 'u', role: 'admin' }) }))
vi.mock('@/lib/accounting/http-vehicle', () => ({
  resolveGroupOr400: async () => 'GPU I',
  resolveGroupWithAccess: async () => ({ group: 'GPU I', access: { vehicles: { all: false, ids: s.sees } } }),
}))
vi.mock('@/lib/accounting/vehicle-id', () => ({ vehicleIdByName: async () => 'v1' }))
vi.mock('@/lib/accounting/capital-source', () => ({ loadCapitalPostings: async () => ({ postings: s.postings }) }))
// The caller's grants: accounting write always (the route's gate); management_company write and the
// vehicles it can see vary per test.
vi.mock('@/lib/access/effective', async orig => ({
  ...(await orig<any>()),
  loadAccessContext: async () => ({ vehicles: { all: false, ids: s.sees } }),
  hasAccess: (_ctx: unknown, domain: string, need: string) => domain !== 'management_company' || need !== 'write' || s.mancoWrite,
}))
vi.mock('@/lib/accounting/load', async orig => ({ ...(await orig<any>()), loadEntityNames: async () => new Map([['a', 'Alpha LP'], ['b', 'Beta LP']]) }))

import { PUT as putTerms } from '@/app/api/accounting/waterfall-terms/route'
import { GET as getFee, PUT as putFee } from '@/app/api/accounting/fee-terms/route'
import { GET as getLedger } from '@/app/api/accounting/pref-ledger/route'
import { POST as postDistribution } from '@/app/api/accounting/distributions/route'

const req = (url: string, method = 'GET', body?: object) =>
  new NextRequest(`http://localhost${url}`, body ? { method, body: JSON.stringify(body) } : { method })
const cashRow = { fund_id: 'f', vehicle_id: 'v1', kind: 'distributable_cash', carry_rate: 0.3, pref_rate: 0.08, catchup_rate: 1, pref_compounds: false, gp_entity_id: 'mgr', pref_basis: 'unreturned', pref_day_count: '30_360', roc_lp_share: 1 }

beforeEach(() => {
  s.postings = []
  s.mancoWrite = true
  s.sees = ['v1', 'mc', 'v2']
  s.m = memoryAdmin({
    fund_vehicles: [
      { id: 'v1', fund_id: 'f', name: 'GPU I', kind: 'gpu_spv' },
      { id: 'mc', fund_id: 'f', name: 'ManCo', kind: 'manco' },
      { id: 'v2', fund_id: 'f', name: 'Fund I', kind: 'fund' },
      { id: 'other', fund_id: 'g', name: 'Elsewhere', kind: 'manco' },
    ],
    lp_entities: [{ id: 'mgr', fund_id: 'f', entity_name: 'Manager' }],
    vehicle_waterfall_terms: [],
    vehicle_fee_terms: [],
  })
})

describe('PUT /api/accounting/waterfall-terms: distributable_cash', () => {
  const put = (body: object) => putTerms(req('/api/accounting/waterfall-terms', 'PUT', { group: 'GPU I', kind: 'distributable_cash', carryRate: 0.3, prefRate: 0.08, carryRecipients: [{ lpEntityId: 'mgr', pct: 100 }], ...body }))

  it('stores the kind with pref on unreturned capital, simple, no catch-up, 30E/360 by default', async () => {
    const res = await put({})
    expect(res.status).toBe(200)
    expect(s.m.tables.vehicle_waterfall_terms[0]).toMatchObject({
      kind: 'distributable_cash', carry_rate: 0.3, pref_rate: 0.08, pref_basis: 'unreturned', pref_day_count: '30_360', roc_lp_share: 1, catchup_rate: 1, pref_compounds: false,
    })
  })

  it('accepts act_365 and a ROC share below 1', async () => {
    expect((await put({ prefDayCount: 'act_365', rocLpShare: 0.9 })).status).toBe(200)
    expect(s.m.tables.vehicle_waterfall_terms[0]).toMatchObject({ pref_day_count: 'act_365', roc_lp_share: 0.9 })
  })

  it.each<[string, object, RegExp]>([
    ['the periodic day count', { prefDayCount: 'periodic' }, /periodic/],
    ['a catch-up other than 1', { catchupRate: 0.5 }, /catch-up/],
    ['a compounding pref', { prefCompounds: true }, /compound/],
    ['a pref basis other than unreturned', { prefBasis: 'contributed' }, /unreturned/],
    ['a zero carry rate', { carryRate: 0 }, /profit share/],
    ['a ROC share above 1', { rocLpShare: 1.5 }, /return of capital/],
  ])('refuses %s', async (_, body, message) => {
    const res = await put(body)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(message)
    expect(s.m.tables.vehicle_waterfall_terms).toEqual([])
  })

  it('leaves the fund kinds as they were: no distributable-cash columns written', async () => {
    const res = await putTerms(req('/api/accounting/waterfall-terms', 'PUT', { group: 'GPU I', kind: 'european', carryRate: 0.2, prefRate: 0.08, catchupRate: 1, carryRecipients: [{ lpEntityId: 'mgr', pct: 100 }] }))
    expect(res.status).toBe(200)
    const row = s.m.tables.vehicle_waterfall_terms[0]
    for (const k of ['pref_basis', 'pref_day_count', 'roc_lp_share']) expect(row).not.toHaveProperty(k)
    expect(row.pref_compounds).toBe(true)
  })
})

describe('/api/accounting/fee-terms', () => {
  const put = (body: object) => putFee(req('/api/accounting/fee-terms', 'PUT', { group: 'GPU I', basis: 'gross_revenue', annualRate: 0.05, effectiveFrom: '2027-01-01', ...body }))

  it('GET is null before terms exist, and returns them after a PUT', async () => {
    expect(await (await getFee(req('/api/accounting/fee-terms?group=GPU%20I'))).json()).toEqual({ group: 'GPU I', terms: null })
    expect((await put({ payeeVehicleId: 'mc' })).status).toBe(200)
    expect((await (await getFee(req('/api/accounting/fee-terms?group=GPU%20I'))).json()).terms).toEqual({
      basis: 'gross_revenue', annualRate: 0.05, revenueSubtypes: ['rental_revenue'], frequency: 'monthly', payeeVehicleId: 'mc', effectiveFrom: '2027-01-01', effectiveTo: null,
    })
  })

  it('naming a payee needs management_company write and sight of it: 403 otherwise, nothing written', async () => {
    s.mancoWrite = false
    const denied = await put({ payeeVehicleId: 'mc' })
    expect(denied.status).toBe(403)
    expect((await denied.json()).error).toMatch(/management company/)
    s.mancoWrite = true
    s.sees = ['v1']
    expect((await put({ payeeVehicleId: 'mc' })).status).toBe(403)
    expect(s.m.tables.vehicle_fee_terms).toEqual([])
    // Another fund's vehicle is not one the caller can see: refused before its kind is even read.
    expect((await put({ payeeVehicleId: 'other' })).status).toBe(403)
    s.sees = ['v1', 'mc']
    expect((await put({ payeeVehicleId: 'mc' })).status).toBe(200)
  })

  it('without a payee, accounting write alone is enough', async () => {
    s.mancoWrite = false
    expect((await put({})).status).toBe(200)
    expect(s.m.tables.vehicle_fee_terms[0]).toMatchObject({ payee_vehicle_id: null, annual_rate: 0.05 })
  })

  it.each<[string, object, RegExp]>([
    ['a payee that is not a management company', { payeeVehicleId: 'v2' }, /management company/],
    ['the vehicle itself as payee', { payeeVehicleId: 'v1' }, /itself/],
    ['an unknown basis', { basis: 'profit' }, /basis/],
    ['a rate of 1', { annualRate: 1 }, /rate/],
    ['no effective date', { effectiveFrom: undefined }, /effectiveFrom/],
    ['an end before the start', { effectiveTo: '2026-12-31' }, /effectiveTo/],
    ['an annual frequency', { frequency: 'annual' }, /frequency/],
  ])('refuses %s', async (_, body, message) => {
    const res = await put(body)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(message)
    expect(s.m.tables.vehicle_fee_terms).toEqual([])
  })
})

describe('GET /api/accounting/pref-ledger', () => {
  it('replays the capital postings into ledger rows, with investor names', async () => {
    s.m.tables.vehicle_waterfall_terms.push(cashRow)
    s.postings = [
      { lpEntityId: 'a', amount: -1_000_000, sourceType: 'capital_call', entryDate: '2027-01-01' },
      { lpEntityId: 'b', amount: -435_500, sourceType: 'capital_call', entryDate: '2027-01-01' },
      { lpEntityId: 'a', amount: 34_831.1, sourceType: 'distribution', entryDate: '2028-01-01' },
      { lpEntityId: 'b', amount: 15_168.9, sourceType: 'distribution', entryDate: '2028-01-01' },
    ]
    const res = await getLedger(req('/api/accounting/pref-ledger?group=GPU%20I'))
    expect(res.status).toBe(200)
    const rows = await res.json()
    const y1 = rows.find((r: any) => r.periodEnd === '2028-01-01')
    expect(y1).toMatchObject({ unreturnedStart: 1_435_500, broughtForward: 0, accrued: 114_840, paid: 50_000, carriedForward: 64_840 })
    expect(y1.perInvestor.map((i: any) => i.name)).toEqual(['Alpha LP', 'Beta LP'])
    expect(y1.perInvestor.reduce((t: number, i: any) => t + Math.round(i.carriedForward * 100), 0)).toBe(6_484_000)
  })

  it('replays a declared contingency return the way the preview does, so the two agree', async () => {
    s.m.tables.vehicle_waterfall_terms.push(cashRow)
    s.m.tables.distributions = [{ id: 'd0', fund_id: 'f', vehicle_id: 'v1', status: 'declared', distribution_date: '2027-01-02', wf_contingency_return: 130_500 }]
    s.postings = [
      { lpEntityId: 'a', amount: -1_435_500, sourceType: 'capital_call', entryDate: '2027-01-01' },
      { lpEntityId: 'a', amount: 130_500, sourceType: 'distribution', entryDate: '2027-01-02' },
    ]
    const preview = await (await postDistribution(req('/api/accounting/distributions', 'POST', { group: 'GPU I', action: 'preview', asOf: '2028-01-01', available: 700_000, reserve: 0 }))).json()
    // Book what the preview says, then read the ledger back.
    s.postings.push({ lpEntityId: 'a', amount: preview.tiers.toLP, sourceType: 'distribution', entryDate: '2028-01-01' })
    const rows = await (await getLedger(req('/api/accounting/pref-ledger?group=GPU%20I'))).json()
    const contingencyRow = rows.find((r: any) => r.periodEnd === '2027-01-02')
    expect(contingencyRow).toMatchObject({ paid: 0, unreturnedStart: 1_435_500 })
    const y1 = rows.find((r: any) => r.periodEnd === '2028-01-01')
    expect(y1.broughtForward + y1.accrued).toBeCloseTo(preview.cash.prefDue, 2)
    expect(y1).toMatchObject({ unreturnedStart: 1_305_000, paid: preview.tiers.preferred, carriedForward: preview.cash.prefCarriedForward })
    expect(y1.perInvestor[0].unreturnedEnd).toBe(preview.cash.unreturnedAfter)
  })

  it('is a 400 for a vehicle on other terms', async () => {
    s.m.tables.vehicle_waterfall_terms.push({ ...cashRow, kind: 'european' })
    expect((await getLedger(req('/api/accounting/pref-ledger?group=GPU%20I'))).status).toBe(400)
  })
})

describe('POST /api/accounting/distributions preview', () => {
  beforeEach(() => {
    s.m.tables.vehicle_waterfall_terms.push(cashRow)
    s.postings = [{ lpEntityId: 'a', amount: -1_435_500, sourceType: 'capital_call', entryDate: '2027-01-01' }]
  })
  const preview = (body: object) => postDistribution(req('/api/accounting/distributions', 'POST', { group: 'GPU I', action: 'preview', asOf: '2028-01-01', ...body }))

  it('takes available and reserve, and distributes the difference', async () => {
    const res = await preview({ available: 800_000, reserve: 33_492.44 })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ distributable: 766_507.56, tiers: { preferred: 114_840, returnOfCapital: 651_667.56 } })
  })

  it('is a 400 without a reserve, or with only a total', async () => {
    expect((await preview({ available: 800_000 })).status).toBe(400)
    const res = await preview({ total: 766_507.56 })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/available cash/)
  })
})
