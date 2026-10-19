import { describe, expect, it } from 'vitest'
import { planReturns } from './plan-returns'
import { validateCapital } from './capital'
import { F1, PACK_INPUTS, PACK_TERMS } from '@/lib/gpu/fixtures/pack-v3'
import { contribute, distribute, emptyState } from '@/lib/gpu/waterfall'

const m = (o: Record<string, number>) => new Map(Object.entries(o)) as any
const months = Array.from({ length: 24 }, (_, i) => `${2027 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`) as any[]

const wf = {
  asOf: '2026-12-31', kind: 'european' as const, carryRate: 0.2, prefRate: 0, catchupRate: 1, prefCompounds: true,
  lpCommitmentShare: 0.99, lpCalledCapital: 0, lpDistributedCapital: 0, fundDistributedCapital: 0, lpNav: 0, contributions: [],
}

describe("a plan's returns — one calculation", () => {
  const r = planReturns({
    months, asOfMonth: '2026-12', openingCash: 0, uncalled: 2_000_000, settings: validateCapital({}),
    otherFlows: m({ '2027-01': -20_000 }), // a fee
    invested: m({ '2027-01': -1_000_000 }),
    proceeds: m({ '2028-06': 3_000_000 }),
    terminalNav: 0, waterfall: wf,
  })

  it('calls what the fee and the check need, and distributes the exit', () => {
    expect(r.totals.called).toBe(1_020_000)
    expect(r.totals.distributed).toBe(3_000_000)
    expect(r.years.map(y => [y.calendarYear, y.called, y.distributed])).toEqual([[2027, 1_020_000, 0], [2028, 0, 3_000_000]])
  })

  it("takes carry on the LPs' gain only, and gives the LPs their net", () => {
    // LPs: 99% of 1,020,000 in; 99% of 3,000,000 out = 2,970,000 → 1,009,800 back, 1,960,200 gain, 20% carry.
    expect(r.totals.carry).toBeCloseTo(392_040, 0)
    expect(r.lp.called).toBeCloseTo(1_009_800, 2)
    expect(r.lp.distributed).toBeCloseTo(2_970_000 - 392_040, 0)
    expect(r.lp.tvpi!).toBeCloseTo((2_970_000 - 392_040) / 1_009_800, 3)
    expect(r.lp.irr!).toBeGreaterThan(0.5)
    expect(r.halfBackYear).toBe(2028)
  })

  it('runs distributions paid to date month by month, for the timing as well as the amount', () => {
    expect(r.distributedToDate[months.indexOf('2028-05')]).toBe(0)
    expect(r.distributedToDate[months.indexOf('2028-06')]).toBe(3_000_000)
    expect(r.distributedToDate[months.length - 1]).toBe(3_000_000)
  })

  it('honours month edits and values what is left through the waterfall', () => {
    const edited = planReturns({
      months, asOfMonth: '2026-12', openingCash: 0, uncalled: 2_000_000,
      // June pays 1,000,000; every later month is held at nothing, so the rest stays in the fund.
      settings: validateCapital({ distributions: Object.fromEntries(months.filter(x => x >= '2028-06').map(x => [x, x === '2028-06' ? 1_000_000 : 0])) }),
      otherFlows: m({}), invested: m({ '2027-01': -1_000_000 }), proceeds: m({ '2028-06': 3_000_000 }),
      terminalNav: 0, waterfall: wf,
    })
    expect(edited.totals.distributed).toBe(1_000_000)
    // 2,000,000 stays in the bank: the LPs' 99% of it, through the waterfall, is their terminal value.
    expect(edited.lp.terminal).toBeGreaterThan(1_500_000)
    expect(edited.lp.terminal).toBeLessThan(1_980_000)
  })

  it('without carry terms gives the LPs their share of everything', () => {
    const r2 = planReturns({
      months, asOfMonth: '2026-12', openingCash: 0, uncalled: 2_000_000, settings: validateCapital({}),
      otherFlows: m({}), invested: m({ '2027-01': -1_000_000 }), proceeds: m({ '2028-06': 3_000_000 }),
      terminalNav: 500_000, waterfall: { ...wf, kind: 'none' as const, carryRate: 0 },
    })
    expect(r2.totals.carry).toBe(0)
    expect(r2.lp.distributed).toBe(2_970_000)
    expect(r2.lp.terminal).toBe(495_000)
  })
})

describe('the fund kinds are byte-identical whatever the GPU branch does', () => {
  // Every fixture above, whole, pinned: a change to planReturns that moves a VC figure fails here.
  const base = {
    months, asOfMonth: '2026-12' as any, openingCash: 0, uncalled: 2_000_000,
    otherFlows: m({ '2027-01': -20_000 }), invested: m({ '2027-01': -1_000_000 }), proceeds: m({ '2028-06': 3_000_000 }),
  }
  const cases = {
    european: { ...base, settings: validateCapital({}), terminalNav: 0, waterfall: wf },
    edited: {
      ...base, otherFlows: m({}), terminalNav: 0, waterfall: wf,
      settings: validateCapital({ distributions: Object.fromEntries(months.filter(x => x >= '2028-06').map(x => [x, x === '2028-06' ? 1_000_000 : 0])) }),
    },
    none: { ...base, otherFlows: m({}), settings: validateCapital({}), terminalNav: 500_000, waterfall: { ...wf, kind: 'none' as const, carryRate: 0 } },
    noWaterfall: { ...base, settings: validateCapital({}), terminalNav: 250_000 },
  }
  for (const [name, input] of Object.entries(cases)) {
    it(name, () => expect(JSON.stringify(planReturns(input as any))).toMatchSnapshot())
  }
})

describe("a GPU SPV's returns: the distributable-cash waterfall (waterfallKind 'distributable_cash')", () => {
  const gpuMonths = Array.from({ length: 60 }, (_, i) => `${2027 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`) as any[]
  // The pack's Base case: its distributable cash paid each December, no reserve.
  const december = (k: number) => `${2027 + k}-12`
  const cashIn = m(Object.fromEntries(F1.distributableCents.map((d, k) => [december(k), d])))
  const run = (extra: Record<string, unknown> = {}) => planReturns({
    months: gpuMonths, asOfMonth: '2026-12' as any, openingCash: 0, uncalled: 0, settings: validateCapital({}),
    otherFlows: m({}), invested: m({}), proceeds: cashIn, terminalNav: 0,
    waterfallKind: 'distributable_cash',
    cashWaterfall: { terms: { ...PACK_TERMS, dayCount: '30_360' }, history: [], assumedContribution: { date: '2026-12-31', amount: PACK_INPUTS.capital } },
    ...extra,
  })

  it("reproduces the pack's Base case: to investors, the profit share and IRR 33.6% / 2.02x", () => {
    const r = run()
    r.years.forEach((y, k) => expect(Math.abs(y.toLp - F1.years[k].toLP), `${y.calendarYear}`).toBeLessThanOrEqual(1))
    expect(Math.abs(r.totals.carry - F1.totals.carry)).toBeLessThanOrEqual(1)
    expect(Math.abs(r.lp.distributed - F1.totals.toLP)).toBeLessThanOrEqual(1)
    expect(Math.round(r.lp.irr! * 1000) / 10).toBe(33.6)
    expect(Math.round(r.lp.tvpi! * 100) / 100).toBe(2.02)
    expect(r.lp.called).toBe(0)
  })

  it('values what is left at the end through the waterfall: held back, Y5 still splits as the pack', () => {
    const held = run({ settings: validateCapital({ distributions: { [december(4)]: 0 } }) })
    const endCash = held.cash[held.cash.length - 1].ending
    expect(endCash).toBe(F1.distributableCents[4])
    // Not paid, but valued as if it were: the investors' Y5 is the terminal, the manager's 30% counts.
    expect(Math.abs(held.lp.terminal - F1.years[4].toLP)).toBeLessThanOrEqual(1)
    expect(Math.abs(held.totals.carry - F1.totals.carry)).toBeLessThanOrEqual(1)
    expect(Math.round(held.lp.tvpi! * 100) / 100).toBe(2.02)
  })

  it('replays the books first: a contingency already returned stays capital returned, not profit', () => {
    const history = [
      { kind: 'contribution' as const, date: '2026-12-31', lpEntityId: 'lp1', amount: PACK_INPUTS.capital },
      { kind: 'distribution' as const, date: '2026-12-31', amount: 30_500, contingencyReturn: 30_500 },
    ]
    const r = run({ cashWaterfall: { terms: { ...PACK_TERMS, dayCount: '30_360' }, history } })
    // 30,500 less capital left to return, so that much more reaches the split: a larger profit share.
    expect(r.years[0].toLp).toBe(F1.distributableCents[0])
    expect(r.totals.carry).toBeGreaterThan(F1.totals.carry + 8_000)
    // The history's own flows count: 1,435,500 in, 30,500 back before the plan.
    expect(r.lp.dpi!).toBeCloseTo((30_500 + r.lp.distributed) / PACK_INPUTS.capital, 9)
  })

  it("counts a prior distribution at the investors' share only, not the manager's take already paid", () => {
    // 1,000,000 in on 1 Jan 2026, 1,500,000 out on 31 Dec: the replay gives the investors
    // 1,373,933.33 and the manager 126,066.67 (pref 80,000, capital back, 30% of the rest).
    const r = planReturns({
      months: gpuMonths.slice(0, 12), asOfMonth: '2026-12' as any, openingCash: 0, uncalled: 0, settings: validateCapital({}),
      otherFlows: m({}), invested: m({}), proceeds: m({}), terminalNav: 0, waterfallKind: 'distributable_cash',
      cashWaterfall: {
        terms: { ...PACK_TERMS, dayCount: '30_360' },
        history: [
          { kind: 'contribution', date: '2026-01-01', lpEntityId: 'lp1', amount: 1_000_000 },
          { kind: 'distribution', date: '2026-12-31', amount: 1_500_000 },
        ],
      },
    })
    expect(r.lp.dpi).toBeCloseTo(1.37393333, 8)
    expect(Math.round(r.lp.dpi! * 1000) / 1000).toBe(1.374)
  })

  it("leaves the manager's historical take out of the investors' flows (zero pref, 30% split)", () => {
    // $100 in, $200 out before the plan: $100 back as capital, the $100 profit split 70/30 — the
    // investors had $170, so DPI 1.7, not 2.0.
    const r = planReturns({
      months: gpuMonths.slice(0, 12), asOfMonth: '2026-12' as any, openingCash: 0, uncalled: 0, settings: validateCapital({}),
      otherFlows: m({}), invested: m({}), proceeds: m({}), terminalNav: 0, waterfallKind: 'distributable_cash',
      cashWaterfall: {
        terms: { ...PACK_TERMS, prefRate: 0, dayCount: '30_360' },
        history: [
          { kind: 'contribution', date: '2026-01-01', lpEntityId: 'lp1', amount: 100 },
          { kind: 'distribution', date: '2026-06-30', amount: 200 },
        ],
      },
    })
    expect(r.lp.dpi).toBeCloseTo(1.7, 12)
    expect(r.lp.tvpi).toBeCloseTo(1.7, 12)
  })

  it('pays a released contingency before the tiers, as the engine does (R8)', () => {
    const terms = { ...PACK_TERMS, dayCount: '30_360' as const }
    const history = [{ kind: 'contribution' as const, date: '2026-12-31', lpEntityId: 'lp1', amount: 1_000_000 }]
    const r = planReturns({
      months: gpuMonths.slice(0, 12), asOfMonth: '2026-12' as any, openingCash: 0, uncalled: 0, settings: validateCapital({}),
      otherFlows: m({}), invested: m({}), proceeds: m({ '2027-01': 50_000, '2027-12': 2_000_000 }), terminalNav: 0, waterfallKind: 'distributable_cash',
      cashWaterfall: { terms, history, contingencyReturns: new Map([['2027-01', 50_000]]) as any },
    })
    // The engine, by hand: the January 50,000 is all contingency, so no pref is paid and it carries forward.
    let state = contribute(emptyState('2026-12-31'), history[0])
    const jan = distribute(state, 50_000, '2027-01-31', terms, undefined, { contingencyReturn: 50_000 })
    state = jan.state
    const dec = distribute(state, 2_000_000, '2027-12-31', terms)
    expect(jan.tiers).toMatchObject({ contingencyReturn: 50_000, preferred: 0 })
    expect(r.totals.carry).toBe(Math.round((jan.tiers.toGP + dec.tiers.toGP) * 100) / 100)
    expect(r.lp.distributed).toBe(Math.round((jan.tiers.toLP + dec.tiers.toLP) * 100) / 100)
  })

  it('the fund kinds ignore cashWaterfall unless the kind says distributable_cash', () => {
    const vc = { ...run(), warnings: [] }
    const asFund = planReturns({
      months: gpuMonths, asOfMonth: '2026-12' as any, openingCash: 0, uncalled: 0, settings: validateCapital({}),
      otherFlows: m({}), invested: m({}), proceeds: cashIn, terminalNav: 0,
      cashWaterfall: { terms: PACK_TERMS, history: [] },
    })
    expect(asFund.totals.carry).toBe(0)
    expect(asFund.lp.distributed).not.toBe(vc.lp.distributed)
  })
})
