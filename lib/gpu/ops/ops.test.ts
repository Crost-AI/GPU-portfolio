import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'
import type { JournalEntry } from '@/lib/accounting/types'

// The operations pipeline end to end over an in-memory ledger: stage (import) → post → correct a
// posted period → record and match a payout → the close checks. persistEntry stands in with its
// lifecycle (draft header, postings, flip to posted) and refuses a repeated live source_ref the way
// journal_entries_gpu_ops_once does; linkInflowToEntry posts the draft and reconciles the bank row.
const s = vi.hoisted(() => ({ m: null as any, persistError: null as string | null, during: null as null | (() => Promise<void>), afterLink: null as null | (() => void) }))
vi.mock('@/lib/accounting/persist', async orig => ({
  ...(await orig<any>()),
  persistEntry: vi.fn(async (_a: any, fundId: string, _g: string, _u: string, entry: JournalEntry, status: 'draft' | 'posted' = 'posted') => {
    if (s.persistError) return { error: s.persistError }
    const t = s.m.tables
    const dup = entry.sourceRef && t.journal_entries.find((e: any) => e.source_ref === entry.sourceRef && e.status !== 'void')
    if (dup) return { error: 'already in the books', duplicateOf: dup.id }
    const id = `je-${t.journal_entries.length + 1}`
    t.journal_entries.push({ id, fund_id: fundId, vehicle_id: 'v-gpu', book: 'actual', status, entry_date: entry.entryDate, source_type: entry.sourceType, source_ref: entry.sourceRef, memo: entry.memo, reference: entry.reference ?? null })
    for (const p of entry.postings) t.journal_postings.push({ id: `jp-${t.journal_postings.length + 1}`, journal_entry_id: id, fund_id: fundId, vehicle_id: 'v-gpu', book: 'actual', account_id: p.accountId, amount: p.amount, currency: 'USD', lp_entity_id: null })
    // A test can play a concurrent request while this one is booking.
    if (s.during) { const run = s.during; s.during = null; await run() }
    return { entryId: id }
  }),
}))
vi.mock('@/lib/accounting/bank-match', async orig => ({
  ...(await orig<any>()),
  linkInflowToEntry: vi.fn(async (_a: any, fundId: string, _g: string, txnId: string, entryId: string) => {
    const t = s.m.tables
    const e = t.journal_entries.find((x: any) => x.id === entryId && x.fund_id === fundId)
    if (e.status === 'draft') e.status = 'posted'
    Object.assign(t.bank_transactions.find((x: any) => x.id === txnId), { journal_entry_id: entryId, status: 'reconciled' })
    if (s.afterLink) { const run = s.afterLink; s.afterLink = null; run() }
    return { ok: true }
  }),
}))

import { GPU_SPV_CHART } from '@/lib/accounting/chart'
import { importEarnings } from './import'
import { ignoreEarnings, postEarnings } from './post'
import { listPayouts, matchPayout, receivableTieOut, recordPayout } from './payouts'
import { gpuOpsCloseIssues } from './close-checks'
import { autoMatchOpenCapital } from '@/lib/accounting/bank-auto-match-run'

const G = 'GPU I'
const acc = (code: string) => `acc-${code}`
const line = (asset: string, gross: number, fee: number, hours = 4320) => `${asset},2026-09-01,2026-09-30,${hours},,${gross},${fee},${gross - fee},0,`
// The QA fixture: three servers for September 2026 and one name the register does not know.
const FIXTURE = [line('H200 #1', 8640, 864), line('H200 #2', 8640, 864), line('H200 #3', 8640, 864), line('H100 #9', 200, 20, 100)].join('\n')

beforeEach(() => {
  s.persistError = null
  s.during = null
  s.afterLink = null
  s.m = memoryAdmin({
    fund_vehicles: [
      { id: 'v-gpu', fund_id: 'f', name: G, kind: 'gpu_spv', aliases: [] },
      { id: 'v-fund', fund_id: 'f', name: 'Fund I', kind: 'fund', aliases: [] },
    ],
    chart_of_accounts: GPU_SPV_CHART.map(a => ({ id: acc(a.code), fund_id: 'f', vehicle_id: 'v-gpu', portfolio_group: G, code: a.code, name: a.name, type: a.type, subtype: a.subtype ?? null })),
    gpu_assets: [1, 2, 3].map(n => ({ id: `a-${n}`, fund_id: 'f', vehicle_id: 'v-gpu', name: `H200 #${n}`, serials: [], gpu_count: 8, status: 'in_service', in_service_date: '2026-01-01', disposed_on: null })),
    gpu_import_runs: [], gpu_earnings: [], gpu_payouts: [], journal_entries: [], journal_postings: [], bank_transactions: [],
  }, {
    unique: [
      { table: 'gpu_earnings', key: r => (['ignored', 'reversed'].includes(r.status) ? null : `${r.fund_id}|${r.vehicle_id}|${r.dedup_hash}`) },
      { table: 'gpu_earnings', key: r => (r.status === 'staged' ? `staged|${r.asset_id}|${r.period_start}|${r.period_end}` : null) },
      { table: 'gpu_payouts', key: r => r.bank_transaction_id ?? null },
    ],
  })
})

const earnings = () => s.m.tables.gpu_earnings as any[]
const byAsset = (id: string | null, status?: string) => earnings().find(e => e.asset_id === id && (!status || e.status === status))
const legs = (entryId: string) => Object.fromEntries((s.m.tables.journal_postings as any[]).filter(p => p.journal_entry_id === entryId).map(p => [p.account_id, p.amount]))
const ids = (status: string) => earnings().filter(e => e.status === status).map(e => e.id)

async function stage(csv = FIXTURE) {
  const r = await importEarnings(s.m.admin, 'f', G, 'u', { csv, fileName: 'sept.csv' })
  if ('error' in r) throw new Error(r.error)
  return r
}

describe('importEarnings', () => {
  it('stages three rows and keeps the unknown server as unmatched; never posts', async () => {
    const r = await stage()
    expect(r).toMatchObject({ imported: 4, skipped: 0, matched: 3, needsReview: 0, errors: [] })
    expect(r.staged).toHaveLength(4)
    expect(ids('staged')).toHaveLength(3)
    expect(byAsset(null)).toMatchObject({ status: 'unmatched', asset_ref: 'H100 #9', gpu_hours_rented: 100, utilization_pct: null })
    expect(byAsset('a-1')).toMatchObject({ gpu_hours_rented: 4320, utilization_pct: 75, gross: 8640, marketplace_fee: 864, net: 7776, run_id: r.runId })
    expect(s.m.tables.gpu_import_runs).toEqual([expect.objectContaining({ id: r.runId, source: 'csv', file_name: 'sept.csv', rows_total: 4, rows_imported: 4, rows_unmatched: 1 })])
    expect(s.m.tables.journal_entries).toEqual([])
  })

  it('skips an identical paste with a reason per row, adding nothing', async () => {
    await stage()
    const again = await stage()
    expect(again).toMatchObject({ imported: 0, skipped: 4, staged: [] })
    expect(again.skippedRows).toEqual([
      'Row 1: H200 #1 2026-09-01..2026-09-30 is already entered (staged)',
      'Row 2: H200 #2 2026-09-01..2026-09-30 is already entered (staged)',
      'Row 3: H200 #3 2026-09-01..2026-09-30 is already entered (staged)',
      'Row 4: H100 #9 2026-09-01..2026-09-30 is already entered (unmatched)',
    ])
    expect(earnings()).toHaveLength(4)
  })

  it('updates a staged row in place when its figures change, rather than staging a second', async () => {
    await stage()
    const before = byAsset('a-2').id
    const r = await stage(line('H200 #2', 9000, 900))
    expect(r).toMatchObject({ imported: 1, skipped: 0, needsReview: 0 })
    expect(earnings()).toHaveLength(4)
    expect(byAsset('a-2')).toMatchObject({ id: before, status: 'staged', gross: 9000, net: 8100, run_id: r.runId })
  })

  it('reports parse and match errors alongside what it staged, and refuses a paste with nothing usable', async () => {
    const r = await stage(`${line('H200 #1', 8640, 864)}\nH200 #2,2026-09-01,2026-09-30,9999,,1`)
    expect(r.imported).toBe(1)
    expect(r.errors[0]).toMatch(/^Row 2: 9999 rented GPU-hours/)
    expect(await importEarnings(s.m.admin, 'f', G, 'u', { csv: 'A,2026-09-01,2026-09-30,,,1' })).toMatchObject({ error: expect.stringMatching(/^Row 1/) })
  })

  it('takes form rows by asset id', async () => {
    const r = await importEarnings(s.m.admin, 'f', G, 'u', { rows: [{ assetId: 'a-3', period_start: '2026-09-01', period_end: '2026-09-30', utilization_pct: 50, gross: 100 }] })
    expect(r).toMatchObject({ imported: 1, matched: 1 })
    expect(s.m.tables.gpu_import_runs[0].source).toBe('manual')
    expect(byAsset('a-3')).toMatchObject({ gpu_hours_rented: 2880, net: 100 })
  })

  it('refuses a vehicle that is not a GPU SPV', async () => {
    expect(await importEarnings(s.m.admin, 'f', 'Fund I', 'u', { csv: FIXTURE })).toEqual({ error: 'Vehicle not found' })
    expect(earnings()).toEqual([])
  })
})

describe('postEarnings', () => {
  it('books one balanced entry per row: Dr 1150 net / Dr 5150 fee / Cr 4000 gross, on the period end', async () => {
    await stage()
    const r = await postEarnings(s.m.admin, 'f', G, 'u', ids('staged'))
    if (!('reversed' in r)) throw new Error(JSON.stringify(r))
    expect(r.posted).toHaveLength(3)
    for (const p of r.posted) {
      expect(legs(p.entryId!)).toEqual({ [acc('1150')]: 7776, [acc('5150')]: 864, [acc('4000')]: -8640 })
      const e = s.m.tables.journal_entries.find((x: any) => x.id === p.entryId)
      expect(e).toMatchObject({ status: 'posted', entry_date: '2026-09-30', source_type: 'income', source_ref: `marketplace:${p.id}` })
      expect(e.memo).toMatch(/^GPU rental — H200 #\d — 2026-09-01\.\.2026-09-30$/)
      expect(earnings().find(x => x.id === p.id)).toMatchObject({ status: 'posted', journal_entry_id: p.entryId })
    }
  })

  it('refuses unmatched and ignored rows, posting nothing', async () => {
    await stage()
    const unmatched = byAsset(null).id
    expect(await postEarnings(s.m.admin, 'f', G, 'u', [...ids('staged'), unmatched])).toMatchObject({ error: expect.stringMatching(/H100 #9 .* is unmatched/) })
    await ignoreEarnings(s.m.admin, 'f', G, [byAsset('a-1').id])
    expect(await postEarnings(s.m.admin, 'f', G, 'u', [byAsset('a-1').id])).toMatchObject({ error: expect.stringMatching(/is ignored/) })
    expect(s.m.tables.journal_entries).toEqual([])
  })

  it('posting the same row twice books it once', async () => {
    await stage(line('H200 #1', 8640, 864))
    const id = ids('staged')[0]
    await postEarnings(s.m.admin, 'f', G, 'u', [id])
    expect(await postEarnings(s.m.admin, 'f', G, 'u', [id])).toMatchObject({ error: expect.stringMatching(/is posted/) })
    expect(s.m.tables.journal_entries).toHaveLength(1)
  })

  it('passes the period lock’s refusal through', async () => {
    await stage(line('H200 #1', 8640, 864))
    s.persistError = 'The period covering 2026-09-30 is closed — reopen it to post here'
    expect(await postEarnings(s.m.admin, 'f', G, 'u', ids('staged'))).toMatchObject({ error: expect.stringMatching(/closed/), posted: [] })
    expect(byAsset('a-1').status).toBe('staged')
  })

  it('a corrected posted period asks for the reversal, then reverses the old entry and books the new one', async () => {
    await stage(line('H200 #1', 8640, 864))
    await postEarnings(s.m.admin, 'f', G, 'u', ids('staged'))
    const old = byAsset('a-1', 'posted')

    const r = await stage(line('H200 #1', 9000, 900))
    expect(r).toMatchObject({ imported: 1, needsReview: 1 })
    const fix = byAsset('a-1', 'staged')
    expect(fix.supersedes_id).toBe(old.id)

    const asked = await postEarnings(s.m.admin, 'f', G, 'u', [fix.id])
    expect(asked).toEqual({ needsReversal: [{ id: fix.id, supersedesId: old.id, entryId: old.journal_entry_id, entryDate: '2026-09-30' }] })
    expect(s.m.tables.journal_entries).toHaveLength(1)

    const done = await postEarnings(s.m.admin, 'f', G, 'u', [fix.id], { confirmReversal: true })
    if (!('reversed' in done)) throw new Error(JSON.stringify(done))
    const reversal = s.m.tables.journal_entries.find((e: any) => e.source_ref === `reversal:${old.journal_entry_id}`)
    expect(done.reversed).toEqual([{ id: old.id, reversalId: reversal.id }])
    expect(legs(reversal.id)).toEqual({ [acc('1150')]: -7776, [acc('5150')]: -864, [acc('4000')]: 8640 })
    expect(legs(done.posted[0].entryId!)).toEqual({ [acc('1150')]: 8100, [acc('5150')]: 900, [acc('4000')]: -9000 })
    expect(s.m.tables.journal_entries.find((e: any) => e.id === old.journal_entry_id).reversed_by).toBe(reversal.id)
    expect(earnings().find(e => e.id === old.id).status).toBe('reversed')
    expect(earnings().find(e => e.id === fix.id).status).toBe('posted')
    expect(await gpuOpsCloseIssues(s.m.admin, 'f', G, 'v-gpu', '2026-09-01', '2026-09-30')).toEqual({ blockers: [], warnings: [] })
  })
})

describe('payouts', () => {
  async function postFixture() {
    await stage()
    await ignoreEarnings(s.m.admin, 'f', G, [byAsset(null).id])
    await postEarnings(s.m.admin, 'f', G, 'u', ids('staged'))
  }
  const inflow = (id: string, txn_date: string, amount: number) => ({ id, fund_id: 'f', vehicle_id: 'v-gpu', portfolio_group: G, txn_date, amount, description: 'Marketplace payout', status: 'drafted', journal_entry_id: null })

  it('offers same-amount inflows within 7 days, matches one (Dr 1000 / Cr 1150), reconciles it and clears 1150', async () => {
    await postFixture()
    const recorded = await recordPayout(s.m.admin, 'f', G, 'u', { date: '2026-10-01', amount: 23_328, reference: 'PO-9' })
    if ('error' in recorded) throw new Error(recorded.error)
    s.m.tables.bank_transactions.push(
      inflow('t-1', '2026-10-03', 23_328), inflow('t-2', '2026-10-20', 23_328), inflow('t-3', '2026-10-02', 23_000),
      // The 7-day window: day 7 either side is in, day 8 is out.
      inflow('t-in-late', '2026-10-08', 23_328), inflow('t-out-late', '2026-10-09', 23_328),
      inflow('t-in-early', '2026-09-24', 23_328), inflow('t-out-early', '2026-09-23', 23_328),
    )

    const list = await listPayouts(s.m.admin, 'f', G)
    if ('error' in list) throw new Error(list.error)
    expect(list[0].candidates.map(c => c.id).sort()).toEqual(['t-1', 't-in-early', 't-in-late'])
    expect(await receivableTieOut(s.m.admin, 'f', G, '2026-10-31')).toMatchObject({ ledger1150: 23_328, postedNet: 23_328, matchedPayouts: 0, difference: 0 })

    const matched = await matchPayout(s.m.admin, 'f', G, 'u', recorded.payout.id, 't-1')
    if ('error' in matched) throw new Error(matched.error)
    expect(legs(matched.entryId)).toEqual({ [acc('1000')]: 23_328, [acc('1150')]: -23_328 })
    expect(s.m.tables.journal_entries.find((e: any) => e.id === matched.entryId)).toMatchObject({ status: 'posted', entry_date: '2026-10-03', source_ref: `marketplace-payout:${recorded.payout.id}`, memo: 'Marketplace payout — PO-9' })
    expect(s.m.tables.bank_transactions[0]).toMatchObject({ status: 'reconciled', journal_entry_id: matched.entryId })
    expect(s.m.tables.gpu_payouts[0]).toMatchObject({ status: 'matched', bank_transaction_id: 't-1', journal_entry_id: matched.entryId })
    expect(await receivableTieOut(s.m.admin, 'f', G, '2026-10-31')).toMatchObject({ ledger1150: 0, postedNet: 23_328, matchedPayouts: 23_328, expected: 0, difference: 0 })
    // Before the payout landed, 1150 still held the revenue.
    expect(await receivableTieOut(s.m.admin, 'f', G, '2026-09-30')).toMatchObject({ ledger1150: 23_328, matchedPayouts: 0, difference: 0 })
  })

  it('refuses a match whose amount differs, or a payout already matched', async () => {
    await postFixture()
    const recorded = await recordPayout(s.m.admin, 'f', G, 'u', { date: '2026-10-01', amount: 23_328 })
    if ('error' in recorded) throw new Error(recorded.error)
    s.m.tables.bank_transactions.push(inflow('t-1', '2026-10-03', 23_328), inflow('t-3', '2026-10-02', 23_000))
    expect(await matchPayout(s.m.admin, 'f', G, 'u', recorded.payout.id, 't-3')).toMatchObject({ error: expect.stringMatching(/not the payout amount/) })
    await matchPayout(s.m.admin, 'f', G, 'u', recorded.payout.id, 't-1')
    expect(await matchPayout(s.m.admin, 'f', G, 'u', recorded.payout.id, 't-1')).toEqual({ error: 'This payout is already matched' })
    expect(s.m.tables.journal_entries.filter((e: any) => e.source_ref?.startsWith('marketplace-payout:'))).toHaveLength(1)
  })

  it('validates a recorded payout', async () => {
    expect(await recordPayout(s.m.admin, 'f', G, 'u', { date: '10/1/2026', amount: 1 })).toEqual({ error: 'date must be YYYY-MM-DD' })
    expect(await recordPayout(s.m.admin, 'f', G, 'u', { date: '2026-10-01', amount: 0 })).toEqual({ error: 'amount must be more than zero' })
    expect(await recordPayout(s.m.admin, 'f', 'Fund I', 'u', { date: '2026-10-01', amount: 1 })).toEqual({ error: 'Vehicle not found' })
  })
})

describe('gpuOpsCloseIssues', () => {
  const close = () => gpuOpsCloseIssues(s.m.admin, 'f', G, 'v-gpu', '2026-09-01', '2026-09-30')

  it('passes a posted month whose subledger ties', async () => {
    await stage()
    await ignoreEarnings(s.m.admin, 'f', G, [byAsset(null).id])
    await postEarnings(s.m.admin, 'f', G, 'u', ids('staged'))
    expect(await close()).toEqual({ blockers: [], warnings: [] })
  })

  it('blocks on an unmatched row and warns on a staged one', async () => {
    await stage()
    const r = await close()
    expect(r.blockers).toEqual([expect.stringMatching(/^1 GPU operations row in this span matches no server/)])
    expect(r.warnings).toEqual([expect.stringMatching(/^3 GPU operations rows are entered but not posted/)])
  })

  it('blocks when revenue reaches 4000 outside the subledger, and warns when 1150 drifts', async () => {
    await stage(line('H200 #1', 8640, 864))
    await postEarnings(s.m.admin, 'f', G, 'u', ids('staged'))
    s.m.tables.journal_entries.push({ id: 'manual', fund_id: 'f', vehicle_id: 'v-gpu', book: 'actual', status: 'posted', entry_date: '2026-09-15', source_type: 'manual' })
    s.m.tables.journal_postings.push(
      { journal_entry_id: 'manual', fund_id: 'f', vehicle_id: 'v-gpu', book: 'actual', account_id: acc('1150'), amount: 500, currency: 'USD' },
      { journal_entry_id: 'manual', fund_id: 'f', vehicle_id: 'v-gpu', book: 'actual', account_id: acc('4000'), amount: -500, currency: 'USD' },
    )
    const r = await close()
    expect(r.blockers).toEqual([expect.stringMatching(/^GPU revenue does not tie: posted operations entries total 8640.00 gross, but 4000 Rental revenue shows 9140.00/)])
    expect(r.warnings).toEqual([expect.stringMatching(/^1150 Marketplace receivable is 8276.00 .*\(difference 500.00\)/)])
  })

  it('a failed read throws, for checkReadiness to turn into a blocker', async () => {
    s.m.failNext('gpu_earnings', 'select', 'boom')
    await expect(close()).rejects.toMatchObject({ message: 'boom' })
  })
})

// ── Review fixes (#90) ──
const inflowRow = (id: string, txn_date: string, amount: number) => ({ id, fund_id: 'f', vehicle_id: 'v-gpu', portfolio_group: G, txn_date, amount, description: 'Marketplace payout', status: 'drafted', journal_entry_id: null })
const entriesWith = (prefix: string) => (s.m.tables.journal_entries as any[]).filter(e => String(e.source_ref ?? '').startsWith(prefix))

describe('posting is claimed', () => {
  it('two concurrent confirmed posts of one correction book exactly one reversal and one new entry', async () => {
    await stage(line('H200 #1', 8640, 864))
    await postEarnings(s.m.admin, 'f', G, 'u', ids('staged'))
    await stage(line('H200 #1', 9000, 900))
    const fix = byAsset('a-1', 'staged').id
    const [a, b] = await Promise.all([
      postEarnings(s.m.admin, 'f', G, 'u', [fix], { confirmReversal: true }),
      postEarnings(s.m.admin, 'f', G, 'u', [fix], { confirmReversal: true }),
    ])
    expect([a, b].filter(r => 'reversed' in r)).toHaveLength(1)
    expect([a, b].find(r => 'error' in r)).toMatchObject({ error: expect.stringMatching(/another request/) })
    expect(entriesWith('reversal:')).toHaveLength(1)
    expect(entriesWith('marketplace:')).toHaveLength(2)
    expect(await gpuOpsCloseIssues(s.m.admin, 'f', G, 'v-gpu', '2026-09-01', '2026-09-30')).toEqual({ blockers: [], warnings: [] })
  })

  it('a concurrent post of the same row is refused while the first books it', async () => {
    await stage(line('H200 #1', 8640, 864))
    const id = ids('staged')[0]
    const [a, b] = await Promise.all([postEarnings(s.m.admin, 'f', G, 'u', [id]), postEarnings(s.m.admin, 'f', G, 'u', [id])])
    expect([a, b].filter(r => 'reversed' in r)).toHaveLength(1)
    expect(entriesWith('marketplace:')).toHaveLength(1)
  })

  it('an import while a row is being posted leaves its figures alone', async () => {
    await stage(line('H200 #1', 8640, 864))
    let during: Awaited<ReturnType<typeof stage>> | undefined
    s.during = async () => { during = await stage(line('H200 #1', 9000, 900)) }
    const r = await postEarnings(s.m.admin, 'f', G, 'u', ids('staged'))
    if (!('reversed' in r)) throw new Error(JSON.stringify(r))
    expect(during).toMatchObject({ imported: 0, errors: ['Row 1: H200 #1 2026-09-01..2026-09-30 is being posted right now. Enter it again once that finishes.'] })
    expect(byAsset('a-1')).toMatchObject({ status: 'posted', gross: 8640 })
    expect(legs(r.posted[0].entryId!)).toEqual({ [acc('1150')]: 7776, [acc('5150')]: 864, [acc('4000')]: -8640 })
  })

  it('a retry after the final status update failed adopts the booked entry, and only when its figures match', async () => {
    await stage(line('H200 #1', 8640, 864))
    const id = ids('staged')[0]
    s.during = async () => { s.m.failNext('gpu_earnings', 'update', 'connection reset') }
    await expect(postEarnings(s.m.admin, 'f', G, 'u', [id])).rejects.toMatchObject({ message: 'connection reset' })
    expect(byAsset('a-1').status).toBe('posting')

    // Someone edits the booked entry by hand: the retry refuses to adopt it, and the row goes back.
    const booked = entriesWith('marketplace:')[0]
    const leg = s.m.tables.journal_postings.find((p: any) => p.journal_entry_id === booked.id && p.account_id === acc('4000'))
    leg.amount = -8000
    expect(await postEarnings(s.m.admin, 'f', G, 'u', [id])).toMatchObject({ error: expect.stringMatching(new RegExp(`Entry ${booked.id} .*gross 8000.*gross 8640`)) })
    expect(byAsset('a-1').status).toBe('staged')

    leg.amount = -8640
    const r = await postEarnings(s.m.admin, 'f', G, 'u', [id])
    expect(r).toMatchObject({ posted: [{ id, entryId: booked.id }] })
    expect(entriesWith('marketplace:')).toHaveLength(1)
    expect(byAsset('a-1')).toMatchObject({ status: 'posted', journal_entry_id: booked.id })
  })

  it('reads the rows in chunks, so a long list of ids stays under the URL limit', async () => {
    await stage(line('H200 #1', 8640, 864))
    const id = ids('staged')[0]
    const many = [id, ...Array.from({ length: 450 }, (_, i) => `missing-${i}`)]
    expect(await postEarnings(s.m.admin, 'f', G, 'u', many)).toEqual({ error: 'Some of those rows are not this entity’s' })
  })
})

describe('zero-revenue periods', () => {
  const zero = (asset: string) => `${asset},2026-09-01,2026-09-30,0,,0,0,0,720,offline all month`

  it('post with no entry: the row is posted with no journal entry, and the close still ties', async () => {
    await stage(zero('H200 #1'))
    const r = await postEarnings(s.m.admin, 'f', G, 'u', ids('staged'))
    expect(r).toMatchObject({ posted: [{ entryId: null }] })
    expect(s.m.tables.journal_entries).toEqual([])
    expect(byAsset('a-1')).toMatchObject({ status: 'posted', journal_entry_id: null, downtime_hours: 720 })
    expect(await gpuOpsCloseIssues(s.m.admin, 'f', G, 'v-gpu', '2026-09-01', '2026-09-30')).toEqual({ blockers: [], warnings: [] })
  })

  it('a positive period corrected to zero books the reversal only', async () => {
    await stage(line('H200 #1', 8640, 864))
    await postEarnings(s.m.admin, 'f', G, 'u', ids('staged'))
    await stage(zero('H200 #1'))
    const r = await postEarnings(s.m.admin, 'f', G, 'u', ids('staged'), { confirmReversal: true })
    expect(r).toMatchObject({ posted: [{ entryId: null }], reversed: [{ reversalId: expect.any(String) }] })
    expect(entriesWith('reversal:')).toHaveLength(1)
    expect(entriesWith('marketplace:')).toHaveLength(1)
    expect(earnings().map(e => e.status).sort()).toEqual(['posted', 'reversed'])
    expect(await gpuOpsCloseIssues(s.m.admin, 'f', G, 'v-gpu', '2026-09-01', '2026-09-30')).toEqual({ blockers: [], warnings: [] })
  })
})

describe('disposed servers', () => {
  it('match and post their last period, and refuse a period starting after disposal', async () => {
    Object.assign(s.m.tables.gpu_assets[0], { status: 'disposed', disposed_on: '2026-09-20' })
    const r = await stage(`${line('H200 #1', 8640, 864)}\nH200 #1,2026-10-01,2026-10-31,10,,10`)
    expect(r).toMatchObject({ imported: 1, matched: 1, errors: ['Row 2: H200 #1 was disposed of on 2026-09-20, before this period starts'] })
    expect(await postEarnings(s.m.admin, 'f', G, 'u', ids('staged'))).toMatchObject({ posted: [{ entryId: expect.any(String) }] })
  })
})

describe('payout matching is claimed', () => {
  async function twoPayouts() {
    await stage()
    await ignoreEarnings(s.m.admin, 'f', G, [byAsset(null).id])
    await postEarnings(s.m.admin, 'f', G, 'u', ids('staged'))
    const p1 = await recordPayout(s.m.admin, 'f', G, 'u', { date: '2026-10-01', amount: 7776 })
    const p2 = await recordPayout(s.m.admin, 'f', G, 'u', { date: '2026-10-02', amount: 7776 })
    if ('error' in p1 || 'error' in p2) throw new Error('record failed')
    s.m.tables.bank_transactions.push(inflowRow('t-1', '2026-10-03', 7776))
    return [p1.payout.id, p2.payout.id]
  }

  it('two payouts racing for one inflow: one matches, the other is refused and stays expected', async () => {
    const [p1, p2] = await twoPayouts()
    const results = await Promise.all([matchPayout(s.m.admin, 'f', G, 'u', p1, 't-1'), matchPayout(s.m.admin, 'f', G, 'u', p2, 't-1')])
    expect(results.filter(r => 'entryId' in r)).toHaveLength(1)
    expect(results.find(r => 'error' in r)).toMatchObject({ error: expect.stringMatching(/another payout|That bank transaction is/) })
    expect(entriesWith('marketplace-payout:')).toHaveLength(1)
    expect((s.m.tables.gpu_payouts as any[]).map(p => p.status).sort()).toEqual(['expected', 'matched'])
    expect(await receivableTieOut(s.m.admin, 'f', G, '2026-10-31')).toMatchObject({ difference: 0, matchedPayouts: 7776 })
  })

  it('a failed final update leaves the payout matching; matching again finishes it without booking twice', async () => {
    const [p1] = await twoPayouts()
    s.afterLink = () => s.m.failNext('gpu_payouts', 'update', 'connection reset')
    expect(await matchPayout(s.m.admin, 'f', G, 'u', p1, 't-1')).toMatchObject({ error: expect.stringMatching(/booked and reconciled.*Match it again/) })
    expect(s.m.tables.gpu_payouts.find((p: any) => p.id === p1)).toMatchObject({ status: 'matching', bank_transaction_id: 't-1' })
    expect(s.m.tables.bank_transactions[0].status).toBe('reconciled')

    const again = await matchPayout(s.m.admin, 'f', G, 'u', p1, 't-1')
    expect(again).toMatchObject({ payoutId: p1 })
    expect(entriesWith('marketplace-payout:')).toHaveLength(1)
    expect(s.m.tables.gpu_payouts.find((p: any) => p.id === p1)).toMatchObject({ status: 'matched', journal_entry_id: (again as any).entryId })
    expect(await receivableTieOut(s.m.admin, 'f', G, '2026-10-31')).toMatchObject({ difference: 0, matchedPayouts: 7776 })
  })
})

describe('end to end: post, record a payout, and the bank auto-match books it', () => {
  it('Dr 1000 / Cr 1150, the bank row reconciled and 1150 cleared, unattended', async () => {
    await stage()
    await ignoreEarnings(s.m.admin, 'f', G, [byAsset(null).id])
    await postEarnings(s.m.admin, 'f', G, 'u', ids('staged'))
    const recorded = await recordPayout(s.m.admin, 'f', G, 'u', { date: '2026-10-01', amount: 23_328 })
    if ('error' in recorded) throw new Error(recorded.error)
    s.m.tables.bank_transactions.push(inflowRow('t-1', '2026-10-04', 23_328))
    s.m.tables.capital_call_lines = []

    const out = await autoMatchOpenCapital(s.m.admin, 'f', G, 'u')
    if ('error' in out) throw new Error(out.error)
    expect(out.payouts).toEqual([{ txnId: 't-1', payoutId: recorded.payout.id, amount: 23_328, entryId: expect.any(String) }])
    expect(legs(out.payouts![0].entryId)).toEqual({ [acc('1000')]: 23_328, [acc('1150')]: -23_328 })
    expect(s.m.tables.bank_transactions[0]).toMatchObject({ status: 'reconciled', journal_entry_id: out.payouts![0].entryId })
    expect(await receivableTieOut(s.m.admin, 'f', G, '2026-10-31')).toMatchObject({ ledger1150: 0, expected: 0, difference: 0 })
  })
})

describe('entering figures again after an ignore or a correction', () => {
  it('an ignored row can be entered again and is staged anew', async () => {
    await stage(line('H200 #1', 8640, 864))
    await ignoreEarnings(s.m.admin, 'f', G, ids('staged'))
    const r = await stage(line('H200 #1', 8640, 864))
    expect(r).toMatchObject({ imported: 1, skipped: 0 })
    expect(earnings().map(e => e.status).sort()).toEqual(['ignored', 'staged'])
  })

  it('re-entering the original figures after a correction stages a row that supersedes the correction', async () => {
    await stage(line('H200 #1', 8640, 864))
    await postEarnings(s.m.admin, 'f', G, 'u', ids('staged'))
    const original = byAsset('a-1', 'posted').id
    await stage(line('H200 #1', 9000, 900))
    await postEarnings(s.m.admin, 'f', G, 'u', ids('staged'), { confirmReversal: true })
    const correction = byAsset('a-1', 'posted').id

    const r = await stage(line('H200 #1', 8640, 864))
    expect(r).toMatchObject({ imported: 1, skipped: 0, needsReview: 1 })
    const undo = byAsset('a-1', 'staged')
    expect(undo.supersedes_id).toBe(correction)
    expect(undo.supersedes_id).not.toBe(original)
    await postEarnings(s.m.admin, 'f', G, 'u', [undo.id], { confirmReversal: true })
    expect(entriesWith('reversal:')).toHaveLength(2)
    expect(await gpuOpsCloseIssues(s.m.admin, 'f', G, 'v-gpu', '2026-09-01', '2026-09-30')).toEqual({ blockers: [], warnings: [] })
  })
})
