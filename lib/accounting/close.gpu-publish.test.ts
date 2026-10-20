import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

// ── GPU fleet (P3 PR B) ── closeThrough publishes each month it closed to a GPU SPV's fleet
// company, best effort; any other vehicle's close is untouched and never publishes.
const s = vi.hoisted(() => ({ fail: false }))
vi.mock('@/lib/gpu/metrics-publish', () => ({
  publishFleetKpis: vi.fn(async (_a: unknown, _f: string, _g: string, month: string) => {
    if (s.fail) throw new Error('publish exploded')
    return { companyId: 'fleet', month, written: {} }
  }),
}))
vi.mock('@/lib/audit/events', () => ({ recordAudit: vi.fn(async () => undefined) }))

import { closeThrough } from './close'
import { publishFleetKpis } from '@/lib/gpu/metrics-publish'
import { DEFAULT_CHART, GPU_SPV_CHART } from './chart'

let m: ReturnType<typeof memoryAdmin>
function seed(kind: 'fund' | 'gpu_spv') {
  const name = kind === 'fund' ? 'Fund I' : 'GPU I'
  const chart = (kind === 'fund' ? DEFAULT_CHART : GPU_SPV_CHART).map(a => ({ id: `acc-${a.code}`, fund_id: 'f', vehicle_id: 'v', portfolio_group: name, code: a.code, name: a.name, type: a.type, subtype: a.subtype ?? null, lp_entity_id: null, company_id: null }))
  const entry = (id: string, date: string) => ({ id, fund_id: 'f', vehicle_id: 'v', portfolio_group: name, book: 'actual', status: 'posted', entry_date: date, source_type: 'manual', memo: 'x' })
  const post = (id: string, code: string, amount: number) => ({ journal_entry_id: id, fund_id: 'f', vehicle_id: 'v', portfolio_group: name, book: 'actual', account_id: `acc-${code}`, amount, currency: 'USD', lp_entity_id: null })
  m = memoryAdmin({
    funds: [{ id: 'f', currency: 'USD' }], fund_settings: [{ fund_id: 'f' }],
    lp_investments: [{ id: 'li-1', fund_id: 'f', portfolio_group: name, entity_id: 'lp-a', commitment: 1000, paid_in_capital: 150, distributions: 0, snapshot_id: null, updated_at: '2026-01-01' }],
    lp_entities: [{ id: 'lp-a', fund_id: 'f', entity_name: 'Alpha LP' }],
    fund_vehicles: [{ id: 'v', fund_id: 'f', name, kind, aliases: [] }],
    chart_of_accounts: chart,
    journal_entries: [entry('je-1', '2026-08-10'), entry('je-2', '2026-09-10')],
    journal_postings: [post('je-1', '1000', 100), post('je-1', '3000', -100), post('je-2', '1000', 50), post('je-2', '3000', -50)],
  })
  return name
}

beforeEach(() => { vi.mocked(publishFleetKpis).mockClear(); s.fail = false })

describe('closeThrough and fleet KPI publication', () => {
  it('a fund vehicle: the close result is what it was, and nothing is published', async () => {
    const name = seed('fund')
    const r = await closeThrough(m.admin, 'f', name, 'u', '2026-09-30')
    expect(r).toMatchObject({ closed: [expect.objectContaining({ label: 'August 2026' }), expect.objectContaining({ label: 'September 2026' })] })
    expect(publishFleetKpis).not.toHaveBeenCalled()
  })

  it('a GPU SPV: each month that closed is published', async () => {
    const name = seed('gpu_spv')
    const r = await closeThrough(m.admin, 'f', name, 'u', '2026-09-30')
    expect(r).toMatchObject({ closed: [expect.anything(), expect.anything()] })
    expect(vi.mocked(publishFleetKpis).mock.calls.map(c => c[3])).toEqual(['2026-08', '2026-09'])
  })

  it('a publication that throws never fails the close', async () => {
    const name = seed('gpu_spv')
    s.fail = true
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await closeThrough(m.admin, 'f', name, 'u', '2026-09-30')).toMatchObject({ closed: [expect.anything(), expect.anything()] })
    } finally { err.mockRestore() }
  })
})
