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

  // Review r2 (#90): an in-flight or abandoned claim is not invisible to the close.
  it('a row being posted with no entry yet, a row being reversed, and a payout being matched are blockers', async () => {
    m.tables.gpu_earnings.push(
      row({ id: 'e-1', status: 'posting', claim_token: 't', claimed_at: new Date().toISOString() }),
      row({ id: 'e-2', asset_id: 'a-2', asset_ref: 'H200 #2', status: 'reversing', journal_entry_id: null }),
    )
    m.tables.gpu_payouts.push({ id: 'p-1', fund_id: 'f', vehicle_id: 'v-gpu', payout_date: '2026-09-28', amount: 90, reference: 'PO-1', status: 'matching' })
    const r = await checkReadiness(m.admin, 'f', 'GPU I', '2026-09-01', '2026-09-30')
    expect(r.blockers).toEqual(expect.arrayContaining([
      'GPU revenue for H200 #1 2026-09-01..2026-09-30 is being posted: post again, or wait for the claim to expire, before closing.',
      'GPU revenue for H200 #2 2026-09-01..2026-09-30 is being reversed: post again, or wait for the claim to expire, before closing.',
      'The marketplace payout of 90.00 on 2026-09-28 (PO-1) is being matched: match again, or wait for the claim to expire, before closing.',
    ]))
  })

  // Review r3: the residual race is loud; a stuck draft is named; a payout blocks the month of its inflow.
  it('a posted entry reversed twice is a blocker', async () => {
    m.tables.gpu_earnings.push(row({ id: 'e-old', status: 'reversed', journal_entry_id: 'je-1' }))
    m.tables.journal_entries.push(
      { id: 'r-1', fund_id: 'f', vehicle_id: 'v-gpu', book: 'actual', status: 'posted', entry_date: '2026-09-30', source_ref: 'reversal:je-1' },
      { id: 'r-2', fund_id: 'f', vehicle_id: 'v-gpu', book: 'actual', status: 'posted', entry_date: '2026-09-30', source_ref: 'reversal:je-1' },
      { id: 'r-3', fund_id: 'f', vehicle_id: 'v-gpu', book: 'actual', status: 'void', entry_date: '2026-09-30', source_ref: 'reversal:je-1' },
    )
    const r = await checkReadiness(m.admin, 'f', 'GPU I', '2026-09-01', '2026-09-30')
    expect(r.blockers).toContainEqual('GPU revenue entry je-1 is reversed 2 times (entries r-1, r-2). Void all but one before closing.')
  })

  it('a claim that left a draft names it in the blocker', async () => {
    m.tables.gpu_earnings.push(row({ id: 'e-1', status: 'posting', claim_token: 't', claimed_at: '2026-09-01T00:00:00Z' }))
    m.tables.journal_entries.push({ id: 'je-left', fund_id: 'f', vehicle_id: 'v-gpu', book: 'actual', status: 'draft', entry_date: '2026-09-30', source_ref: 'marketplace:e-1' })
    const r = await checkReadiness(m.admin, 'f', 'GPU I', '2026-09-01', '2026-09-30')
    expect(r.blockers).toContainEqual('GPU revenue for H200 #1 2026-09-01..2026-09-30 is being posted: void draft je-left or post it, then post again, before closing.')
  })

  it('G4: a payout dated 10-01 being matched to a 09-28 inflow blocks September', async () => {
    m.tables.bank_transactions.push({ id: 't-1', fund_id: 'f', vehicle_id: 'v-gpu', txn_date: '2026-09-28', amount: 90, status: 'reconciled' })
    m.tables.gpu_payouts.push({ id: 'p-1', fund_id: 'f', vehicle_id: 'v-gpu', payout_date: '2026-10-01', amount: 90, reference: null, status: 'matching', bank_transaction_id: 't-1' })
    const sept = await checkReadiness(m.admin, 'f', 'GPU I', '2026-09-01', '2026-09-30')
    expect(sept.blockers).toContainEqual(expect.stringMatching(/^The marketplace payout of 90\.00 on 2026-10-01 is being matched/))
    const aug = await checkReadiness(m.admin, 'f', 'GPU I', '2026-08-01', '2026-08-31')
    expect(aug.blockers.join(' ')).not.toMatch(/being matched/)
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
