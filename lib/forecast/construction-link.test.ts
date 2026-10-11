import { describe, expect, it } from 'vitest'
import type { Account } from '@/lib/accounting/types'
import { DEFAULT_CHART, GP_ENTITY_CHART } from '@/lib/accounting/chart'
import { buildPlan, gpShareEntries, type BuildPlanInput } from './plan'
import { entriesFingerprint } from './service'
import type { MonthlyConstruction } from './construction-adapter'

const chart = (seed: typeof DEFAULT_CHART): Account[] =>
  seed.map(a => ({ id: `a${a.code}`, fundId: 'f', code: a.code, name: a.name, type: a.type, subtype: a.subtype ?? null }))
const FUND = chart(DEFAULT_CHART)
const GP = chart(GP_ENTITY_CHART)

const plan = (over: Partial<BuildPlanInput>): BuildPlanInput => ({
  kind: 'rolling', fiscalYear: null, startMonth: '2027-01', endMonth: '2027-12', horizonMonths: null, cutoff: '2026-12',
  vehicleKind: 'fund', accounts: FUND, actuals: [], closedFrom: null, closedThrough: null, rules: [], overrides: [], currency: 'USD',
  ...over,
} as BuildPlanInput)

const mc = (events: MonthlyConstruction['events']): MonthlyConstruction => ({ asOfMonth: '2026-12', events, byMonth: new Map(), reconciliation: [], warnings: [] })

describe("a GP entity's share of its fund", () => {
  const share = (months: [string, { called: number; distributed: number; carry: number }][]) =>
    ({ fund: 'Fund I', months: new Map(months), basis: '', warnings: [] }) as any

  it('books its calls at cost, returns cost first then earnings, and takes carry as income', () => {
    const r = gpShareEntries({ accounts: GP, currency: 'USD', actuals: [] }, share([
      ['2027-02', { called: 100, distributed: 0, carry: 0 }],
      ['2027-09', { called: 0, distributed: 250, carry: 80 }],
    ]), '2027-01', '2027-12', 'a1000')
    const sum = (code: string) => r.entries.flatMap(e => e.postings).filter(p => p.accountId === `a${code}`).reduce((s, p) => s + p.amount, 0)
    expect(sum('1500')).toBe(0)        // 100 in, 100 returned
    expect(sum('4100')).toBe(-150)     // the rest of the distribution is earnings
    expect(sum('4000')).toBe(-80)      // carry
    expect(sum('1000')).toBe(-100 + 250 + 80)
  })
})

describe('a draft out of date with its sources', () => {
  it('compares what the entries say, not how they are split into rows', () => {
    const a = [{ date: '2027-01-31', postings: [{ accountId: 'x', amount: 5 }, { accountId: 'c', amount: -5 }] }]
    const b = [{ date: '2027-01-31', postings: [{ accountId: 'x', amount: 2 }, { accountId: 'c', amount: -2 }] },
      { date: '2027-01-31', postings: [{ accountId: 'x', amount: 3 }, { accountId: 'c', amount: -3 }] }]
    expect(entriesFingerprint(a)).toBe(entriesFingerprint(b))
    expect(entriesFingerprint(a)).not.toBe(entriesFingerprint([{ date: '2027-01-31', postings: [{ accountId: 'x', amount: 6 }, { accountId: 'c', amount: -6 }] }]))
  })
})

describe('an exit of a company the fund holds', () => {
  it('reverses its unrealized mark and realizes the whole gain over cost, on its own accounts', async () => {
    const { constructionEntries } = await import('./plan')
    const accounts: Account[] = [
      ...FUND,
      { id: 'co-cost', fundId: 'f', code: '1100-acme', name: 'Acme at cost', type: 'asset', subtype: 'investment', companyId: 'acme' } as Account,
      { id: 'co-mark', fundId: 'f', code: '1200-acme', name: 'Acme unrealized', type: 'asset', subtype: 'unrealized', companyId: 'acme' } as Account,
      { id: 'co-gain', fundId: 'f', code: '4000-acme', name: 'Acme realized gain', type: 'income', subtype: 'realized_gain', companyId: 'acme' } as Account,
    ]
    const actuals = [
      { accountId: 'co-cost', amount: 1_000, currency: 'USD', entryDate: '2025-01-31' },
      { accountId: 'a1000', amount: -1_000, currency: 'USD', entryDate: '2025-01-31' },
      { accountId: 'co-mark', amount: 500, currency: 'USD', entryDate: '2026-06-30' },
      { accountId: 'a4200', amount: -500, currency: 'USD', entryDate: '2026-06-30' },
    ]
    const r = constructionEntries({ accounts, currency: 'USD', actuals },
      mc([{ month: '2027-06', flow: 'proceeds', amount: 3_000, cost: 1_000, deal: 'Acme', companyId: 'acme', timing: 'stated' }]), '2027-01', '2027-12', 'a1000')
    const legs = Object.fromEntries(r.entries[0].postings.map(p => [p.accountId, p.amount]))
    expect(legs).toEqual({ a1000: 3_000, 'co-cost': -1_000, 'co-mark': -500, a4200: 500, 'co-gain': -2_000 })
  })
})
