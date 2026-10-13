import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import type { AccessContext, AccessLevel } from '@/lib/access/effective'
import type { Domain } from '@/lib/access/domains'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureVisibilityMap } from '@/lib/types/features'
import { memoryAdmin } from './helpers/memory-admin'

/**
 * The fund's own documents from chat: fund performance, the financial statements, the tax package,
 * a K-1, an investor's snapshot report. The tool validates and signs; the link re-checks, at the
 * click, exactly what the document's web route checks.
 */

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-key-for-report-links'

let access: AccessContext
const store = memoryAdmin()
const seed = () => {
  store.tables.fund_members = [{ fund_id: 'fund-1', user_id: 'user-me', role: 'member' }]
  store.tables.fund_vehicles = [
    { id: 'v1', fund_id: 'fund-1', name: 'Fund I', active: true, kind: 'fund', aliases: null },
    { id: 'v2', fund_id: 'fund-1', name: 'Fund II', active: true, kind: 'fund', aliases: null },
  ]
  store.tables.k1_packages = [
    { id: 'pk-1', fund_id: 'fund-1', vehicle_id: 'v1', tax_year: 2025, version: 1, status: 'final' },
    { id: 'pk-2', fund_id: 'fund-1', vehicle_id: 'v1', tax_year: 2025, version: 2, status: 'draft' },
  ]
  store.tables.k1_partners = [{ fund_id: 'fund-1', package_id: 'pk-2', lp_entity_id: 'ent-1' }]
  store.tables.lp_entities = [
    { id: 'ent-1', fund_id: 'fund-1', entity_name: 'Acme LP', investor_id: 'inv-1', lp_investors: { id: 'inv-1', name: 'Acme' } },
    { id: 'ent-2', fund_id: 'fund-1', entity_name: 'Acme Trust', investor_id: 'inv-1', lp_investors: { id: 'inv-1', name: 'Acme' } },
  ]
  store.tables.lp_investors = [{ id: 'inv-1', fund_id: 'fund-1', name: 'Acme' }]
  store.tables.lp_snapshots = [{ id: 'snap-1', fund_id: 'fund-1', name: 'Q2 2026', as_of_date: '2026-06-30', created_at: '2026-07-10' }]
  store.tables.lp_investments = [{ id: 'li-1', fund_id: 'fund-1', snapshot_id: 'snap-1', entity_id: 'ent-2' }]
}

const doc = (contentType = 'application/pdf') => ({ body: Buffer.from('%PDF'), fileName: 'doc.pdf', contentType })
const docs = {
  fundPerformanceDocument: vi.fn(async () => doc()),
  financialStatementsDocument: vi.fn(async () => doc()),
  taxPackageDocument: vi.fn(async () => ({ ...doc('application/zip'), fileName: 'tax.zip' })),
  k1Document: vi.fn(async () => doc()),
}
const snapshotPdf = vi.fn(async () => ({ pdf: Buffer.from('%PDF-snap'), fileName: 'Acme - Q2 2026.pdf' }))

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => store.admin }))
vi.mock('@/lib/oauth/enabled', () => ({ agentApiEnabled: async () => true }))
vi.mock('@/lib/rate-limit', () => ({ rateLimit: async () => null }))
vi.mock('@/lib/access/effective', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/access/effective')>()),
  loadAccessContext: async () => access,
}))
vi.mock('@/lib/access/entity-scope', () => ({
  entityScopeFor: async (_: unknown, a: AccessContext) => ({ access: a, vehicleNames: a.vehicles.all ? null : ['Fund I'], companyIds: null }),
}))
vi.mock('@/lib/access/lp-scope', () => ({
  visibleLpEntityIds: async (_: unknown, scope: { vehicleNames: string[] | null }) => (scope.vehicleNames === null ? null : ['ent-1']),
  scopeLiveReport: (r: unknown) => r,
}))
vi.mock('@/lib/reports/documents', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/reports/documents')>()),
  fundPerformanceDocument: (...a: unknown[]) => (docs.fundPerformanceDocument as any)(...a),
  financialStatementsDocument: (...a: unknown[]) => (docs.financialStatementsDocument as any)(...a),
  taxPackageDocument: (...a: unknown[]) => (docs.taxPackageDocument as any)(...a),
  k1Document: (...a: unknown[]) => (docs.k1Document as any)(...a),
}))
vi.mock('@/lib/lp-report-pdf', () => ({
  generateInvestorReportPdf: (...a: unknown[]) => (snapshotPdf as any)(...a),
  generateLiveInvestorReportPdf: async () => null,
  renderHtmlToPdf: async () => Buffer.from('%PDF'),
}))

import { GET } from '@/app/api/agent/reports/[token]/route'
import { REPORT_HANDLERS } from '@/lib/agent/report-tools'
import { verifyReportLink } from '@/lib/agent/report-links'
import { getTool } from '@/lib/accounting/agent-tools'

const member = (grants: Partial<Record<Domain, AccessLevel>>, all = true): AccessContext => ({
  fundId: 'fund-1', userId: 'user-me', vehicles: { all, ids: all ? [] : ['v1'] }, role: 'member',
  features: Object.fromEntries(Object.keys(DEFAULT_FEATURE_VISIBILITY).map(k => [k, 'everyone'])) as FeatureVisibilityMap,
  grants, defaults: {},
})
const ctx = () => ({ admin: store.admin, fundId: 'fund-1', portfolioGroup: '', userId: 'user-me', access, origin: 'https://fund.test' }) as any
const tokenOf = (out: any) => String(out.url).split('/').pop()!
const open = (token: string) => GET(new NextRequest(`https://fund.test/api/agent/reports/${token}`), { params: Promise.resolve({ token }) })

beforeEach(() => {
  seed()
  access = member({ accounting: 'read' })
  vi.clearAllMocks()
})

describe('document tools', () => {
  it('are reads gated like their web routes', () => {
    expect(getTool('fund_performance_pdf')).toMatchObject({ scope: 'read', accessDomain: 'accounting' })
    expect(getTool('financial_statements_pdf')).toMatchObject({ scope: 'read', accessDomain: 'accounting' })
    expect(getTool('tax_package_zip')).toMatchObject({ scope: 'read', accessDomain: 'accounting' })
    expect(getTool('schedule_k_pdf')).toMatchObject({ scope: 'read', accessDomain: 'tax', accessFeature: 'tax_reporting' })
    expect(getTool('lp_snapshot_pdf')).toMatchObject({ scope: 'read', domain: 'lp', accessFeature: 'lp_portal' })
  })

  it('signs fund performance as of a fixed date, and opens it', async () => {
    const out = await REPORT_HANDLERS.fund_performance_pdf(ctx(), { vehicle: 'Fund I', as_of: '2026-06-30' }) as any
    expect(verifyReportLink(tokenOf(out))).toMatchObject({ kind: 'fund_performance', args: { vehicle: 'Fund I', as_of: '2026-06-30', group_by: 'month' } })
    const res = await open(tokenOf(out))
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toContain('no-store')
    expect(docs.fundPerformanceDocument).toHaveBeenCalledWith(store.admin, 'fund-1', 'Fund I', '2026-06-30', 'month')
  })

  it('resolves the statements period when the link is made', async () => {
    const out = await REPORT_HANDLERS.financial_statements_pdf(ctx(), { vehicle: 'Fund I', start: '2026-01-01', end: '2026-06-30', compare: 1, basis: 'tax' }) as any
    expect((await open(tokenOf(out))).status).toBe(200)
    const sp = (docs.financialStatementsDocument.mock.calls[0] as any)[3] as URLSearchParams
    expect(Object.fromEntries(sp)).toEqual({ start: '2026-01-01', end: '2026-06-30', compare: '1', basis: 'tax' })
    await expect(REPORT_HANDLERS.financial_statements_pdf(ctx(), { vehicle: 'Fund I', period: 'forever' })).rejects.toThrow('period must be one of')
  })

  it('hands over the tax package as a download, with the K-1 workbook only for someone who may see K-1s', async () => {
    const out = await REPORT_HANDLERS.tax_package_zip(ctx(), { vehicle: 'Fund I', year: 2025 }) as any
    expect(out.k1_workbook).toMatch(/left out/)
    const res = await open(tokenOf(out))
    expect(res.headers.get('content-type')).toBe('application/zip')
    expect(res.headers.get('content-disposition')).toMatch(/^attachment/)
    expect(docs.taxPackageDocument).toHaveBeenLastCalledWith(store.admin, 'fund-1', 'Fund I', 2025, { includeK1: false })
    access = member({ accounting: 'read', lp_capital: 'read', gp_economics: 'read' })
    await open(tokenOf(out))
    expect(docs.taxPackageDocument).toHaveBeenLastCalledWith(store.admin, 'fund-1', 'Fund I', 2025, { includeK1: true })
  })

  it('stops opening when the member loses the grant, or the entity', async () => {
    const out = await REPORT_HANDLERS.fund_performance_pdf(ctx(), { vehicle: 'Fund II' }) as any
    access = member({})
    expect((await open(tokenOf(out))).status).toBe(404)
    access = member({ accounting: 'read' }, false)
    expect((await open(tokenOf(out))).status).toBe(404)
    expect(docs.fundPerformanceDocument).not.toHaveBeenCalled()
  })

  it('refuses a vehicle outside a scoped member\'s entities in the conversation', async () => {
    access = member({ accounting: 'read' }, false)
    await expect(REPORT_HANDLERS.financial_statements_pdf(ctx(), { vehicle: 'Fund II' })).rejects.toThrow()
  })

  it('gives a K-1 only with GP economics, from the latest package, for a partner in it', async () => {
    access = member({ tax: 'read', accounting: 'read' })
    await expect(REPORT_HANDLERS.schedule_k_pdf(ctx(), { vehicle: 'Fund I', lp: 'Acme LP', tax_year: 2025 })).rejects.toThrow('GP economics')
    access = member({ tax: 'read', accounting: 'read', gp_economics: 'read' })
    const out = await REPORT_HANDLERS.schedule_k_pdf(ctx(), { vehicle: 'Fund I', lp: 'Acme LP', tax_year: 2025 }) as any
    expect(out.package).toEqual({ version: 2, status: 'draft' })
    expect((await open(tokenOf(out))).status).toBe(200)
    expect(docs.k1Document).toHaveBeenCalledWith(store.admin, 'fund-1', 'pk-2', 'ent-1')
    await expect(REPORT_HANDLERS.schedule_k_pdf(ctx(), { vehicle: 'Fund I', lp: 'Acme Trust', tax_year: 2025 })).rejects.toThrow('not a partner')
    // Losing the carry grant voids the link.
    access = member({ tax: 'read', accounting: 'read' })
    expect((await open(tokenOf(out))).status).toBe(404)
  })

  it('gives an investor\'s snapshot report only to someone who sees every entity', async () => {
    access = member({ lp_capital: 'read' }, false)
    await expect(REPORT_HANDLERS.lp_snapshot_pdf(ctx(), { investor: 'Acme' })).rejects.toThrow('every entity')
    access = member({ lp_capital: 'read' })
    const out = await REPORT_HANDLERS.lp_snapshot_pdf(ctx(), { investor: 'Acme LP' }) as any
    expect(out).toMatchObject({ investor: 'Acme', snapshot: 'Q2 2026' })
    expect((await open(tokenOf(out))).status).toBe(200)
    expect(snapshotPdf).toHaveBeenCalledWith(store.admin, { fundId: 'fund-1', snapshotId: 'snap-1', investorIds: ['inv-1'] })
    access = member({ lp_capital: 'read' }, false)
    expect((await open(tokenOf(out))).status).toBe(404)
  })

  it('needs a signed-in member', async () => {
    await expect(REPORT_HANDLERS.fund_performance_pdf({ ...ctx(), userId: null }, {})).rejects.toThrow('signed-in member')
  })
})
