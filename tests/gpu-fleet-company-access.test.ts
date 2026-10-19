import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { memoryAdmin } from '@/tests/helpers/memory-admin'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureVisibilityMap } from '@/lib/types/features'
import type { AccessContext } from '@/lib/access/effective'

// ── GPU fleet (P3) ── #91: a GPU SPV's fleet company and its metrics need `fleet` as well as
// `portfolio`. A member who reads the portfolio but not the fleet — or anyone, admins included,
// while gpu_fleet is off — gets "not found" on every route that returns a company's data; a VC
// company is served as before. The real effectiveAccess decides; only the context is stubbed.

const s = vi.hoisted(() => ({ m: null as any, ctx: null as any }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u' } } }) }, from: (t: string) => s.m.admin.from(t) }),
}))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => s.m.admin }))
vi.mock('@/lib/access/effective', async orig => ({ ...(await orig<any>()), loadAccessContext: async () => s.ctx }))

import { refuseFleetCompany, fleetCompanyDenied } from '@/lib/access/fleet-company'
import * as company from '@/app/api/companies/[id]/route'
import * as companyMetrics from '@/app/api/companies/[id]/metrics/route'
import * as metricValues from '@/app/api/companies/[id]/metrics/[metricId]/values/route'
import * as summary from '@/app/api/companies/[id]/summary/route'
import * as metric from '@/app/api/metrics/[id]/route'
import * as metricValue from '@/app/api/metric-values/[id]/route'

const ctx = (over: Partial<AccessContext>): AccessContext => ({
  fundId: 'f', userId: 'u', role: 'member', vehicles: { all: true, ids: [] },
  features: { ...DEFAULT_FEATURE_VISIBILITY, accounting: 'everyone', gpu_fleet: 'everyone' } as FeatureVisibilityMap,
  grants: { portfolio: 'write', accounting: 'write', fleet: 'none' }, defaults: {}, ...over,
})
const PORTFOLIO_NO_FLEET = () => ctx({})
const FLEET_READER = () => ctx({ grants: { portfolio: 'write', accounting: 'read', fleet: 'read' } })
const ADMIN_FLEET_OFF = () => ctx({ role: 'admin', features: { ...DEFAULT_FEATURE_VISIBILITY, accounting: 'everyone', gpu_fleet: 'off' } as FeatureVisibilityMap })

beforeEach(() => {
  s.ctx = PORTFOLIO_NO_FLEET()
  s.m = memoryAdmin({
    fund_members: [{ id: 'fm', fund_id: 'f', user_id: 'u', role: 'member' }],
    companies: [
      { id: 'fleet', fund_id: 'f', name: 'Fleet — GPU I', holding_type: 'gpu_fleet', portfolio_group: ['GPU I'] },
      { id: 'vc', fund_id: 'f', name: 'Acme', holding_type: 'company', portfolio_group: ['Fund I'] },
    ],
    metrics: [
      { id: 'm-fleet', fund_id: 'f', company_id: 'fleet', slug: 'gpu-revenue', name: 'Rental revenue', display_order: 0 },
      { id: 'm-vc', fund_id: 'f', company_id: 'vc', slug: 'mrr', name: 'MRR', display_order: 0 },
    ],
    metric_values: [
      { id: 'v-fleet', fund_id: 'f', company_id: 'fleet', metric_id: 'm-fleet', period_year: 2026, period_month: 9, value_number: 25_920 },
      { id: 'v-vc', fund_id: 'f', company_id: 'vc', metric_id: 'm-vc', period_year: 2026, period_month: 9, value_number: 10 },
    ],
    company_summaries: [], fund_vehicles: [], fund_member_vehicles: [],
  })
})

const req = (url: string, method = 'GET', body?: object) => new NextRequest(`http://localhost${url}`, body ? { method, body: JSON.stringify(body) } : { method })
const p = <T extends object>(v: T) => ({ params: Promise.resolve(v) })

type Call = [string, (id: 'fleet' | 'vc') => Promise<Response | undefined>]
const calls: Call[] = [
  ['GET company', id => company.GET(req(`/api/companies/${id}`), p({ id }))],
  ['PATCH company', id => company.PATCH(req(`/api/companies/${id}`, 'PATCH', { name: 'x' }), p({ id }))],
  ['DELETE company', id => company.DELETE(req(`/api/companies/${id}`, 'DELETE'), p({ id }))],
  ['GET company metrics', id => companyMetrics.GET(req(`/api/companies/${id}/metrics`), p({ id }))],
  ['POST company metrics', id => companyMetrics.POST(req(`/api/companies/${id}/metrics`, 'POST', { name: 'x', slug: 'x' }), p({ id }))],
  ['GET metric values', id => metricValues.GET(req(`/api/companies/${id}/metrics/m-${id}/values`), p({ id, metricId: `m-${id}` }))],
  ['POST metric values', id => metricValues.POST(req(`/api/companies/${id}/metrics/m-${id}/values`, 'POST', { value: 1 }), p({ id, metricId: `m-${id}` }))],
  ['GET summary', id => summary.GET(req(`/api/companies/${id}/summary`), p({ id }))],
  ['DELETE summary', id => summary.DELETE(req(`/api/companies/${id}/summary`, 'DELETE'), p({ id }))],
  ['POST summary', id => summary.POST(req(`/api/companies/${id}/summary`, 'POST', {}), p({ id }))],
  ['PUT summary', id => summary.PUT(req(`/api/companies/${id}/summary`, 'PUT', { summary: 'x' }), p({ id }))],
  ['PATCH metric', id => metric.PATCH(req(`/api/metrics/m-${id}`, 'PATCH', { name: 'x' }), p({ id: `m-${id}` }))],
  ['DELETE metric', id => metric.DELETE(req(`/api/metrics/m-${id}`, 'DELETE'), p({ id: `m-${id}` }))],
  ['PATCH metric value', id => metricValue.PATCH(req(`/api/metric-values/v-${id}`, 'PATCH', { value: 1 }), p({ id: `v-${id}` }))],
  ['DELETE metric value', id => metricValue.DELETE(req(`/api/metric-values/v-${id}`, 'DELETE'), p({ id: `v-${id}` }))],
]
const fleetRows = () => [s.m.tables.companies.length, s.m.tables.metrics.length, s.m.tables.metric_values.length]
const isFleet404 = async (res: Response | undefined) => !!res && res.status === 404 && (await res.clone().json()).error === 'Not found'

describe('a fleet company without fleet', () => {
  it.each(calls)('%s → 404, nothing changed', async (_, call) => {
    const before = fleetRows()
    expect(await isFleet404(await call('fleet'))).toBe(true)
    expect(fleetRows()).toEqual(before)
  })

  it.each(calls)('%s → 404 for an admin while gpu_fleet is off', async (_, call) => {
    s.ctx = ADMIN_FLEET_OFF()
    s.m.tables.fund_members[0].role = 'admin'
    expect(await isFleet404(await call('fleet'))).toBe(true)
  })
})

describe('the same routes, other callers and companies', () => {
  it.each(calls.filter(([n]) => n.startsWith('GET')))('%s on a VC company is not refused by the fleet rule', async (_, call) => {
    expect(await isFleet404(await call('vc'))).toBe(false)
  })

  it.each(calls.filter(([n]) => n.startsWith('GET')))('%s on the fleet company is served to a fleet reader', async (_, call) => {
    s.ctx = FLEET_READER()
    expect(await isFleet404(await call('fleet'))).toBe(false)
  })

  it('a fleet reader without fleet write is refused the writes', async () => {
    s.ctx = FLEET_READER()
    expect(await refuseFleetCompany(s.m.admin, 'u', { companyId: 'fleet' }, 'write')).not.toBeNull()
    expect(await refuseFleetCompany(s.m.admin, 'u', { metricId: 'm-fleet' }, 'read')).toBeNull()
  })
})

describe('refuseFleetCompany / fleetCompanyDenied', () => {
  it('a VC company costs one read and is never refused; an unknown id is left to the route', async () => {
    expect(await refuseFleetCompany(s.m.admin, 'u', { companyId: 'vc' }, 'write')).toBeNull()
    expect(await refuseFleetCompany(s.m.admin, 'u', { metricValueId: 'v-vc' })).toBeNull()
    expect(await refuseFleetCompany(s.m.admin, 'u', { companyId: 'nope' })).toBeNull()
    expect(await refuseFleetCompany(s.m.admin, 'u', { metricValueId: 'v-fleet' })).not.toBeNull()
  })

  it('a non-member of the fleet company’s fund is refused', async () => {
    s.m.tables.fund_members = []
    expect((await refuseFleetCompany(s.m.admin, 'u', { companyId: 'fleet' }))?.status).toBe(404)
  })

  it('the page rule: hidden without fleet read, shown with it, and never for other kinds', () => {
    expect(fleetCompanyDenied(PORTFOLIO_NO_FLEET(), 'gpu_fleet')).toBe(true)
    expect(fleetCompanyDenied(ADMIN_FLEET_OFF(), 'gpu_fleet')).toBe(true)
    expect(fleetCompanyDenied(FLEET_READER(), 'gpu_fleet')).toBe(false)
    expect(fleetCompanyDenied(PORTFOLIO_NO_FLEET(), 'company')).toBe(false)
    expect(fleetCompanyDenied(PORTFOLIO_NO_FLEET(), null)).toBe(false)
  })
})
