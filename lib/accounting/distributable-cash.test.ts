import { describe, it, expect } from 'vitest'
import { NO_CARRY, loadCarryTerms, type VehicleCarryTerms } from './carry'
import { splitDistribution, suggestedCharacter } from './distribution-waterfall'
import { loadWaterfallHistory } from './distributions'
import type { CapitalPosting } from './capital-account'
import { distributionTierLines } from './notice-types'
import { contribute, distribute, emptyState, type CashDistribution } from '@/lib/gpu/waterfall'
import { F1, F8, PACK_INPUTS, PACK_TERMS } from '@/lib/gpu/fixtures/pack-v3'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

const LP = 'lp'
const MGR = 'mgr'
const CAPITAL = PACK_INPUTS.capital
const cash = (over: Partial<VehicleCarryTerms> = {}): VehicleCarryTerms => ({
  ...NO_CARRY, kind: 'distributable_cash', carryRate: 0.3, prefRate: 0.08, catchupRate: 1, prefCompounds: false,
  gpEntityId: MGR, recipients: [{ lpEntityId: MGR, pct: 100 }], prefBasis: 'unreturned', prefDayCount: '30_360', rocLpShare: 1, ...over,
})

// Capital accounts are credit-normal: a contribution credits capital (negative posting).
const at = (lpEntityId: string, amount: number, sourceType: string, entryDate: string): CapitalPosting =>
  ({ lpEntityId, amount, sourceType, entryDate })

/** The F1 Base case on the pack's annual cadence, straight from the engine. */
function engineF1(): CashDistribution[] {
  let state = contribute(emptyState(F8.contributionDate), { kind: 'contribution', date: F8.contributionDate, lpEntityId: LP, amount: CAPITAL })
  return F1.distributableCents.map((D, k) => {
    const r = distribute(state, D, F8.distributionDates[k], { ...PACK_TERMS, recipients: [{ lpEntityId: MGR, pct: 100 }] }, 1)
    state = r.state
    return r
  })
}

/** The books before distribution k: the call, then each earlier distribution as declared. */
function postingsBefore(k: number, engine: CashDistribution[]): CapitalPosting[] {
  const out = [at(LP, -CAPITAL, 'capital_call', F8.contributionDate)]
  for (let j = 0; j < k; j++) {
    out.push(at(LP, engine[j].tiers.toLP, 'distribution', F8.distributionDates[j]))
    if (engine[j].tiers.toGP > 0) out.push(at(MGR, engine[j].tiers.toGP, 'carry_distribution', F8.distributionDates[j]))
  }
  return out
}

function splitAt(k: number, engine: CashDistribution[], terms = cash(), extra: { contingencyReturn?: number } = {}) {
  const date = F8.distributionDates[k]
  const h = loadWaterfallHistory(postingsBefore(k, engine), new Set([MGR]), date)
  return splitDistribution({ total: F1.distributableCents[k], terms, ...h, asOf: date, carryPaidToDate: h.carryPaidToDate, ...extra })
}

describe('splitDistribution: distributable_cash', () => {
  it('replays the declared history and reproduces F1 to the cent, year by year', () => {
    const engine = engineF1()
    engine.forEach((e, k) => {
      const split = splitAt(k, engine)
      expect(split.method).toBe('waterfall')
      expect(split.warnings).toEqual([])
      expect(split.tiers).toEqual({
        returnOfCapital: e.tiers.returnOfCapital, preferred: e.tiers.preferred, catchUp: 0, carry: e.tiers.carry,
        profitToLP: e.tiers.profitToLP, toLP: e.tiers.toLP, toGP: e.tiers.toGP, contingencyReturn: 0,
      })
      expect(split.cash).toEqual({
        prefDue: e.tiers.prefDue, prefCarriedForward: e.tiers.prefCarriedForward, unreturnedAfter: e.tiers.unreturnedAfter,
        profitToLP: e.tiers.profitToLP, managerRocShare: e.tiers.managerRocShare, contingencyReturn: 0,
      })
      expect(split.lines).toEqual([{ lpEntityId: LP, amount: e.tiers.toLP }])
      expect(split.carryLines).toEqual(e.carryLines)
    })
    const y3 = splitAt(2, engine)
    expect(y3.tiers).toMatchObject({ preferred: F1.y3Cents.pref, returnOfCapital: F1.y3Cents.roc, carry: F1.y3Cents.carry, profitToLP: F1.y3Cents.profitToLP })
    expect(y3.stateBefore).toMatchObject({ contributedCapital: CAPITAL, returnedCapital: 1_302_921.04, gpCarryPaid: 0 })
    expect(y3.stateAfter.gpCarryPaid).toBe(F1.y3Cents.carry)
  })

  it('applies a contribution before a distribution on the same date', () => {
    const terms = cash()
    const split = splitDistribution({
      total: 50, terms,
      partners: [{ lpEntityId: LP, contributed: 100, distributed: 0, ending: 100 }],
      contributions: [{ date: '2027-01-01', amount: 100, lpEntityId: LP }],
      priors: [{ date: '2027-01-01', amount: 30 }],
      asOf: '2027-01-01',
    })
    // The prior 30 found the 100 already contributed and returned 30 of it.
    expect(split.stateBefore).toMatchObject({ contributedCapital: 100, returnedCapital: 30 })
    expect(split.tiers.returnOfCapital).toBe(50)
    expect(split.cash?.unreturnedAfter).toBe(20)
  })

  it('passes the contingency through ahead of the tiers, and the K-1 suggestion counts it as capital', () => {
    const engine = engineF1()
    const split = splitAt(2, engine, cash(), { contingencyReturn: 50_000 })
    expect(split.tiers.contingencyReturn).toBe(50_000)
    expect(split.cash?.contingencyReturn).toBe(50_000)
    expect(split.tiers.returnOfCapital).toBe(82_578.96)
    expect(suggestedCharacter(split.tiers, F1.distributableCents[2]).returnOfCapital).toBe(132_578.96)
  })

  it('warns when the books show different carry paid than the replay implies', () => {
    const engine = engineF1()
    const date = F8.distributionDates[3]
    const h = loadWaterfallHistory(postingsBefore(3, engine), new Set([MGR]), date)
    const split = splitDistribution({ total: F1.distributableCents[3], terms: cash(), ...h, asOf: date, carryPaidToDate: 1 })
    expect(split.warnings.join(' ')).toMatch(/profit share paid to date/)
  })

  it.each<[string, Partial<VehicleCarryTerms>, RegExp]>([
    ['a compounding pref', { prefCompounds: true }, /simple/],
    ['a stored periodic day count', { prefDayCount: 'periodic' }, /periodic/],
    ['no recipient', { recipients: [] }, /receives the profit share/],
  ])('falls back to pro-rata, saying why, on %s', (_, over, why) => {
    const split = splitDistribution({
      total: 100, terms: cash(over),
      partners: [{ lpEntityId: LP, contributed: 100, distributed: 0, ending: 100 }],
      contributions: [{ date: '2027-01-01', amount: 100, lpEntityId: LP }],
      priors: [], asOf: '2027-06-30',
    })
    expect(split.method).toBe('pro_rata')
    expect(split.cash).toBeUndefined()
    expect(split.warnings[0]).toMatch(why)
    expect(split.warnings[0]).toMatch(/pro-rata/)
  })

  it('falls back when a contribution names no investor', () => {
    const split = splitDistribution({
      total: 100, terms: cash(),
      partners: [{ lpEntityId: LP, contributed: 100, distributed: 0, ending: 100 }],
      contributions: [{ date: '2027-01-01', amount: 100 }],
      priors: [], asOf: '2027-06-30',
    })
    expect(split.method).toBe('pro_rata')
    expect(split.warnings[0]).toMatch(/no investor named/)
  })
})

describe('loadWaterfallHistory', () => {
  it('names each contribution, totals priors per date including carry, and counts carry paid', () => {
    const h = loadWaterfallHistory([
      at('a', -600, 'capital_call', '2027-01-01'), at('b', -400, 'capital_call', '2027-01-01'),
      at('a', 60, 'distribution', '2028-01-01'), at('b', 40, 'distribution', '2028-01-01'), at(MGR, 30, 'carry_distribution', '2028-01-01'),
      at('a', 999, 'distribution', '2030-01-01'),
    ], new Set([MGR]), '2029-01-01')
    expect(h.contributions).toEqual([
      { date: '2027-01-01', amount: 600, lpEntityId: 'a' }, { date: '2027-01-01', amount: 400, lpEntityId: 'b' },
    ])
    expect(h.priors).toEqual([{ date: '2028-01-01', amount: 130 }])
    expect(h.carryPaidToDate).toBe(30)
    expect(h.partners.find(p => p.lpEntityId === 'a')).toMatchObject({ contributed: 600, distributed: 60, ending: 540 })
  })
})

describe('loadCarryTerms: distributable_cash', () => {
  it('maps the kind and the three columns', async () => {
    const m = memoryAdmin({
      fund_vehicles: [{ id: 'v1', fund_id: 'f', name: 'GPU I' }],
      vehicle_waterfall_terms: [{
        fund_id: 'f', vehicle_id: 'v1', kind: 'distributable_cash', carry_rate: 0.3, pref_rate: 0.08, catchup_rate: 1,
        pref_compounds: false, gp_entity_id: MGR, pref_basis: 'unreturned', pref_day_count: 'act_365', roc_lp_share: 0.9,
      }],
    })
    expect(await loadCarryTerms(m.admin, 'f', 'GPU I')).toEqual(cash({ prefDayCount: 'act_365', rocLpShare: 0.9 }))
  })

  it('a fund row without the columns reads the defaults', async () => {
    const m = memoryAdmin({
      fund_vehicles: [{ id: 'v1', fund_id: 'f', name: 'Fund I' }],
      vehicle_waterfall_terms: [{ fund_id: 'f', vehicle_id: 'v1', kind: 'european', carry_rate: 0.2, pref_rate: 0.08, gp_entity_id: 'gp' }],
    })
    expect(await loadCarryTerms(m.admin, 'f', 'Fund I')).toMatchObject({ kind: 'european', prefBasis: 'contributed', prefDayCount: '30_360', rocLpShare: 1 })
  })
})

describe('distributionTierLines (the notice)', () => {
  it('a fund notice keeps exactly its two rows', () => {
    expect(distributionTierLines({ returnOfCapital: 600, preferred: 40, lpTotal: 1_000 }, 250)).toEqual([
      { label: 'Of which return of capital', value: 150 },
      { label: 'Of which preferred return', value: 10 },
    ])
    expect(distributionTierLines({ returnOfCapital: 600, preferred: 0, lpTotal: 1_000 }, 250)).toEqual([
      { label: 'Of which return of capital', value: 150 },
    ])
    expect(distributionTierLines({ returnOfCapital: 600, preferred: 40, lpTotal: 0 }, 250)).toEqual([])
  })

  it('a GPU SPV notice shows the cash tiers, and the contingency only when there is one', () => {
    const tiers = { returnOfCapital: 132_578.96, preferred: 10_606.32, lpTotal: 507_308.63, cash: { contingencyReturn: 0, profitToLP: 364_123.35, unreturnedAfter: 0, prefCarriedForward: 0 } }
    expect(distributionTierLines(tiers, 507_308.63).map(r => r.label)).toEqual([
      'Preferred return', 'Return of capital', 'Profit share', 'Unreturned capital after this distribution', 'Unpaid preferred return carried forward',
    ])
    const withContingency = distributionTierLines({ ...tiers, cash: { ...tiers.cash, contingencyReturn: 1_000 } }, 507_308.63)
    expect(withContingency[0]).toEqual({ label: 'Return of unspent contingency', value: 1_000 })
  })
})
