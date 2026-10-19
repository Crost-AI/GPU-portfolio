import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

// ── GPU fleet (P3 PR B) ── The fleet company and KPI publication (plan §3 PR B, acceptance 7).
vi.mock('@/lib/activity', () => ({ logActivity: vi.fn() }))

import { createCompany } from '@/lib/companies/create'
import { ensureFleetCompany, GPU_METRIC_TEMPLATES } from './fleet-company'
import { publishFleetKpis } from './metrics-publish'

let m: ReturnType<typeof memoryAdmin>
const earning = (id: string, asset_id: string, over: object = {}) => ({
  id, fund_id: 'f', vehicle_id: 'v-gpu', asset_id, asset_ref: asset_id, period_start: '2026-09-01', period_end: '2026-09-30',
  gpu_hours_rented: 4320, utilization_pct: 75, gross: 8640, marketplace_fee: 864, net: 7776, downtime_hours: 0, status: 'posted', supersedes_id: null, ...over,
})

beforeEach(() => {
  m = memoryAdmin({
    fund_vehicles: [
      { id: 'v-gpu', fund_id: 'f', name: 'GPU I', kind: 'gpu_spv', aliases: [] },
      { id: 'v-fund', fund_id: 'f', name: 'Fund I', kind: 'fund', aliases: [] },
    ],
    gpu_asset_types: [{ id: 't-1', fund_id: 'f', code: 'h200' }],
    gpu_assets: [1, 2, 3].map(n => ({ id: `a-${n}`, fund_id: 'f', vehicle_id: 'v-gpu', asset_type_id: 't-1', name: `H200 #${n}`, gpu_count: 8, in_service_date: '2026-01-01', disposed_on: null })),
    gpu_earnings: [
      earning('e-1', 'a-1'), earning('e-2', 'a-2'), earning('e-3', 'a-3'),
      // Entered, not posted: never published.
      earning('e-4', 'a-1', { status: 'staged', supersedes_id: 'e-1', gross: 99_999, net: 99_135 }),
    ],
    gpu_import_runs: [{ id: 'run-7', fund_id: 'f', vehicle_id: 'v-gpu', created_at: '2026-10-02T00:00:00Z' }],
    companies: [{ id: 'vc', fund_id: 'f', name: 'Acme', holding_type: 'company', portfolio_group: ['Fund I'] }],
    default_metrics: [{ id: 'dm-mrr', fund_id: 'f', name: 'MRR', slug: 'mrr', is_active: true, display_order: 0, holding_type: 'company' }],
    metrics: [], metric_values: [], default_metric_exclusions: [],
  }, {
    unique: [
      { table: 'default_metrics', key: r => `${r.fund_id}|${r.slug}` },
      { table: 'metrics', key: r => `${r.company_id}|${r.slug}` },
    ],
  })
})

const fleet = () => m.tables.companies.find((c: any) => c.holding_type === 'gpu_fleet')
const slugsOf = (companyId: string) => m.tables.metrics.filter((x: any) => x.company_id === companyId).map((x: any) => x.slug).sort()
const valueOf = (companyId: string, slug: string) => {
  const metric = m.tables.metrics.find((x: any) => x.company_id === companyId && x.slug === slug)
  return m.tables.metric_values.filter((v: any) => v.metric_id === metric?.id)
}

describe('ensureFleetCompany', () => {
  it('creates one "Fleet — <vehicle>" gpu_fleet company on the vehicle, seeded with the gpu-* metrics only; idempotent', async () => {
    const id = await ensureFleetCompany(m.admin, 'f', 'GPU I', 'u')
    expect(fleet()).toMatchObject({ id, name: 'Fleet — GPU I', holding_type: 'gpu_fleet', portfolio_group: ['GPU I'], status: 'active' })
    expect(slugsOf(id)).toEqual(GPU_METRIC_TEMPLATES.map(t => t.slug).sort())
    expect(m.tables.default_metrics.filter((d: any) => d.holding_type === 'gpu_fleet')).toHaveLength(GPU_METRIC_TEMPLATES.length)
    expect(m.tables.default_metrics.every((d: any) => d.holding_type === 'gpu_fleet' ? d.reporting_cadence === 'monthly' : true)).toBe(true)

    expect(await ensureFleetCompany(m.admin, 'f', 'GPU I', 'u')).toBe(id)
    expect(m.tables.companies.filter((c: any) => c.holding_type === 'gpu_fleet')).toHaveLength(1)
    expect(slugsOf(id)).toHaveLength(GPU_METRIC_TEMPLATES.length)
  })

  it('a VC company created afterwards in the same fund gets no gpu-* metric', async () => {
    await ensureFleetCompany(m.admin, 'f', 'GPU I', 'u')
    const created = await createCompany(m.admin, { fundId: 'f', userId: 'u', vehicleNames: null, fields: { name: 'Beta', portfolio_group: ['Fund I'] } })
    if (!created.ok) throw new Error(created.error)
    expect(slugsOf(created.company.id)).toEqual(['mrr'])
  })
})

describe('publishFleetKpis', () => {
  it('writes the month’s posted KPIs onto the fleet company only, with per-type variants', async () => {
    const r = await publishFleetKpis(m.admin, 'f', 'GPU I', '2026-09', 'u')
    if ('error' in r) throw new Error(r.error)
    expect(r.companyId).toBe(fleet()!.id)
    expect(r.written).toMatchObject({
      'gpu-utilization': 75, 'gpu-realized-rate': 2, 'gpu-revenue': 25_920, 'gpu-fee': 2592, 'gpu-net': 23_328,
      'gpu-hours-rented': 12_960, 'gpu-count': 24, 'gpu-uptime': 100, 'gpu-downtime-hours': 0,
      'gpu-utilization--h200': 75, 'gpu-realized-rate--h200': 2,
    })
    expect(valueOf(r.companyId, 'gpu-revenue')).toEqual([expect.objectContaining({
      company_id: r.companyId, fund_id: 'f', period_label: '2026-09', period_year: 2026, period_quarter: 3, period_month: 9,
      value_number: 25_920, is_manually_entered: false, confidence: 'high', notes: 'Computed from GPU operations entries (run run-7)',
    })])
    expect(slugsOf(r.companyId)).toContain('gpu-utilization--h200')
    // The VC company in the same fund: no gpu-* metric, no value.
    expect(slugsOf('vc')).toEqual([])
    expect(m.tables.metric_values.filter((v: any) => v.company_id === 'vc')).toEqual([])
  })

  it('re-publishing a month overwrites its values instead of adding rows', async () => {
    await publishFleetKpis(m.admin, 'f', 'GPU I', '2026-09', 'u')
    m.tables.gpu_earnings.find((e: any) => e.id === 'e-1')!.gross = 9000
    const r = await publishFleetKpis(m.admin, 'f', 'GPU I', '2026-09', 'u')
    if ('error' in r) throw new Error(r.error)
    expect(valueOf(r.companyId, 'gpu-revenue')).toEqual([expect.objectContaining({ value_number: 26_280 })])
  })

  it('refuses a vehicle that is not a GPU SPV and a malformed month', async () => {
    expect(await publishFleetKpis(m.admin, 'f', 'Fund I', '2026-09', 'u')).toEqual({ error: 'Vehicle not found' })
    expect(await publishFleetKpis(m.admin, 'f', 'GPU I', '2026-9', 'u')).toEqual({ error: 'month must be YYYY-MM' })
    expect(fleet()).toBeUndefined()
  })
})
