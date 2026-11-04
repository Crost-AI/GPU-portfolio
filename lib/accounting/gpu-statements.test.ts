import { describe, expect, it } from 'vitest'
import { DEFAULT_CHART } from './chart'
import { NO_CARRY } from './carry'
import { computePayload, loadLedgerData, type LedgerData } from './statement-package'
import { memoryAdmin } from '@/tests/helpers/memory-admin'
import { A1, A2, C1, C2, GPU_ACCOUNTS, GPU_ENTRIES, VC_ENTRIES, YEAR, chart, ledger } from '@/tests/helpers/statement-fixtures'

/**
 * A GPU SPV's statements (gpu-P4 B2, pivot plan §5.4): the cash-flow statement reports its
 * equipment as investing, and every other kind's statement package is byte-identical to before
 * (the `fof` precedent: an optional block, absent unless it applies).
 */

describe('every kind other than a GPU SPV: the statement package is unchanged', () => {
  it('a fund: the whole payload, pinned (taken before the GPU change)', () => {
    const p = computePayload(ledger(chart(DEFAULT_CHART), 'fund', VC_ENTRIES), YEAR)
    expect('investing' in p.cashFlows!).toBe(false)
    expect(JSON.stringify(p)).toMatchSnapshot()
  })
})

describe("a GPU SPV's cash-flow statement: equipment is investing", () => {
  const p = computePayload(ledger(GPU_ACCOUNTS, 'gpu_spv', GPU_ENTRIES), YEAR)
  const cf = p.cashFlows!

  it('purchases, capitalized costs and the sale are investing; depreciation never appears', () => {
    expect(cf.investing).toEqual({
      label: 'Investing activities',
      lines: [
        { code: '', name: 'Purchases of equipment and capitalized costs', amount: -422_000 },
        { code: '', name: 'Proceeds from disposal of equipment', amount: 50_000 },
      ],
      total: -372_000,
    })
    expect(cf.operating.lines.map(l => l.code)).toEqual(['1150', '5100'])
    expect(cf.operating.total).toBe(20_000)
    expect(cf.financing.total).toBe(1_000_000)
    expect([...cf.operating.lines, ...cf.investing!.lines, ...cf.financing.lines].some(l => /5300|1650|Depreciation/.test(`${l.code} ${l.name}`))).toBe(false)
  })

  it('net change is operating + investing + financing, and ties to the cash on the balance sheet', () => {
    expect(cf.netChange).toBe(20_000 - 372_000 + 1_000_000)
    expect(cf.endingCash).toBe(648_000)
    expect(GPU_ENTRIES.flatMap(e => e[3]).filter(([code]) => code === '1000').reduce((s, [, a]) => s + a, 0)).toBe(648_000)
  })

  it('equipment bought on credit is disclosed as a non-cash investing transaction; depreciation is not', () => {
    expect(cf.nonCash.map(n => n.entryId)).toEqual(['buy-2'])
  })
})

describe("a GPU SPV's fleet schedule: one row per server, from the ledger, tying to 1600 − 1650", () => {
  const types = [{ id: 't1', fund_id: 'f1', code: 'b200', label: 'NVIDIA B200', gpu_model: null, gpus_per_server: 8, anchor_rate: 5.5, notes: null }]
  const asset = (id: string, name: string, over: Record<string, unknown> = {}) => ({
    id, name, asset_type_id: 't1', gpu_count: 8, in_service_date: '2027-01-15', status: 'in_service', capitalized_costs: 0, ...over,
  }) as any
  const withRegister = (entries: typeof GPU_ENTRIES) => ({
    ...ledger(GPU_ACCOUNTS, 'gpu_spv', entries),
    fleet: { assets: [asset(A1, 'srv-1', { capitalized_costs: 12_000 }), asset(A2, 'srv-2', { status: 'planned', in_service_date: null })], types },
  })
  const tie = (p: ReturnType<typeof computePayload>, entries: typeof GPU_ENTRIES, end: string) => {
    const live = entries.filter(e => e[1] <= end).flatMap(e => e[3])
    const sum = (prefix: string) => live.filter(([code]) => code.startsWith(prefix)).reduce((s, [, a]) => s + Math.round(a * 100), 0)
    return { schedule: p.fleetSchedule!.reduce((s, r) => s + Math.round(r.nbv * 100), 0), ledger: sum('1600') + sum('1650') }
  }

  it('before the sale: both servers with their register detail, cost, accumulated and NBV', () => {
    const p = computePayload(withRegister(GPU_ENTRIES), { start: '2027-01-01', end: '2027-06-30', label: 'H1' } as any)
    expect(p.fleetSchedule).toEqual([
      { assetId: A1, code: C1, name: 'srv-1', typeCode: 'b200', typeLabel: 'NVIDIA B200', gpus: 8, inServiceDate: '2027-01-15', status: 'in_service',
        cost: 422_000, accumulated: 6_000, nbv: 416_000, ytdRevenue: null, ytdUtilization: null },
      { assetId: A2, code: C2, name: 'srv-2', typeCode: 'b200', typeLabel: 'NVIDIA B200', gpus: 8, inServiceDate: null, status: 'planned',
        cost: 335_000, accumulated: 5_000, nbv: 330_000, ytdRevenue: null, ytdUtilization: null },
    ])
    const t = tie(p, GPU_ENTRIES, '2027-06-30')
    expect(t.schedule).toBe(t.ledger)
  })

  it('after the sale: the sold server drops off, and the total still ties', () => {
    const p = computePayload(withRegister(GPU_ENTRIES), YEAR)
    expect(p.fleetSchedule!.map(r => r.name)).toEqual(['srv-2'])
    const t = tie(p, GPU_ENTRIES, '2027-12-31')
    expect(t.schedule).toBe(t.ledger)
    expect(t.ledger).toBe(33_000_000)
  })

  it('equipment on the parent account, or a server missing from the register, still has its row', () => {
    const entries: typeof GPU_ENTRIES = [...GPU_ENTRIES, ['legacy', '2027-04-01', 'manual', [['1600', 20_000], ['1000', -20_000]]]]
    const p = computePayload({ ...ledger(GPU_ACCOUNTS, 'gpu_spv', entries), fleet: { assets: [], types: [] } }, YEAR)
    expect(p.fleetSchedule!.map(r => [r.code, r.assetId, r.name, r.nbv])).toEqual([
      ['1600', null, 'GPU equipment at cost', 20_000],
      [C2, null, 'GPU equipment at cost — srv-2', 330_000],
    ])
    const t = tie(p, entries, '2027-12-31')
    expect(t.schedule).toBe(t.ledger)
  })

  it('is absent for every other kind', () => {
    expect('fleetSchedule' in computePayload(ledger(chart(DEFAULT_CHART), 'fund', VC_ENTRIES), YEAR)).toBe(false)
  })
})

describe('loadLedgerData reads the register for a GPU SPV only', () => {
  const seed = () => ({
    fund_vehicles: [{ id: 'v1', fund_id: 'f1', name: 'GPU SPV I', kind: 'gpu_spv' }, { id: 'v2', fund_id: 'f1', name: 'Fund I', kind: 'fund' }],
    gpu_assets: [{ id: A1, fund_id: 'f1', vehicle_id: 'v1', name: 'srv-1', asset_type_id: 't1', status: 'in_service', gpu_count: 8, hardware_cost: 410_000, created_at: '2027-01-01' }],
    gpu_asset_types: [{ id: 't1', fund_id: 'f1', code: 'b200', label: 'B200', gpus_per_server: 8 }],
  })
  it('a GPU SPV carries its servers and types; a fund carries none', async () => {
    const { admin } = memoryAdmin(seed())
    const gpu = await loadLedgerData(admin as any, 'f1', 'GPU SPV I')
    expect(gpu.fleet?.assets.map(a => a.name)).toEqual(['srv-1'])
    expect(gpu.fleet?.types.map(t => t.code)).toEqual(['b200'])
    const fund = await loadLedgerData(admin as any, 'f1', 'Fund I')
    expect('fleet' in fund).toBe(false)
  })
})

describe('the accrued profit-share memo in the statement package (gp_economics only, never booked)', () => {
  const memoTerms = { ...NO_CARRY, kind: 'distributable_cash' as const, prefRate: 0.08, carryRate: 0.3, prefDayCount: '30_360' as const, rocLpShare: 1, recipients: [{ lpEntityId: 'mgr', pct: 100 }] }
  // Contributed 1,000,000 on 5 Jan 2027 (the call entry above, per LP 'lp1'); no distribution yet.
  const withMemo = (reserve = 0) => ({ ...ledger(GPU_ACCOUNTS, 'gpu_spv', GPU_ENTRIES), accruedMemo: { terms: memoTerms, contingencyByDate: new Map(), reserve } })

  it('is present when loaded for it, and changes no balance in any statement', () => {
    const plain = computePayload(ledger(GPU_ACCOUNTS, 'gpu_spv', GPU_ENTRIES), YEAR)
    const memo = computePayload(withMemo(), YEAR)
    expect(memo.accruedProfitShare).toMatchObject({ asOf: '2027-12-31', memo: 'not booked' })
    // Book NAV: cash 648,000 − owed 335,000 (2000) + equipment 330,000 = 643,000; under the capital, so nothing accrues.
    expect(memo.accruedProfitShare!.bookNav).toBe(643_000)
    expect(memo.accruedProfitShare!.carryMemo).toBe(0)
    const { accruedProfitShare: _m, ...rest } = memo
    expect(rest).toEqual(plain)
  })

  it('is absent unless asked for: by default, as every export, PDF and tax/K-1 loader reads', () => {
    expect('accruedProfitShare' in computePayload(ledger(GPU_ACCOUNTS, 'gpu_spv', GPU_ENTRIES), YEAR)).toBe(false)
    // A fund never carries it, asked or not.
    expect('accruedProfitShare' in computePayload({ ...ledger(chart(DEFAULT_CHART), 'fund', VC_ENTRIES), accruedMemo: withMemo().accruedMemo }, YEAR)).toBe(false)
  })

  it('loadLedgerData loads it only when asked, for a GPU SPV', async () => {
    const { admin } = memoryAdmin({
      fund_vehicles: [{ id: 'v1', fund_id: 'f1', name: 'GPU SPV I', kind: 'gpu_spv' }],
      vehicle_waterfall_terms: [{ fund_id: 'f1', vehicle_id: 'v1', kind: 'distributable_cash', carry_rate: 0.3, pref_rate: 0.08, catchup_rate: 1, pref_compounds: false, carry_recipients: [{ lp_entity_id: 'mgr', pct: 100 }], pref_day_count: '30_360', roc_lp_share: 1 }],
      gpu_assets: [], gpu_asset_types: [], distributions: [],
    })
    expect('accruedMemo' in (await loadLedgerData(admin as any, 'f1', 'GPU SPV I'))).toBe(false)
    expect((await loadLedgerData(admin as any, 'f1', 'GPU SPV I', { accruedMemo: true })).accruedMemo?.terms.kind).toBe('distributable_cash')
  })
})
