import { describe, it, expect } from 'vitest'
import {
  carryTarget, carryAccrual, preferredTarget, loadCarryTerms, lpEconomicsFromAccounts, NO_CARRY,
  type VehicleCarryTerms,
} from './carry'
import { computeCapitalAccounts, type CapitalPosting } from './capital-account'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

const straight = (rate = 0.2): VehicleCarryTerms => ({
  ...NO_CARRY, kind: 'straight', carryRate: rate,
})
const european = (over: Partial<VehicleCarryTerms> = {}): VehicleCarryTerms => ({
  ...NO_CARRY, kind: 'european', carryRate: 0.2, prefRate: 0.08, catchupRate: 1, prefCompounds: true, ...over,
})
const american = (rate = 0.2): VehicleCarryTerms => ({ ...NO_CARRY, kind: 'american', carryRate: rate })

/** `nav` is net of `carryBorne`, as the capital account holds it. */
const lp = (id: string, contributed: number, nav: number, distributed = 0, carryBorne = 0) =>
  ({ lpEntityId: id, contributed, distributed, nav, carryBorne })

describe('carryTarget', () => {
  it('is zero when the vehicle has no carry terms', () => {
    expect(carryTarget({ lps: [lp('a', 1_000_000, 3_000_000)] }, NO_CARRY)).toBe(0)
  })

  it('accrues on an UNREALIZED gain — that is the whole point', () => {
    // Nothing has been sold. LP capital is marked up 1m → 3m. The GP is still entitled to its
    // share if the fund liquidated today, so the LP's NAV must be shown net of it.
    const target = carryTarget({ lps: [lp('a', 1_000_000, 3_000_000)] }, straight(0.2))
    expect(target).toBe(400_000) // 20% of the 2m profit
  })

  it('is zero when the fund is under water', () => {
    expect(carryTarget({ lps: [lp('a', 1_000_000, 700_000)] }, straight())).toBe(0)
  })

  it('counts distributions already taken as part of the gain', () => {
    // Contributed 1m, took 1.5m out, still holds 1m. Total value 2.5m → profit 1.5m.
    const target = carryTarget({ lps: [lp('a', 1_000_000, 1_000_000, 1_500_000)] }, straight(0.2))
    expect(target).toBe(300_000)
  })

  it('European: no carry until capital and the preferred return are covered', () => {
    // Contributed 1m; NAV 1.05m. Profit is 50k, but the 8% pref on a full year is 80k — the
    // LPs are not yet whole, so the GP gets nothing.
    const target = carryTarget(
      {
        lps: [lp('a', 1_000_000, 1_050_000)],
        contributions: [{ date: '2025-01-01', amount: 1_000_000 }],
        asOf: '2026-01-01',
      },
      european()
    )
    expect(target).toBe(0)
  })

  it('European: the GP catches up once the pref is cleared', () => {
    // A big gain: capital back, pref paid, catch-up runs, then the 80/20 split.
    const target = carryTarget(
      {
        lps: [lp('a', 1_000_000, 3_000_000)],
        contributions: [{ date: '2025-01-01', amount: 1_000_000 }],
        asOf: '2026-01-01',
      },
      european()
    )
    // Total profit 2m; with a full catch-up the GP ends up with ~20% of profit.
    expect(target).toBeGreaterThan(350_000)
    expect(target).toBeLessThanOrEqual(400_000)
  })

  it('American accrues the SAME total as European (clawback equalizes; only timing differs)', () => {
    // The accrual is the GP's as-if-liquidation entitlement, which is identical for the two —
    // American just distributes it earlier during the fund's life. Same inputs, same target.
    const input = { lps: [lp('a', 1_000_000, 3_000_000)], contributions: [{ date: '2020-01-01', amount: 1_000_000 }], asOf: '2026-01-01' }
    const am = carryTarget(input, american(0.2))
    const eu = carryTarget(input, european({ carryRate: 0.2, prefRate: 0.08 }))
    expect(am).toBe(eu)
    expect(am).toBeGreaterThan(0)
  })

  it('American: no carry until whole-fund capital (and pref) is covered, same as European', () => {
    // Fund is under water on a whole-fund basis — neither accrues, even though a single deal
    // inside it might be up (that only affects distribution timing, handled elsewhere).
    const input = { lps: [lp('a', 1_000_000, 900_000)], contributions: [{ date: '2020-01-01', amount: 1_000_000 }], asOf: '2026-01-01' }
    expect(carryTarget(input, american(0.2))).toBe(0)
  })

  it('a straight split ignores the pref entirely', () => {
    const withPref = carryTarget(
      { lps: [lp('a', 1_000_000, 1_050_000)], contributions: [{ date: '2020-01-01', amount: 1_000_000 }], asOf: '2026-01-01' },
      { ...straight(0.2), prefRate: 0.08 }
    )
    // An SPV's 20% of the 50k gain, hurdle or no hurdle.
    expect(withPref).toBe(10_000)
  })
})

describe('preferredTarget', () => {
  it('accrues from the date money was actually wired, not from the commitment', () => {
    const oneYear = preferredTarget([{ date: '2025-01-01', amount: 1_000_000 }], '2026-01-01', 0.08, false)
    expect(oneYear).toBeCloseTo(80_000, -1)
  })

  it('compounds when the terms say it compounds', () => {
    const simple = preferredTarget([{ date: '2024-01-01', amount: 1_000_000 }], '2026-01-01', 0.08, false)
    const compound = preferredTarget([{ date: '2024-01-01', amount: 1_000_000 }], '2026-01-01', 0.08, true)
    expect(compound).toBeGreaterThan(simple)
  })

  it('accrues nothing on a contribution made after the accrual date', () => {
    expect(preferredTarget([{ date: '2027-01-01', amount: 1_000_000 }], '2026-01-01', 0.08, true)).toBe(0)
  })

  it('is zero when there is no hurdle', () => {
    expect(preferredTarget([{ date: '2020-01-01', amount: 1_000_000 }], '2026-01-01', 0, true)).toBe(0)
  })
})

describe('carryAccrual', () => {
  it('posts only the DELTA against the carry the LP has already borne', () => {
    // Gross NAV 3m, 100k already borne, so the capital account reads 2.9m.
    const input = { lps: [lp('a', 1_000_000, 2_900_000, 0, 100_000)] }
    const a = carryAccrual(input, straight(0.2), 100_000)
    expect(a.target).toBe(400_000)
    expect(a.delta).toBe(300_000) // top up, not re-post the whole thing
    expect(a.perLp.get('a')).toBe(300_000)
  })

  it('measures the target on NAV GROSS of the carry already borne', () => {
    // 400k borne on a 3m gross NAV. Netting it would make the target 20% × (2.6m − 1m) = 320k
    // and reverse 80k that nothing economic justified.
    const a = carryAccrual({ lps: [lp('a', 1_000_000, 2_600_000, 0, 400_000)] }, straight(0.2), 400_000)
    expect(a.target).toBe(400_000)
  })

  it('REVERSES when NAV falls — no clawback logic needed', () => {
    // Last period gross NAV was 3m, so 400k was accrued. This period the mark drops to 1.5m
    // gross (1.1m net of carry): the target is now 100k, so 300k comes back to the LP.
    const a = carryAccrual({ lps: [lp('a', 1_000_000, 1_100_000, 0, 400_000)] }, straight(0.2), 400_000)
    expect(a.target).toBe(100_000)
    expect(a.delta).toBe(-300_000)
    expect(a.perLp.get('a')).toBe(-300_000) // credited back to the LP
  })

  it('unwinds fully when the gain disappears entirely', () => {
    // 400k accrued at a 3m mark; the mark falls to 900k gross (500k net). Nobody is in profit,
    // so the target is zero and every cent of the accrual goes back to the LP that bore it.
    const a = carryAccrual({ lps: [lp('a', 1_000_000, 500_000, 0, 400_000)] }, straight(0.2), 400_000)
    expect(a.target).toBe(0)
    expect(a.delta).toBe(-400_000)
    expect(a.perLp.get('a')).toBe(-400_000)
  })

  it('shares the carry across LPs in proportion to their gains, not their capital', () => {
    // Same contribution, very different outcomes. The LP sitting on a loss pays no carry.
    const a = carryAccrual(
      {
        lps: [
          lp('winner', 1_000_000, 3_000_000), // +2m
          lp('loser', 1_000_000, 500_000),    // -500k
        ],
      },
      straight(0.2),
      0
    )
    // Fund profit = 2m + (-500k) = 1.5m → target 300k. Only the winner has a gain to take it from.
    expect(a.target).toBe(300_000)
    expect(a.perLp.get('winner')).toBe(300_000)
    expect(a.perLp.has('loser')).toBe(false)
  })

  it('splits pro-rata to gain across several LPs in profit', () => {
    const a = carryAccrual(
      { lps: [lp('a', 1_000_000, 3_000_000), lp('b', 1_000_000, 2_000_000)] }, // +2m and +1m
      straight(0.2),
      0
    )
    expect(a.target).toBe(600_000) // 20% of 3m
    expect(a.perLp.get('a')).toBe(400_000) // 2/3
    expect(a.perLp.get('b')).toBe(200_000) // 1/3
  })

  it('hands an LP back all its carry when it falls under water while another is still in profit', () => {
    // Close 1: A +2m, B +1m → 600k accrued, A bore 400k and B 200k.
    // Close 2: A is marked to 800k gross (−200k), B to 2.5m gross (+1.5m). Fund profit 1.3m →
    // target 260k, all of it B's. A gets its 400k back; B tops up 60k.
    const a = carryAccrual(
      { lps: [lp('a', 1_000_000, 400_000, 0, 400_000), lp('b', 1_000_000, 2_300_000, 0, 200_000)] },
      straight(0.2),
      600_000
    )
    expect(a.target).toBe(260_000)
    expect(a.perLp.get('a')).toBe(-400_000)
    expect(a.perLp.get('b')).toBe(60_000)
    expect(a.delta).toBe(-340_000) // = target − already accrued
  })

  it('per-LP debits sum EXACTLY to the delta, with no invented cents', () => {
    // Deliberately awkward: three LPs, an amount that doesn't divide cleanly, uneven borne carry.
    const a = carryAccrual(
      {
        lps: [
          lp('a', 100_000, 199_999.98, 0, 0.03),
          lp('b', 100_000, 200_000.00, 0, 0.01),
          lp('c', 100_000, 199_990.01, 0, 10.00),
        ],
      },
      straight(0.2),
      10.04
    )
    const sum = Math.round(Array.from(a.perLp.values()).reduce((s, v) => s + v, 0) * 100) / 100
    expect(sum).toBe(a.delta)
    expect(a.delta).toBe(Math.round((a.target - 10.04) * 100) / 100)
  })

  it('does nothing when every LP already bears its share of the target', () => {
    const a = carryAccrual({ lps: [lp('a', 1_000_000, 2_600_000, 0, 400_000)] }, straight(0.2), 400_000)
    expect(a.delta).toBe(0)
    expect(a.perLp.size).toBe(0)
  })

  it('posts nothing on a re-close of an awkward split, once the first accrual has landed', () => {
    // Largest-remainder puts the odd cent on the same LP for the same inputs, so applying the
    // first result and accruing again is a no-op — no cent shuffles between LPs.
    const before = [lp('a', 100_000, 200_000.01), lp('b', 100_000, 200_000.01), lp('c', 100_000, 200_000.01)]
    const first = carryAccrual({ lps: before }, straight(0.2), 0)
    expect(first.perLp.size).toBe(3)
    const after = before.map(l => {
      const borne = first.perLp.get(l.lpEntityId) ?? 0
      return { ...l, nav: Math.round((l.nav - borne) * 100) / 100, carryBorne: borne }
    })
    const second = carryAccrual({ lps: after }, straight(0.2), first.delta)
    expect(second.delta).toBe(0)
    expect(second.perLp.size).toBe(0)
    // The ledger read has no fixed row order: the odd cent must not follow it.
    for (const order of [[2, 0, 1], [1, 2, 0], [2, 1, 0]]) {
      const again = carryAccrual({ lps: order.map(i => after[i]) }, straight(0.2), first.delta)
      expect(again.perLp.size).toBe(0)
    }
  })
})

describe('the carry accrual across consecutive closes, from the ledger', () => {
  // The capital postings a close sees, run through the same mapping accrueCarry uses. Capital
  // accounts are credit-normal, so a posting of −x adds x to the partner's capital.
  const at = (lpEntityId: string, capitalDelta: number, sourceType: string, entryDate: string): CapitalPosting =>
    ({ lpEntityId, amount: -capitalDelta, sourceType, entryDate })
  const recipients = new Set(['gp'])

  /** Accrue as the close does (to the sole recipient `gp`), and return the accrual plus the
   *  postings it would book. */
  function close(postings: CapitalPosting[], date: string, gp = 'gp') {
    const terms: VehicleCarryTerms = { ...straight(0.2), recipients: [{ lpEntityId: gp, pct: 100 }] }
    const accounts = computeCapitalAccounts(postings)
    const alreadyAccrued = Math.round((accounts.get(gp)?.carriedInterest ?? 0) * 100) / 100
    const accrual = carryAccrual({ lps: lpEconomicsFromAccounts(accounts, new Set([gp])) }, terms, alreadyAccrued)
    const booked = [
      ...Array.from(accrual.perLp, ([id, amt]) => at(id, -amt, 'carried_interest', date)),
      ...(accrual.delta !== 0 ? [at(gp, accrual.delta, 'carried_interest', date)] : []),
    ]
    return { accrual, booked }
  }

  it('maps capital accounts to LP economics: recipients out, borne carry positive', () => {
    const accounts = computeCapitalAccounts([
      at('a', 1_000_000, 'capital_call', '2026-01-01'),
      at('a', -250_000, 'distribution', '2026-02-01'),
      at('a', -100_000, 'carried_interest', '2026-03-31'),
      at('gp', 100_000, 'carried_interest', '2026-03-31'),
    ])
    expect(lpEconomicsFromAccounts(accounts, recipients)).toEqual([
      { lpEntityId: 'a', contributed: 1_000_000, distributed: 250_000, nav: 650_000, carryBorne: 100_000 },
    ])
  })

  it('a former recipient is measured on its own position, its earned carry left out', () => {
    const accounts = computeCapitalAccounts([
      at('gp', 50_000, 'capital_call', '2026-01-01'),
      at('gp', 200_000, 'carried_interest', '2026-03-31'),
    ])
    expect(lpEconomicsFromAccounts(accounts, new Set(['gp2']))).toEqual([
      { lpEntityId: 'gp', contributed: 50_000, distributed: 0, nav: 50_000, carryBorne: 0 },
    ])
  })

  it('replacing the recipient leaves the old one its carry, and only the new one takes the rise', () => {
    // Close 1 accrues 200k to gp. The recipient then changes to gp2 with nothing else changed:
    // nothing posts — the old recipient's 200k is not clawed back to the new one.
    const ledger = [at('a', 1_000_000, 'capital_call', '2026-01-15'), at('a', 1_000_000, 'valuation', '2026-03-31')]
    const first = close(ledger, '2026-03-31')
    expect(first.accrual.delta).toBe(200_000)

    const switched = close([...ledger, ...first.booked], '2026-06-30', 'gp2')
    expect(switched.accrual.perLp.size).toBe(0)
    expect(switched.accrual.delta).toBe(0)

    // Then a 500k rise: target 300k, the LP tops up 100k, and only gp2 is credited.
    const risen = [...ledger, ...first.booked, at('a', 500_000, 'valuation', '2026-09-30')]
    const third = close(risen, '2026-09-30', 'gp2')
    expect(third.accrual.target).toBe(300_000)
    expect(Array.from(third.accrual.perLp)).toEqual([['a', 100_000]])
    const after = computeCapitalAccounts([...risen, ...third.booked])
    expect(after.get('gp')!.carriedInterest).toBe(200_000)
    expect(after.get('gp2')!.carriedInterest).toBe(100_000)
    expect(after.get('a')!.carriedInterest).toBe(-300_000)
  })

  it('a second close with nothing changed posts nothing', () => {
    // Contributed 1m, marked to 2m pre-carry. Close 1 accrues 200k. Measuring close 2 on the
    // LP's 1.8m net-of-carry NAV used to give a 160k target and post −40k.
    const ledger = [at('a', 1_000_000, 'capital_call', '2026-01-15'), at('a', 1_000_000, 'valuation', '2026-03-31')]
    const first = close(ledger, '2026-03-31')
    expect(first.accrual.delta).toBe(200_000)
    expect(first.accrual.perLp.get('a')).toBe(200_000)

    const second = close([...ledger, ...first.booked], '2026-06-30')
    expect(second.accrual.target).toBe(200_000)
    expect(second.accrual.delta).toBe(0)
    expect(second.accrual.perLp.size).toBe(0)
  })

  it('reverses the whole accrual when the mark falls below cost', () => {
    // Close 1 at a 3m pre-carry NAV accrues 400k (LP ending 2.6m). The mark then falls to 900k
    // pre-carry: nobody is in profit, so all 400k returns and the LP ends at 900k.
    const ledger = [at('a', 1_000_000, 'capital_call', '2026-01-15'), at('a', 2_000_000, 'valuation', '2026-03-31')]
    const first = close(ledger, '2026-03-31')
    expect(first.accrual.delta).toBe(400_000)

    const fallen = [...ledger, ...first.booked, at('a', -2_100_000, 'valuation', '2026-06-30')]
    expect(computeCapitalAccounts(fallen).get('a')!.ending).toBe(500_000)
    const second = close(fallen, '2026-06-30')
    expect(second.accrual.target).toBe(0)
    expect(second.accrual.delta).toBe(-400_000)
    expect(second.accrual.perLp.get('a')).toBe(-400_000)

    const after = computeCapitalAccounts([...fallen, ...second.booked])
    expect(after.get('a')!.ending).toBe(900_000)
    expect(after.get('gp')!.ending).toBe(0)
  })
})

describe('loadCarryTerms', () => {
  const vehicles = { fund_vehicles: [{ id: 'v1', fund_id: 'f', name: 'Fund I' }] }

  it('rejects on a failed read instead of reading as no carry', async () => {
    // NO_CARRY on a failed read closed the period with no accrual — and the books still balanced.
    const m = memoryAdmin({
      ...vehicles,
      vehicle_waterfall_terms: [{ fund_id: 'f', vehicle_id: 'v1', kind: 'straight', carry_rate: 0.2, gp_entity_id: 'gp' }],
    })
    m.failNext('vehicle_waterfall_terms', 'select', 'boom')
    await expect(loadCarryTerms(m.admin, 'f', 'Fund I')).rejects.toThrow(/boom/)
    expect((await loadCarryTerms(m.admin, 'f', 'Fund I')).kind).toBe('straight')
  })

  it('is NO_CARRY when the vehicle has no terms row', async () => {
    expect(await loadCarryTerms(memoryAdmin(vehicles).admin, 'f', 'Fund I')).toEqual(NO_CARRY)
  })
})
