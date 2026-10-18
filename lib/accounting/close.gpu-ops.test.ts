import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

// ── GPU fleet (P3) ── checkReadiness runs the operations subledger checks for a GPU SPV only.
vi.mock('@/lib/gpu/ops/close-checks', async orig => {
  const real = await orig<any>()
  return { ...real, gpuOpsCloseIssues: vi.fn(real.gpuOpsCloseIssues) }
})

import { checkReadiness } from './close'
import { gpuOpsCloseIssues } from '@/lib/gpu/ops/close-checks'
import { GPU_SPV_CHART } from './chart'

let m: ReturnType<typeof memoryAdmin>
const row = (over: object) => ({ fund_id: 'f', vehicle_id: 'v-gpu', asset_id: 'a-1', asset_ref: 'H200 #1', period_start: '2026-09-01', period_end: '2026-09-30', gross: 100, marketplace_fee: 10, net: 90, status: 'staged', ...over })

beforeEach(() => {
  vi.mocked(gpuOpsCloseIssues).mockClear()
  m = memoryAdmin({
    fund_vehicles: [
      { id: 'v-gpu', fund_id: 'f', name: 'GPU I', kind: 'gpu_spv', aliases: [] },
      { id: 'v-fund', fund_id: 'f', name: 'Fund I', kind: 'fund', aliases: [] },
    ],
    chart_of_accounts: GPU_SPV_CHART.map(a => ({ id: `acc-${a.code}`, fund_id: 'f', vehicle_id: 'v-gpu', code: a.code, name: a.name, type: a.type, subtype: a.subtype ?? null })),
    journal_entries: [], journal_postings: [], bank_transactions: [], gpu_earnings: [], gpu_payouts: [],
    crypto_wallets: [], price_feeds: [], investment_transactions: [], companies: [], fund_settings: [],
  })
})

describe('checkReadiness: GPU operations', () => {
  it('blocks on an unmatched row and warns on a staged one, for a GPU SPV', async () => {
    m.tables.gpu_earnings.push(row({ id: 'e-1', asset_id: null, asset_ref: 'Ghost', status: 'unmatched' }), row({ id: 'e-2' }))
    const r = await checkReadiness(m.admin, 'f', 'GPU I', '2026-09-01', '2026-09-30')
    expect(gpuOpsCloseIssues).toHaveBeenCalledWith(m.admin, 'f', 'GPU I', 'v-gpu', '2026-09-01', '2026-09-30')
    expect(r.blockers).toContainEqual(expect.stringMatching(/GPU operations row in this span matches no server/))
    expect(r.warnings).toContainEqual(expect.stringMatching(/entered but not posted/))
  })

  it('turns a failed read into a blocker', async () => {
    m.failNext('gpu_earnings', 'select', 'timeout')
    const r = await checkReadiness(m.admin, 'f', 'GPU I', '2026-09-01', '2026-09-30')
    expect(r.blockers).toContainEqual('The GPU operations entries could not be checked: timeout. Try again before closing.')
  })

  it('leaves a fund vehicle’s review as it was: the check never runs', async () => {
    // A stray row on the fund's id would block a GPU SPV; the fund never looks.
    m.tables.gpu_earnings.push(row({ id: 'e-1', vehicle_id: 'v-fund', asset_id: null, status: 'unmatched' }))
    const r = await checkReadiness(m.admin, 'f', 'Fund I', '2026-09-01', '2026-09-30')
    expect(gpuOpsCloseIssues).not.toHaveBeenCalled()
    expect(r.blockers.join(' ')).not.toMatch(/GPU/)
    expect(r.warnings.join(' ')).not.toMatch(/GPU|1150/)
  })
})
