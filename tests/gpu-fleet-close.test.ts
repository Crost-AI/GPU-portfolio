import { describe, it, expect, beforeEach } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'
import { GPU_SPV_CHART, DEFAULT_CHART } from '@/lib/accounting/chart'
import { loadCloseEntrySuggestions } from '@/lib/accounting/close-suggestions'
import { checkReadiness } from '@/lib/accounting/close'

/**
 * ── GPU fleet (P1) ── The fleet in the period close (design §4.5), over the memory admin with the
 * real suggester and readiness check. Two §2.7 servers in service from January 2027: 335,000 and
 * 410,000 at 10% salvage over 60 months, so 5,025 and 6,150 a month.
 */

const A = 'aaaaaaaa-0000-4000-8000-000000000001'
const B = 'bbbbbbbb-0000-4000-8000-000000000002'
const GPU = 'H200 SPV I'
let m: ReturnType<typeof memoryAdmin>
let seq = 0

const account = (vehicle: string, group: string, code: string, type = 'asset', subtype: string | null = null) =>
  ({ id: `${vehicle}-${code}`, fund_id: 'f', vehicle_id: vehicle, portfolio_group: group, code, name: code, type, subtype })
const asset = (id: string, name: string, cost: number) => ({
  id, fund_id: 'f', vehicle_id: 'v-gpu', name, status: 'in_service', gpu_count: 8, hardware_cost: cost, salvage_value: cost * 0.1,
  useful_life_months: 60, depreciation_convention: 'full_month', in_service_date: '2027-01-15', purchase_entry_id: `p-${name}`,
  disposed_on: null, disposal_entry_id: null, tax_method: 'book', tax_bonus_pct: 0, tax_life_years: null,
})
/** Book an entry straight into the ledger (posted unless said otherwise). */
const book = (date: string, ref: string | null, lines: [string, number][], over: object = {}) => {
  const id = `je-${++seq}`
  m.tables.journal_entries.push({ id, fund_id: 'f', vehicle_id: 'v-gpu', portfolio_group: GPU, book: 'actual', status: 'posted', entry_date: date, source_type: 'partnership_expense', source_ref: ref, memo: ref, ...over })
  for (const [code, amount] of lines) m.tables.journal_postings.push({ journal_entry_id: id, fund_id: 'f', vehicle_id: 'v-gpu', book: 'actual', account_id: `v-gpu-${code}`, amount, currency: 'USD' })
  return id
}
const depreciate = (id: string, month: string, amount: number, suffix = '') =>
  book(`${month}-${month.endsWith('02') ? '28' : '31'}`, `gpu-dep:${id}:${month}${suffix}`, [['5300', amount], [`1650-${id.slice(0, 8)}`, -amount]])
const reverse = (entryId: string, date: string) => {
  const lines = m.tables.journal_postings.filter((p: any) => p.journal_entry_id === entryId).map((p: any) => [p.account_id.replace('v-gpu-', ''), -p.amount] as [string, number])
  return book(date, `reversal:${entryId}`, lines)
}
const suggest = async (group: string, start: string, end: string) =>
  (await loadCloseEntrySuggestions(m.admin, 'f', group, start, end)).filter(s => s.basis === 'fleet').map(s => [s.sourceRef, s.entryDate, s.postings.map(p => p.amount)])

beforeEach(() => {
  seq = 0
  m = memoryAdmin({
    fund_vehicles: [
      { id: 'v-gpu', fund_id: 'f', name: GPU, kind: 'gpu_spv', aliases: [], active: true },
      { id: 'v-vc', fund_id: 'f', name: 'Fund I', kind: 'fund', aliases: [], active: true },
    ],
    chart_of_accounts: [
      ...GPU_SPV_CHART.map(a => account('v-gpu', GPU, a.code, a.type, a.subtype ?? null)),
      ...DEFAULT_CHART.map(a => account('v-vc', 'Fund I', a.code, a.type, a.subtype ?? null)),
      ...[A, B].flatMap(id => [account('v-gpu', GPU, `1600-${id.slice(0, 8)}`, 'asset', 'fixed_asset'), account('v-gpu', GPU, `1650-${id.slice(0, 8)}`, 'asset', 'accumulated_depreciation')]),
    ],
    gpu_assets: [asset(A, 'H200 #1', 335_000), asset(B, 'B200 #1', 410_000)],
    journal_entries: [], journal_postings: [], bank_transactions: [], accounting_schedules: [], accounting_schedule_lines: [],
  })
  book('2027-01-05', `gpu-asset:${A}:purchase`, [[`1600-${A.slice(0, 8)}`, 335_000], ['1000', -335_000]], { source_type: 'manual' })
  book('2027-01-05', `gpu-asset:${B}:purchase`, [[`1600-${B.slice(0, 8)}`, 410_000], ['1000', -410_000]], { source_type: 'manual' })
})

describe('fleet depreciation suggestions (basis fleet)', () => {
  it('proposes one entry per in-service asset for the month, at the §2.7 amounts', async () => {
    expect(await suggest(GPU, '2027-01-01', '2027-01-31')).toEqual([
      [`gpu-dep:${B}:2027-01`, '2027-01-31', [6_150, -6_150]],
      [`gpu-dep:${A}:2027-01`, '2027-01-31', [5_025, -5_025]],
    ])
  })

  it('proposes nothing for a month already posted', async () => {
    depreciate(A, '2027-01', 5_025)
    expect(await suggest(GPU, '2027-01-01', '2027-01-31')).toEqual([[`gpu-dep:${B}:2027-01`, '2027-01-31', [6_150, -6_150]]])
  })

  it('re-proposes a reversed month under :r1, then :r2', async () => {
    reverse(depreciate(A, '2027-01', 5_025), '2027-01-31')
    depreciate(B, '2027-01', 6_150)
    expect((await suggest(GPU, '2027-01-01', '2027-01-31')).map(s => s[0])).toEqual([`gpu-dep:${A}:2027-01:r1`])
    reverse(depreciate(A, '2027-01', 5_025, ':r1'), '2027-01-31')
    expect((await suggest(GPU, '2027-01-01', '2027-01-31')).map(s => s[0])).toEqual([`gpu-dep:${A}:2027-01:r2`])
  })

  it('stops at a disposal, dating the disposal month by the disposal', async () => {
    Object.assign(m.tables.gpu_assets.find((a: any) => a.id === B)!, { status: 'disposed', disposed_on: '2027-03-10' })
    for (const month of ['2027-01', '2027-02']) { depreciate(A, month, 5_025); depreciate(B, month, 6_150) }
    expect(await suggest(GPU, '2027-03-01', '2027-03-31')).toEqual([
      [`gpu-dep:${B}:2027-03`, '2027-03-10', [6_150, -6_150]],
      [`gpu-dep:${A}:2027-03`, '2027-03-31', [5_025, -5_025]],
    ])
    expect((await suggest(GPU, '2027-04-01', '2027-04-30')).map(s => s[0])).toEqual([`gpu-dep:${A}:2027-04`])
  })

  it('a recurring-pattern copy of posted depreciation is dropped for the fleet proposal; a VC entity gets no fleet suggestions', async () => {
    for (const month of ['2027-01', '2027-02']) { depreciate(A, month, 5_025); depreciate(B, month, 6_150) }
    const march = await loadCloseEntrySuggestions(m.admin, 'f', GPU, '2027-03-01', '2027-03-31')
    expect(march.map(s => s.basis)).toEqual(['fleet', 'fleet'])
    expect(await suggest('Fund I', '2027-01-01', '2027-01-31')).toEqual([])
  })
})

describe('fleet close review', () => {
  const readiness = (group = GPU) => checkReadiness(m.admin as any, 'f', group, '2027-01-01', '2027-01-31')
  const statuses = (r: Awaited<ReturnType<typeof readiness>>) => (r.fleetChecks ?? []).map(c => [c.key, c.status])

  it('blocks while depreciation is missing (and the ledger NBV therefore differs from the register)', async () => {
    const r = await readiness()
    expect(r.blockers.join(' ')).toMatch(/Depreciation is not posted through 2027-01-31 for H200 #1 \(2027-01\); B200 #1 \(2027-01\)/)
    expect(statuses(r)).toEqual([['fleet_depreciation', 'blocked'], ['fleet_nbv', 'blocked']])
  })

  it('a reversed month is not posted', async () => {
    reverse(depreciate(A, '2027-01', 5_025), '2027-01-31')
    depreciate(B, '2027-01', 6_150)
    const r = await readiness()
    expect(r.fleetChecks![0]).toMatchObject({ status: 'blocked', evidence: { missing: [{ assetId: A, months: ['2027-01'] }] } })
  })

  it('blocks when the ledger NBV does not equal the register, even with depreciation posted', async () => {
    depreciate(A, '2027-01', 5_025)
    depreciate(B, '2027-01', 6_150)
    book('2027-01-20', null, [['5900', 100], [`1650-${A.slice(0, 8)}`, -100]], { source_type: 'manual' })
    const r = await readiness()
    expect(statuses(r)).toEqual([['fleet_depreciation', 'passed'], ['fleet_nbv', 'blocked']])
    expect(r.blockers.join(' ')).toMatch(/H200 #1 \(ledger 329875\.00, register 329975\.00\)/)
  })

  it('passes when depreciation is posted and the NBV ties', async () => {
    depreciate(A, '2027-01', 5_025)
    depreciate(B, '2027-01', 6_150)
    const r = await readiness()
    expect(statuses(r)).toEqual([['fleet_depreciation', 'passed'], ['fleet_nbv', 'passed']])
    expect(r.blockers.filter(b => /fleet|Depreciation/.test(b))).toEqual([])
  })

  it('a VC entity has no fleet checks at all', async () => {
    const r = await readiness('Fund I')
    expect(r).not.toHaveProperty('fleetChecks')
    expect(r.blockers.filter(b => /fleet|Depreciation/.test(b))).toEqual([])
  })
})
