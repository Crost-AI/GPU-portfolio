import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { memoryAdmin } from '@/tests/helpers/memory-admin'
import { DEFAULT_FEATURE_VISIBILITY } from '@/lib/types/features'

/**
 * ── GPU fleet (P1) ── Tax fails closed for a GPU SPV until K-1 character understands its chart (#68).
 *
 * The K-1 loaders read the fund chart's codes, so a GPU SPV's rental revenue (4000), disposal gain
 * (4500) and several expenses would be missing from an issued package. Every tax route that names a
 * vehicle — by `group`, or by the K-1 package it names — refuses a GPU SPV with a 409 BEFORE any tax
 * work runs, and still serves a fund. The downstream tax functions are mocked to throw SERVED, so
 * "refused" means the work was never reached and "served" means it was.
 */

const s = vi.hoisted(() => ({ m: null as any }))
const SERVED = 'SERVED'
const served = vi.hoisted(() => () => vi.fn(async () => { throw new Error('SERVED') }))

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => s.m.admin }))
vi.mock('@/lib/api-helpers', () => ({
  assertReadAccess: async () => ({ fundId: 'f', userId: 'u', role: 'admin' }),
  assertWriteAccess: async () => ({ fundId: 'f', userId: 'u', role: 'admin' }),
}))
vi.mock('@/lib/access/effective', async orig => ({
  ...(await orig<any>()),
  loadAccessContext: async () => ({
    fundId: 'f', userId: 'u', role: 'admin', grants: {}, defaults: {}, vehicles: { all: true, ids: [] },
    features: { ...DEFAULT_FEATURE_VISIBILITY, accounting: 'everyone', gp_economics: 'everyone', tax_reporting: 'everyone', lps: 'everyone' },
  }),
}))
vi.mock('@/lib/rate-limit', () => ({ rateLimit: async () => null, getClientIp: () => 'ip' }))
vi.mock('@/lib/audit/events', () => ({ recordAudit: vi.fn() }))
vi.mock('@/lib/accounting/http-vehicle', () => ({ resolveGroupOr400: async (_a: any, _g: any, raw: string) => raw }))
vi.mock('@/lib/accounting/book-tax-run', () => ({ postTaxAdjustments: served() }))
vi.mock('@/lib/tax/k1-package', () => ({ generateK1Package: served(), amendK1Package: served(), finalizeK1Package: served() }))
vi.mock('@/lib/tax/k1-export', () => ({ buildK1WorkbookForPackage: served() }))
vi.mock('@/lib/reports/documents', () => ({ k1Document: served() }))
vi.mock('@/lib/tax/year-close', () => ({ taxYearState: served(), closeTaxYear: served(), reopenTaxYear: served(), loadK1Dependencies: served() }))

import * as taxAdjustments from '@/app/api/accounting/tax-adjustments/route'
import * as k1Packages from '@/app/api/accounting/k1-packages/route'
import * as k1Export from '@/app/api/accounting/k1-packages/export/route'
import * as k1Pdf from '@/app/api/accounting/k1-packages/pdf/route'
import * as k1Deliveries from '@/app/api/accounting/k1-deliveries/route'
import * as stateWorklist from '@/app/api/accounting/state-worklist/route'
import * as taxYear from '@/app/api/accounting/tax-year/route'
import * as receivedK1s from '@/app/api/accounting/received-k1s/route'
import { refuseGpuSpvTax } from '@/lib/accounting/vehicle-domain'

const VEHICLE = { fund: 'Fund II', gpu: 'H200 SPV I' } as const
const PACKAGE = { fund: 'p-fund', gpu: 'p-gpu' } as const
type Side = keyof typeof VEHICLE

beforeEach(() => {
  s.m = memoryAdmin({
    fund_vehicles: [
      { id: 'v-fund', fund_id: 'f', name: VEHICLE.fund, kind: 'fund', aliases: [] },
      { id: 'v-gpu', fund_id: 'f', name: VEHICLE.gpu, kind: 'gpu_spv', aliases: [] },
    ],
    k1_packages: [
      { id: PACKAGE.fund, fund_id: 'f', vehicle_id: 'v-fund', tax_year: 2026, version: 1, status: 'draft' },
      { id: PACKAGE.gpu, fund_id: 'f', vehicle_id: 'v-gpu', tax_year: 2026, version: 1, status: 'draft' },
    ],
    k1_partners: [], k1_lines: [], k1_deliveries: [], lp_tax_forms: [], lp_entities: [], received_k1s: [],
    companies: [{ id: 'c1', fund_id: 'f', holding_type: 'fund' }],
  })
})

const get = (route: string, q: string) => new NextRequest(`https://x.test/api/accounting/${route}?${q}`)
const post = (route: string, body: object) =>
  new NextRequest(`https://x.test/api/accounting/${route}`, { method: 'POST', body: JSON.stringify(body) })

const CALLS: [string, (side: Side) => Promise<Response>][] = [
  ['GET tax-adjustments', side => taxAdjustments.GET(get('tax-adjustments', `group=${VEHICLE[side]}&taxYear=2026`))],
  ['POST tax-adjustments', side => taxAdjustments.POST(post('tax-adjustments', { group: VEHICLE[side], taxYear: 2026 }))],
  ['GET k1-packages?packageId', side => k1Packages.GET(get('k1-packages', `packageId=${PACKAGE[side]}`))],
  ['POST k1-packages (generate)', side => k1Packages.POST(post('k1-packages', { group: VEHICLE[side], taxYear: 2026 }))],
  ['POST k1-packages (finalize)', side => k1Packages.POST(post('k1-packages', { action: 'finalize', packageId: PACKAGE[side] }))],
  ['GET k1-packages/export', side => k1Export.GET(get('k1-packages/export', `packageId=${PACKAGE[side]}`))],
  ['GET k1-packages/pdf', side => k1Pdf.GET(get('k1-packages/pdf', `packageId=${PACKAGE[side]}&lpEntityId=e1`))],
  ['GET k1-deliveries', side => k1Deliveries.GET(get('k1-deliveries', `packageId=${PACKAGE[side]}`))],
  ['GET state-worklist', side => stateWorklist.GET(get('state-worklist', `packageId=${PACKAGE[side]}`))],
  ['GET tax-year', side => taxYear.GET(get('tax-year', `group=${VEHICLE[side]}&taxYear=2026`))],
  ['POST tax-year', side => taxYear.POST(post('tax-year', { group: VEHICLE[side], taxYear: 2026, action: 'close' }))],
  ['GET received-k1s', side => receivedK1s.GET(get('received-k1s', `group=${VEHICLE[side]}&taxYear=2026`))],
  ['POST received-k1s', side => receivedK1s.POST(post('received-k1s', { group: VEHICLE[side], companyId: 'c1', taxYear: 2026, status: 'expected' }))],
]

describe('tax routes refuse a GPU SPV and still serve a fund', () => {
  it.each(CALLS)('%s', async (_label, call) => {
    const refused = await call('gpu')
    expect(refused.status).toBe(409)
    expect((await refused.json()).error).toBe('Tax reporting is not yet supported for GPU SPVs')

    // The fund is served: either the tax work ran (a mocked function threw SERVED) or the handler
    // answered from the database, with anything but the GPU refusal.
    const fund = await call('fund').then(r => r, (e: Error) => e)
    if (fund instanceof Error) expect(fund.message).toBe(SERVED)
    else expect(fund.status).not.toBe(409)
  })
})

describe('refuseGpuSpvTax', () => {
  it('resolves by name or by package; a legacy name, another fund or no reference passes', async () => {
    expect((await refuseGpuSpvTax(s.m.admin, 'f', { group: VEHICLE.gpu }))?.status).toBe(409)
    expect(await refuseGpuSpvTax(s.m.admin, 'f', { group: VEHICLE.fund })).toBeNull()
    expect(await refuseGpuSpvTax(s.m.admin, 'f', { group: 'Legacy Fund' })).toBeNull()
    expect((await refuseGpuSpvTax(s.m.admin, 'f', { packageId: PACKAGE.gpu }))?.status).toBe(409)
    expect(await refuseGpuSpvTax(s.m.admin, 'f', { packageId: PACKAGE.fund })).toBeNull()
    expect(await refuseGpuSpvTax(s.m.admin, 'other-fund', { packageId: PACKAGE.gpu })).toBeNull()
    expect(await refuseGpuSpvTax(s.m.admin, 'f', {})).toBeNull()
  })

  it('is called by every vehicle-scoped tax handler; the per-partner ones name no vehicle', () => {
    // tax-forms (W-9/W-8 per partner) and the k1-deliveries POST (a partner's e-delivery consent)
    // are fund-wide, about a person rather than an entity, so there is no vehicle to refuse.
    const calls = (route: string) =>
      (readFileSync(path.join(process.cwd(), 'app/api/accounting', route, 'route.ts'), 'utf8').match(/refuseGpuSpvTax\(/g) ?? []).length
    expect({
      'tax-adjustments': calls('tax-adjustments'), 'k1-packages': calls('k1-packages'),
      'k1-packages/export': calls('k1-packages/export'), 'k1-packages/pdf': calls('k1-packages/pdf'),
      'k1-deliveries': calls('k1-deliveries'), 'state-worklist': calls('state-worklist'),
      'tax-year': calls('tax-year'), 'received-k1s': calls('received-k1s'), 'tax-forms': calls('tax-forms'),
    }).toEqual({
      'tax-adjustments': 2, 'k1-packages': 3, 'k1-packages/export': 1, 'k1-packages/pdf': 1,
      'k1-deliveries': 1, 'state-worklist': 1, 'tax-year': 2, 'received-k1s': 2, 'tax-forms': 0,
    })
  })
})
