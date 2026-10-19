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

  // Through checkReadiness, not only the helper: which finding is a blocker and which a warning.
  it('a posted row whose revenue does not tie to 4000 is a blocker; 1150 drift is a warning', async () => {
    m.tables.gpu_earnings.push(row({ id: 'e-1', status: 'posted', journal_entry_id: 'je-1' }))
    m.tables.journal_entries.push(
      { id: 'je-1', fund_id: 'f', vehicle_id: 'v-gpu', book: 'actual', status: 'posted', entry_date: '2026-09-30' },
      { id: 'je-2', fund_id: 'f', vehicle_id: 'v-gpu', book: 'actual', status: 'posted', entry_date: '2026-09-15' },
    )
    const post = (journal_entry_id: string, code: string, amount: number) => ({ journal_entry_id, fund_id: 'f', vehicle_id: 'v-gpu', book: 'actual', account_id: `acc-${code}`, amount, currency: 'USD' })
    // The subledger's own entry, and 50 of revenue booked to 4000 by hand.
    m.tables.journal_postings.push(post('je-1', '1150', 90), post('je-1', '5150', 10), post('je-1', '4000', -100), post('je-2', '1150', 50), post('je-2', '4000', -50))
    const r = await checkReadiness(m.admin, 'f', 'GPU I', '2026-09-01', '2026-09-30')
    expect(r.blockers).toContainEqual(expect.stringMatching(/^GPU revenue does not tie: posted operations entries total 100\.00 gross, but 4000 Rental revenue shows 150\.00/))
    expect(r.warnings).toContainEqual(expect.stringMatching(/^1150 Marketplace receivable is 140\.00 at 2026-09-30, but posted net revenue less matched payouts is 90\.00 \(difference 50\.00\)/))
    expect(r.blockers.join(' ')).not.toMatch(/1150/)
    expect(r.warnings.join(' ')).not.toMatch(/does not tie/)
  })

  it('an unmatched row is a blocker, not a warning; a staged row a warning, not a blocker', async () => {
    m.tables.gpu_earnings.push(row({ id: 'e-1', asset_id: null, asset_ref: 'Ghost', status: 'unmatched' }), row({ id: 'e-2' }))
    const r = await checkReadiness(m.admin, 'f', 'GPU I', '2026-09-01', '2026-09-30')
    expect(r.blockers.filter(b => /GPU operations/.test(b))).toEqual(['1 GPU operations row in this span matches no server. Correct the asset name and enter it again, or ignore the row, on the Revenue page.'])
    expect(r.warnings.filter(w => /GPU operations/.test(w))).toEqual(['1 GPU operations row is entered but not posted in this span: that revenue is not in the books yet.'])
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
