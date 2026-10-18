import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'
import type { CapitalPosting } from '@/lib/accounting/capital-account'

// Previewing and declaring a GPU SPV's distribution on capital postings: the F1 tiers to the cent,
// the reserve, the frozen wf_* columns, and the profit share realised at declaration (R4).

const s = vi.hoisted(() => ({ m: null as any, postings: [] as any[], entries: [] as any[], failOnCall: 0, calls: 0 }))
vi.mock('@/lib/accounting/vehicle-id', () => ({ vehicleIdByName: async () => 'v1' }))
vi.mock('@/lib/accounting/provision-accounts', () => ({ ensureVehicleAccounts: async () => undefined }))
vi.mock('@/lib/accounting/capital-source', () => ({ loadCapitalPostings: async () => ({ postings: s.postings }) }))
vi.mock('@/lib/accounting/load', async orig => ({ ...(await orig<any>()), loadEntityNames: async () => new Map([['lp', 'Investor'], ['mgr', 'Manager']]) }))
vi.mock('@/lib/accounting/persist', () => ({
  accountIdByCode: async () => new Map([['2300', 'payable']]),
  ensureCapitalAccounts: async (_a: unknown, _f: string, _g: string, ids: string[]) => new Map(ids.map(id => [id, `cap-${id}`])),
  persistEntry: async (_a: unknown, _f: string, _g: string, _u: unknown, entry: any, status: string) => {
    if (++s.calls === s.failOnCall) return { error: 'persist failed' }
    const id = `entry-${s.entries.length + 1}`
    s.entries.push({ id, status, ...entry })
    return { entryId: id }
  },
}))

import { previewDistribution, declareDistribution, listDistributions } from '@/lib/accounting/distributions'
import { computeCapitalAccounts } from '@/lib/accounting/capital-account'
import { contribute, distribute, emptyState, type CashDistribution } from '@/lib/gpu/waterfall'
import { F1, F8, PACK_INPUTS, PACK_TERMS } from '@/lib/gpu/fixtures/pack-v3'

const CAPITAL = PACK_INPUTS.capital
const at = (lpEntityId: string, amount: number, sourceType: string, entryDate: string): CapitalPosting => ({ lpEntityId, amount, sourceType, entryDate })
const cashTerms = { fund_id: 'f', vehicle_id: 'v1', kind: 'distributable_cash', carry_rate: 0.3, pref_rate: 0.08, catchup_rate: 1, pref_compounds: false, gp_entity_id: 'mgr', pref_basis: 'unreturned', pref_day_count: '30_360', roc_lp_share: 1 }

function engineF1(): CashDistribution[] {
  let state = contribute(emptyState(F8.contributionDate), { kind: 'contribution', date: F8.contributionDate, lpEntityId: 'lp', amount: CAPITAL })
  return F1.distributableCents.map((D, k) => {
    const r = distribute(state, D, F8.distributionDates[k], { ...PACK_TERMS, recipients: [{ lpEntityId: 'mgr', pct: 100 }] }, 1)
    state = r.state
    return r
  })
}
function postingsBefore(k: number, engine: CashDistribution[]): CapitalPosting[] {
  const out = [at('lp', -CAPITAL, 'capital_call', F8.contributionDate)]
  for (let j = 0; j < k; j++) {
    out.push(at('lp', engine[j].tiers.toLP, 'distribution', F8.distributionDates[j]))
    if (engine[j].tiers.toGP > 0) {
      // As declared under R4: the carry paid, and the realisation that funds it from the investor.
      out.push(at('mgr', engine[j].tiers.toGP, 'carry_distribution', F8.distributionDates[j]))
      out.push(at('lp', engine[j].tiers.toGP, 'carried_interest', F8.distributionDates[j]))
      out.push(at('mgr', -engine[j].tiers.toGP, 'carried_interest', F8.distributionDates[j]))
    }
  }
  return out
}

function admin(terms: Record<string, unknown> | null = cashTerms, distributions: any[] = []) {
  const m = memoryAdmin({ vehicle_waterfall_terms: terms ? [terms] : [], distributions })
  const rpc = vi.fn(async (name: string, args: any) => {
    if (name === 'complete_capital_operation') {
      const row = m.tables.distributions.find((d: any) => d.id === args.p_register_id)!
      row.status = 'declared'
      row.distribution_lines = args.p_lines.map((l: any, i: number) => ({ id: `line-${i}`, lp_entity_id: l.lpEntityId, amount: l.amount, role: l.role }))
    }
    return { error: null }
  })
  ;(m.admin as any).rpc = rpc
  return { m, rpc }
}

beforeEach(() => { s.entries = []; s.postings = []; s.failOnCall = 0; s.calls = 0 })

describe('previewDistribution: distributable_cash', () => {
  it('reproduces F1 on the declared history, every year, to the cent', async () => {
    const engine = engineF1()
    for (let k = 0; k < 5; k++) {
      s.postings = postingsBefore(k, engine)
      const { m } = admin()
      const D = F1.distributableCents[k]
      const p = await previewDistribution(m.admin, 'f', 'GPU I', NaN, F8.distributionDates[k], 'waterfall', { available: D + 25_000, reserve: 25_000 })
      if ('error' in p) throw new Error(p.error)
      expect(p.distributable).toBe(D)
      expect(p.tiers).toMatchObject({ preferred: engine[k].tiers.preferred, returnOfCapital: engine[k].tiers.returnOfCapital, carry: engine[k].tiers.carry, profitToLP: engine[k].tiers.profitToLP, toGP: engine[k].tiers.toGP })
      expect(p.cash).toMatchObject({ prefDue: engine[k].tiers.prefDue, unreturnedAfter: engine[k].tiers.unreturnedAfter })
      expect(p.warnings).toEqual([])
      expect(p).toMatchObject({ available: D + 25_000, reserve: 25_000, lastReserve: null, terms: { kind: 'distributable_cash', prefBasis: 'unreturned', prefDayCount: '30_360', rocLpShare: 1 } })
    }
  })

  it.each([
    ['no reserve', { available: 1_000 }],
    ['a negative reserve', { available: 1_000, reserve: -1 }],
    ['a reserve equal to the cash', { available: 1_000, reserve: 1_000 }],
    ['no available cash', { reserve: 0 }],
    ['a contingency above the distribution', { available: 1_000, reserve: 0, contingencyReturn: 1_001 }],
  ])('refuses %s', async (_, opts) => {
    s.postings = postingsBefore(0, engineF1())
    const { m } = admin()
    expect(await previewDistribution(m.admin, 'f', 'GPU I', 500, '2028-01-01', 'waterfall', opts)).toHaveProperty('error')
  })

  it('offers the newest declared reserve as the default', async () => {
    s.postings = postingsBefore(1, engineF1())
    const { m } = admin(cashTerms, [
      { id: 'd1', fund_id: 'f', vehicle_id: 'v1', status: 'declared', distribution_date: '2028-01-01', reserve_amount: 12_000 },
      { id: 'd0', fund_id: 'f', vehicle_id: 'v1', status: 'declared', distribution_date: '2027-06-30', reserve_amount: 5_000 },
      { id: 'dx', fund_id: 'f', vehicle_id: 'v1', status: 'draft', distribution_date: '2028-06-30', reserve_amount: 99 },
    ])
    const p = await previewDistribution(m.admin, 'f', 'GPU I', NaN, '2029-01-01', 'waterfall', { available: 100_000, reserve: 12_000 })
    expect(p).toMatchObject({ lastReserve: 12_000 })
  })

  it('a fund vehicle still takes a total, and its preview has no cash fields', async () => {
    s.postings = [at('a', -1_000, 'capital_call', '2026-01-01')]
    const { m } = admin({ fund_id: 'f', vehicle_id: 'v1', kind: 'european', carry_rate: 0.2, pref_rate: 0.08, gp_entity_id: 'gp' })
    const p = await previewDistribution(m.admin, 'f', 'Fund I', 500, '2026-06-30')
    expect(p).not.toHaveProperty('error')
    for (const k of ['available', 'reserve', 'distributable', 'lastReserve', 'cash']) expect(p).not.toHaveProperty(k)
    expect(Object.keys((p as any).terms)).toEqual(['kind', 'carryRate', 'prefRate', 'recipients'])
    expect(await previewDistribution(m.admin, 'f', 'Fund I', 0, '2026-06-30')).toEqual({ error: 'A positive total is required' })
  })
})

describe('declareDistribution: distributable_cash', () => {
  async function declareY3() {
    const engine = engineF1()
    s.postings = postingsBefore(2, engine)
    const { m, rpc } = admin()
    const p = await previewDistribution(m.admin, 'f', 'GPU I', NaN, F8.distributionDates[2], 'waterfall', { available: 670_000, reserve: 670_000 - F1.distributableCents[2] })
    if ('error' in p) throw new Error(p.error)
    const input = {
      requestKey: 'y3', distributionDate: F8.distributionDates[2], description: 'Y3', lines: p.lines, carryLines: p.carryLines,
      splitMethod: 'waterfall' as const, tiers: p.tiers, available: p.available, reserve: p.reserve, cash: p.cash,
    }
    const result = await declareDistribution(m.admin, 'f', 'GPU I', 'u', input)
    return { m, rpc, result, p, input, before: s.postings }
  }

  it('posts the realised profit share as a third entry and freezes the cash tiers on the register', async () => {
    const { m, rpc, result } = await declareY3()
    if ('error' in result) throw new Error(result.error)
    expect(s.entries.map(e => e.sourceType)).toEqual(['distribution', 'carry_distribution', 'carried_interest'])
    const realised = s.entries[2]
    expect(realised.memo).toBe('Y3 — profit share realised')
    expect(realised.status).toBe('draft')
    expect(realised.postings.map((p: any) => [p.lpEntityId, p.amount])).toEqual([['lp', F1.y3Cents.carry], ['mgr', -F1.y3Cents.carry]])
    expect(result.carryRealizedEntryId).toBe('entry-3')

    const row = m.tables.distributions[0]
    expect(row).toMatchObject({
      carry_realized_journal_entry_id: 'entry-3', reserve_amount: roundTo(670_000 - F1.distributableCents[2]),
      wf_profit_lp: F1.y3Cents.profitToLP, wf_pref_carried_forward: 0, wf_unreturned_after: 0, wf_contingency_return: 0,
      wf_preferred: F1.y3Cents.pref, wf_return_of_capital: F1.y3Cents.roc, wf_carry: F1.y3Cents.carry,
    })
    const complete = rpc.mock.calls.find(c => c[0] === 'complete_capital_operation')![1]
    expect(complete.p_entry_ids).toEqual(['entry-1', 'entry-2', 'entry-3'])
  })

  it('statements: the recipient nets to zero, the investor bears the profit share, capital + 2300 is conserved', async () => {
    const { before } = await declareY3()
    const toCapital = (e: any): CapitalPosting[] => e.postings.filter((p: any) => p.lpEntityId && p.accountId.startsWith('cap-'))
      .map((p: any) => ({ lpEntityId: p.lpEntityId, amount: p.amount, sourceType: e.sourceType, entryDate: e.entryDate }))
    const after = [...before, ...s.entries.flatMap(toCapital)]
    const capBefore = Array.from(computeCapitalAccounts(before).values()).reduce((t, a) => t + a.ending, 0)
    const accounts = computeCapitalAccounts(after)
    const capAfter = Array.from(accounts.values()).reduce((t, a) => t + a.ending, 0)
    const payable = -s.entries.flatMap(e => e.postings).filter((p: any) => p.accountId === 'payable').reduce((t: number, p: any) => t + p.amount, 0)
    expect(Math.round((capAfter + payable) * 100)).toBe(Math.round(capBefore * 100))
    expect(accounts.get('mgr')!.ending).toBe(0)
    expect(accounts.get('lp')!.carriedInterest).toBe(-F1.y3Cents.carry)
    expect(Math.abs(accounts.get('lp')!.carriedInterest + F1.y3Cents.profitToLP * 30 / 70)).toBeLessThanOrEqual(0.01)
  })

  it('a retry of a declared request returns all three entry ids', async () => {
    const { m, result, input } = await declareY3()
    const again = await declareDistribution(m.admin, 'f', 'GPU I', 'u', input)
    expect(again).toEqual(result)
    expect(result).toMatchObject({ entryId: 'entry-1', carryEntryId: 'entry-2', carryRealizedEntryId: 'entry-3' })
    expect(s.entries).toHaveLength(3)
  })

  /** A Y3 declaration body straight from the preview: the only carry lines the guard accepts. */
  async function y3Input(m: any, requestKey: string) {
    const p = await previewDistribution(m.admin, 'f', 'GPU I', NaN, F8.distributionDates[2], 'waterfall', { available: F1.distributableCents[2], reserve: 0 })
    if ('error' in p) throw new Error(p.error)
    return {
      requestKey, distributionDate: F8.distributionDates[2], lines: p.lines, carryLines: p.carryLines,
      splitMethod: 'waterfall' as const, tiers: p.tiers, available: p.available, reserve: p.reserve, cash: p.cash,
    }
  }

  it('splits the realised profit share across two investors by contributed capital, tied to the cent', async () => {
    // F6's two investors on the Base books through Y2: Y3 pays 156,052.87 of carry.
    const engine = engineF1()
    s.postings = postingsBefore(2, engine).flatMap(p => p.lpEntityId !== 'lp' ? [p] : [
      { ...p, lpEntityId: 'a', amount: roundTo(p.amount * 1_000_000 / CAPITAL) },
      { ...p, lpEntityId: 'b', amount: roundTo(p.amount - roundTo(p.amount * 1_000_000 / CAPITAL)) },
    ])
    const { m } = admin()
    const input = await y3Input(m, 'two')
    expect(input.carryLines).toEqual([{ lpEntityId: 'mgr', amount: F1.y3Cents.carry }])
    expect(await declareDistribution(m.admin, 'f', 'GPU I', 'u', input)).not.toHaveProperty('error')
    const legs = s.entries[2].postings.map((p: any) => [p.lpEntityId, p.amount])
    // apportionCents(15_605_287, [100_000_000, 43_550_000]): A 10_870_976.66 → .77 takes the cent.
    expect(legs).toEqual([['a', 108_709.77], ['b', 47_343.1], ['mgr', -F1.y3Cents.carry]])
  })

  it.each<[string, (i: any) => any]>([
    ['carry lines to someone who is not a recipient', i => ({ ...i, carryLines: [{ lpEntityId: 'lp2', amount: i.carryLines[0].amount }] })],
    ['carry lines that do not total the waterfall', i => ({ ...i, carryLines: [{ lpEntityId: 'mgr', amount: roundTo(i.carryLines[0].amount + 0.01) }] })],
    ['an available less reserve that is not the distribution declared', i => ({ ...i, reserve: roundTo(i.reserve + 100) })],
    ['carry lines on a distribution the waterfall gives no carry', i => ({ ...i, distributionDate: F8.distributionDates[0], available: 1_000, reserve: 0, lines: [{ lpEntityId: 'lp', amount: 990 }], carryLines: [{ lpEntityId: 'mgr', amount: 10 }] })],
  ])('refuses %s before writing anything', async (_, edit) => {
    s.postings = postingsBefore(2, engineF1())
    const { m, rpc } = admin()
    const out = await declareDistribution(m.admin, 'f', 'GPU I', 'u', edit(await y3Input(m, 'bad')))
    expect(out).toHaveProperty('error')
    expect((out as any).error).toMatch(/recipients|do not match the waterfall|less the reserve/)
    expect(s.entries).toEqual([])
    expect(m.tables.distributions).toEqual([])
    expect(rpc).not.toHaveBeenCalled()
  })

  it('a failed register insert discards all three drafts', async () => {
    s.postings = postingsBefore(2, engineF1())
    const { m, rpc } = admin()
    const input = await y3Input(m, 'fail')
    m.failNext('distributions', 'insert', 'boom')
    expect(await declareDistribution(m.admin, 'f', 'GPU I', 'u', input)).toHaveProperty('error')
    const discard = rpc.mock.calls.find(c => c[0] === 'discard_unregistered_capital_drafts')![1]
    expect(discard.p_entry_ids).toEqual(['entry-1', 'entry-2', 'entry-3'])
  })

  it('a failed realised entry discards the two drafts before it', async () => {
    s.postings = postingsBefore(2, engineF1())
    const { m, rpc } = admin()
    const input = await y3Input(m, 'fail3')
    s.failOnCall = 3
    expect(await declareDistribution(m.admin, 'f', 'GPU I', 'u', input)).toEqual({ error: 'persist failed' })
    expect(rpc.mock.calls.find(c => c[0] === 'discard_unregistered_capital_drafts')![1].p_entry_ids).toEqual(['entry-1', 'entry-2'])
    expect(m.tables.distributions).toEqual([])
  })

  it('a fund (european) declaration posts exactly the two entries it always did', async () => {
    s.postings = [at('a', -1_000, 'capital_call', '2026-01-01')]
    const { m, rpc } = admin({ fund_id: 'f', vehicle_id: 'v1', kind: 'european', carry_rate: 0.2, pref_rate: 0.08, gp_entity_id: 'gp' })
    const out = await declareDistribution(m.admin, 'f', 'Fund I', 'u', {
      requestKey: 'vc', distributionDate: '2026-06-30', lines: [{ lpEntityId: 'a', amount: 900 }], carryLines: [{ lpEntityId: 'gp', amount: 100 }],
      splitMethod: 'waterfall', tiers: { returnOfCapital: 900, preferred: 0, catchUp: 0, carry: 100, profitToLP: 0, toLP: 900, toGP: 100 },
    })
    expect(out).toEqual({ entryId: 'entry-1', carryEntryId: 'entry-2', carryRealizedEntryId: null, distributionId: expect.any(String) })
    expect(s.entries.map(e => e.sourceType)).toEqual(['distribution', 'carry_distribution'])
    const row = m.tables.distributions[0]
    for (const k of ['carry_realized_journal_entry_id', 'wf_profit_lp', 'wf_pref_carried_forward', 'wf_unreturned_after', 'wf_contingency_return', 'reserve_amount']) {
      expect(row).not.toHaveProperty(k)
    }
    expect(rpc.mock.calls.find(c => c[0] === 'complete_capital_operation')![1].p_entry_ids).toEqual(['entry-1', 'entry-2'])
  })
})

describe('listDistributions: distributable_cash', () => {
  it('returns the reserve and the frozen cash tiers; a fund row gets reserve null and no cash', async () => {
    const lines = (lp: number, carry: number) => [
      { id: 'l1', lp_entity_id: 'lp', amount: lp, role: 'lp', settled_amount: 0 },
      { id: 'l2', lp_entity_id: 'mgr', amount: carry, role: 'carry', settled_amount: 0 },
    ]
    const { m } = admin(cashTerms, [
      {
        id: 'd3', fund_id: 'f', vehicle_id: 'v1', status: 'declared', distribution_date: '2030-01-01', split_method: 'waterfall',
        wf_return_of_capital: 132_578.96, wf_preferred: 10_606.32, wf_catch_up: 0, wf_carry: 156_052.87,
        wf_contingency_return: 0, wf_profit_lp: 364_123.35, wf_pref_carried_forward: 0, wf_unreturned_after: 0, reserve_amount: 6_638.5,
        distribution_lines: lines(507_308.63, 156_052.87),
      },
      {
        id: 'd9', fund_id: 'f', vehicle_id: 'v1', status: 'declared', distribution_date: '2026-01-01', split_method: 'waterfall',
        wf_return_of_capital: 100, wf_preferred: 0, wf_catch_up: 0, wf_carry: 10, distribution_lines: lines(100, 10),
      },
    ])
    ;(m.admin as any).rpc = vi.fn(async () => ({ data: [], error: null }))
    const rows = await listDistributions(m.admin, 'f', 'GPU I', '2030-06-30')
    const cash = rows.find(r => r.distributionId === 'd3')!
    expect(cash.reserve).toBe(6_638.5)
    expect(cash.tiers).toMatchObject({ profitToLP: 364_123.35, contingencyReturn: 0, cash: { prefDue: 10_606.32, prefCarriedForward: 0, unreturnedAfter: 0, profitToLP: 364_123.35, managerRocShare: 0, contingencyReturn: 0 } })
    const fund = rows.find(r => r.distributionId === 'd9')!
    expect(fund.reserve).toBeNull()
    expect(fund.tiers).not.toHaveProperty('cash')
  })
})

function roundTo(n: number) { return Math.round(n * 100) / 100 }
