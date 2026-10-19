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
const C = 'cccccccc-0000-4000-8000-000000000003'
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

  it('a failing kind read changes nothing for a VC entity (treated as not fleet)', async () => {
    const before = await loadCloseEntrySuggestions(m.admin, 'f', 'Fund I', '2027-01-01', '2027-01-31')
    const from = m.admin.from
    m.admin.from = (t: string) => {
      const q = from(t)
      if (t !== 'fund_vehicles') return q
      const select = q.select.bind(q)
      q.select = (cols: string) => { if (cols === 'kind') m.failNext('fund_vehicles', 'select', 'boom'); return select(cols) }
      return q
    }
    expect(await loadCloseEntrySuggestions(m.admin, 'f', 'Fund I', '2027-01-01', '2027-01-31')).toEqual(before)
  })

  it('a recurring-pattern copy of posted depreciation is dropped for the fleet proposal; a VC entity gets no fleet suggestions', async () => {
    for (const month of ['2027-01', '2027-02']) { depreciate(A, month, 5_025); depreciate(B, month, 6_150) }
    const march = await loadCloseEntrySuggestions(m.admin, 'f', GPU, '2027-03-01', '2027-03-31')
    expect(march.map(s => s.basis)).toEqual(['fleet', 'fleet'])
    expect(await suggest('Fund I', '2027-01-01', '2027-01-31')).toEqual([])
  })
})

describe('the fleet is the only source of depreciation on the asset accounts', () => {
  it('drops a recurring-pattern copy after a disposal and after the life ends', async () => {
    // B disposed of on 10 March: February and March look like a recurring 6,150 on 5300/1650-B.
    Object.assign(m.tables.gpu_assets.find((a: any) => a.id === B)!, { status: 'disposed', disposed_on: '2027-03-10' })
    for (const month of ['2027-01', '2027-02']) { depreciate(A, month, 5_025); depreciate(B, month, 6_150) }
    depreciate(A, '2027-03', 5_025)
    book('2027-03-10', `gpu-dep:${B}:2027-03`, [['5300', 6_150], [`1650-${B.slice(0, 8)}`, -6_150]])
    const april = await loadCloseEntrySuggestions(m.admin, 'f', GPU, '2027-04-01', '2027-04-30')
    expect(april.map(x => [x.basis, x.sourceRef])).toEqual([['fleet', `gpu-dep:${A}:2027-04`]])

    // A two-month life: after both months are posted, a third is never proposed by anyone.
    Object.assign(m.tables.gpu_assets.find((a: any) => a.id === A)!, { useful_life_months: 2 })
    m.tables.journal_entries = m.tables.journal_entries.filter((e: any) => !String(e.source_ref).startsWith(`gpu-dep:${A}:2027-03`))
    const march = await loadCloseEntrySuggestions(m.admin, 'f', GPU, '2027-03-01', '2027-03-31')
    expect(march.filter(x => x.postings.some(p => p.accountId === `v-gpu-1650-${A.slice(0, 8)}`))).toEqual([])
  })
})

describe('fleet close review', () => {
  const readiness = (group = GPU) => checkReadiness(m.admin as any, 'f', group, '2027-01-01', '2027-01-31')
  const statuses = (r: Awaited<ReturnType<typeof readiness>>) => (r.fleetChecks ?? []).map(c => [c.key, c.status])

  it('blocks while depreciation is missing (and the ledger NBV therefore differs from the register)', async () => {
    const r = await readiness()
    expect(r.blockers.join(' ')).toMatch(/depreciation is not posted through 2027-01-31 for H200 #1 \(2027-01\); depreciation is not posted through 2027-01-31 for B200 #1 \(2027-01\)/)
    // One cause, one blocker: an asset already flagged is not NBV-checked too.
    expect(statuses(r)).toEqual([['fleet_depreciation', 'blocked'], ['fleet_nbv', 'passed']])
    expect(r.blockers.filter(b => /net book value/.test(b))).toEqual([])
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

  it('a purchase booked but not linked to the register blocks', async () => {
    m.tables.gpu_assets.push({ ...asset(C, 'H200 #2', 335_000), purchase_entry_id: null, status: 'ordered' })
    m.tables.chart_of_accounts.push(account('v-gpu', GPU, `1600-${C.slice(0, 8)}`, 'asset', 'fixed_asset'), account('v-gpu', GPU, `1650-${C.slice(0, 8)}`, 'asset', 'accumulated_depreciation'))
    book('2027-01-05', `gpu-asset:${C}:purchase`, [[`1600-${C.slice(0, 8)}`, 335_000], ['1000', -335_000]], { source_type: 'manual' })
    depreciate(A, '2027-01', 5_025)
    depreciate(B, '2027-01', 6_150)
    const r = await readiness()
    expect(r.blockers.join(' ')).toMatch(/H200 #2's purchase is booked but not linked to the register; retry the purchase/)
    expect(r.fleetChecks![0]).toMatchObject({ status: 'blocked', evidence: { unlinked: [C] } })
  })

  it('an asset bought after the period end is not part of that period (a later purchase does not block an earlier close)', async () => {
    m.tables.journal_entries.find((e: any) => e.source_ref === `gpu-asset:${B}:purchase`)!.entry_date = '2027-02-05'
    depreciate(A, '2027-01', 5_025)
    const r = await readiness()
    expect(statuses(r)).toEqual([['fleet_depreciation', 'passed'], ['fleet_nbv', 'passed']])
    expect(await suggest(GPU, '2027-01-01', '2027-01-31')).toEqual([])
  })

  it('a reversal dated after the period does not undo that period\'s depreciation', async () => {
    reverse(depreciate(A, '2027-01', 5_025), '2027-02-01')
    depreciate(B, '2027-01', 6_150)
    const r = await readiness()
    expect(statuses(r)).toEqual([['fleet_depreciation', 'passed'], ['fleet_nbv', 'passed']])
    expect(await suggest(GPU, '2027-01-01', '2027-01-31')).toEqual([])
  })

  it('a month with nothing to charge (after a capex reversal) is not missing', async () => {
    // 600 hardware, no salvage, 4 months; 400 capex in January; Jan and Feb posted at 350; the capex
    // reversed in March leaves the asset depreciated past its cost: March and April charge 0.
    m.tables.gpu_assets = [{ ...asset(C, 'Spare', 600), salvage_value: 0, useful_life_months: 4 }]
    m.tables.chart_of_accounts.push(account('v-gpu', GPU, `1600-${C.slice(0, 8)}`, 'asset', 'fixed_asset'), account('v-gpu', GPU, `1650-${C.slice(0, 8)}`, 'asset', 'accumulated_depreciation'))
    book('2027-01-05', `gpu-asset:${C}:purchase`, [[`1600-${C.slice(0, 8)}`, 600], ['1000', -600]], { source_type: 'manual' })
    const cap = book('2027-01-10', `gpu-asset:${C}:capex:k`, [[`1600-${C.slice(0, 8)}`, 400], ['1000', -400]], { source_type: 'manual' })
    depreciate(C, '2027-01', 350)
    depreciate(C, '2027-02', 350)
    reverse(cap, '2027-03-05')
    const r = await checkReadiness(m.admin as any, 'f', GPU, '2027-04-01', '2027-04-30')
    expect(r.fleetChecks![0]).toMatchObject({ status: 'passed' })
    expect(await suggest(GPU, '2027-03-01', '2027-04-30')).toEqual([])
  })

  it('a period ending mid-month does not yet owe that month (due by entry date, min(month end, disposal))', async () => {
    depreciate(A, '2027-01', 5_025)
    depreciate(B, '2027-01', 6_150)
    const mid = await checkReadiness(m.admin as any, 'f', GPU, '2027-02-01', '2027-02-15')
    expect(statuses(mid)).toEqual([['fleet_depreciation', 'passed'], ['fleet_nbv', 'passed']])
    expect(await suggest(GPU, '2027-02-01', '2027-02-15')).toEqual([])
    // A disposal on 10 February makes February's (half-period) charge due by the 15th.
    Object.assign(m.tables.gpu_assets.find((a: any) => a.id === B)!, { status: 'disposed', disposed_on: '2027-02-10' })
    expect((await suggest(GPU, '2027-02-01', '2027-02-15')).map(x => [x[0], x[1]])).toEqual([[`gpu-dep:${B}:2027-02`, '2027-02-10']])
  })

  it('a one-cent NBV difference blocks', async () => {
    depreciate(A, '2027-01', 5_025)
    depreciate(B, '2027-01', 6_150)
    book('2027-01-20', null, [['5900', 0.01], [`1650-${A.slice(0, 8)}`, -0.01]], { source_type: 'manual' })
    const r = await readiness()
    expect(statuses(r)).toEqual([['fleet_depreciation', 'passed'], ['fleet_nbv', 'blocked']])
    expect(r.blockers.join(' ')).toMatch(/ledger 329974\.99, register 329975\.00/)
  })

  it('a disposed asset is worth 0 in the register: a cleared ledger ties, an uncleared one blocks', async () => {
    depreciate(A, '2027-01', 5_025)
    depreciate(B, '2027-01', 6_150)
    Object.assign(m.tables.gpu_assets.find((a: any) => a.id === B)!, { status: 'disposed', disposed_on: '2027-01-31', disposal_entry_id: 'x' })
    const uncleared = await readiness()
    expect(uncleared.fleetChecks![1]).toMatchObject({ status: 'blocked', evidence: { assets: expect.arrayContaining([{ assetId: B, ledger: 403_850, register: 0 }]) } })
    book('2027-01-31', `gpu-asset:${B}:disposal`, [['1000', 403_850], [`1650-${B.slice(0, 8)}`, 6_150], [`1600-${B.slice(0, 8)}`, -410_000]], { source_type: 'realized_gain' })
    expect(statuses(await readiness())).toEqual([['fleet_depreciation', 'passed'], ['fleet_nbv', 'passed']])
  })

  it('fails closed when the fleet cannot be read', async () => {
    m.failNext('gpu_assets', 'select', 'canceling statement due to statement timeout')
    const r = await readiness()
    expect(r.blockers.join(' ')).toMatch(/The GPU fleet could not be checked: canceling statement due to statement timeout/)
    expect(r.fleetChecks![0]).toMatchObject({ status: 'blocked' })
  })

  it('a VC entity has no fleet checks at all', async () => {
    const r = await readiness('Fund I')
    expect(r).not.toHaveProperty('fleetChecks')
    expect(r.blockers.filter(b => /fleet|Depreciation/.test(b))).toEqual([])
  })
})
