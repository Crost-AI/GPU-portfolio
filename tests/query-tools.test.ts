import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccessContext, AccessLevel } from '@/lib/access/effective'
import type { Domain } from '@/lib/access/domains'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureVisibilityMap } from '@/lib/types/features'
import { memoryAdmin } from './helpers/memory-admin'

/**
 * The query tools: questions no named tool answers, over rows the named tools already load. A
 * dataset is gated by its source tool's access and scoped by its source tool's loader.
 */

vi.mock('@/lib/access/entity-scope', () => ({
  entityScopeFor: async (_: unknown, a: AccessContext) =>
    a.vehicles.all ? { access: a, vehicleNames: null, companyIds: null } : { access: a, vehicleNames: ['Fund I'], companyIds: ['c1'] },
}))
vi.mock('@/lib/access/scope', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/access/scope')>()),
  visibleCompanyIds: async (_: unknown, a: AccessContext) => (a.vehicles.all ? null : ['c1']),
}))
vi.mock('@/lib/access/carry-visibility', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/access/carry-visibility')>()),
  carryRecipientIds: async () => new Set(['ent-gp']),
}))

import { QUERY_HANDLERS as H } from '@/lib/agent/query-tools'
import { getTool } from '@/lib/accounting/agent-tools'
import { DEALS_HANDLERS } from '@/lib/agent/deals-tools'
import { PORTFOLIO_HANDLERS } from '@/lib/agent/portfolio-tools'

const member = (grants: Partial<Record<Domain, AccessLevel>>, all = true, features: Partial<FeatureVisibilityMap> = {}): AccessContext => ({
  fundId: 'f1', userId: 'u1', vehicles: { all, ids: all ? [] : ['v1'] }, role: 'member',
  features: { ...Object.fromEntries(Object.keys(DEFAULT_FEATURE_VISIBILITY).map(k => [k, 'everyone'])), ...features } as FeatureVisibilityMap,
  grants, defaults: {},
})
let store: ReturnType<typeof memoryAdmin>
const ctx = (access: AccessContext, portfolioGroup = '') => ({ admin: store.admin, fundId: 'f1', portfolioGroup, userId: 'u1', access }) as any

beforeEach(() => {
  store = memoryAdmin({
    fund_vehicles: [{ id: 'v1', fund_id: 'f1', name: 'Fund I', active: true, kind: 'fund', aliases: null }],
    companies: [
      { id: 'c1', fund_id: 'f1', name: 'Acme', holding_type: 'company', status: 'active', stage: 'Seed', industry: ['Fintech'], portfolio_group: ['Fund I'] },
      { id: 'c2', fund_id: 'f1', name: 'Birch', holding_type: 'company', status: 'active', stage: 'Series A', industry: ['Health'], portfolio_group: ['Fund II'] },
    ],
    metrics: [{ id: 'm1', company_id: 'c1', name: 'ARR', unit: 'USD' }, { id: 'm2', company_id: 'c2', name: 'ARR', unit: 'USD' }],
    metric_values: [
      { metric_id: 'm1', period_label: 'Q1 2026', period_year: 2026, period_quarter: 1, value_number: 100 },
      { metric_id: 'm1', period_label: 'Q2 2026', period_year: 2026, period_quarter: 2, value_number: 150 },
      { metric_id: 'm2', period_label: 'Q2 2026', period_year: 2026, period_quarter: 2, value_number: 900 },
    ],
    investment_transactions: [{ id: 't1', fund_id: 'f1', company_id: 'c1', portfolio_group: 'Fund I', transaction_type: 'investment', transaction_date: '2025-03-01', investment_cost: 250000 }],
    chart_of_accounts: [
      { id: 'a1', fund_id: 'f1', vehicle_id: 'v1', code: '6100', name: 'Legal fees', type: 'expense' },
      { id: 'a2', fund_id: 'f1', vehicle_id: 'v1', code: '1000', name: 'Cash', type: 'asset' },
      { id: 'a3', fund_id: 'f1', vehicle_id: 'v1', code: '3000', name: 'Partners capital', type: 'equity' },
    ],
    journal_entries: [
      { id: 'e1', fund_id: 'f1', vehicle_id: 'v1', book: 'actual', status: 'posted', entry_date: '2026-02-01', memo: 'Counsel', source_type: 'manual' },
      { id: 'e2', fund_id: 'f1', vehicle_id: 'v1', book: 'actual', status: 'posted', entry_date: '2026-05-01', memo: 'Counsel', source_type: 'manual' },
      { id: 'e3', fund_id: 'f1', vehicle_id: 'v1', book: 'actual', status: 'draft', entry_date: '2026-05-02', memo: 'Draft', source_type: 'manual' },
      { id: 'e4', fund_id: 'f1', vehicle_id: 'v1', book: 'actual', status: 'posted', entry_date: '2026-06-30', memo: 'Carry', source_type: 'allocation' },
    ],
    journal_postings: [
      { fund_id: 'f1', vehicle_id: 'v1', book: 'actual', journal_entry_id: 'e1', account_id: 'a1', amount: 1000 },
      { fund_id: 'f1', vehicle_id: 'v1', book: 'actual', journal_entry_id: 'e1', account_id: 'a2', amount: -1000 },
      { fund_id: 'f1', vehicle_id: 'v1', book: 'actual', journal_entry_id: 'e2', account_id: 'a1', amount: 2500 },
      { fund_id: 'f1', vehicle_id: 'v1', book: 'actual', journal_entry_id: 'e2', account_id: 'a2', amount: -2500 },
      { fund_id: 'f1', vehicle_id: 'v1', book: 'actual', journal_entry_id: 'e3', account_id: 'a1', amount: 99 },
      { fund_id: 'f1', vehicle_id: 'v1', book: 'actual', journal_entry_id: 'e4', account_id: 'a3', amount: -500, lp_entity_id: 'ent-gp' },
    ],
    lp_entities: [{ id: 'ent-gp', fund_id: 'f1', entity_name: 'GP Carry LLC' }],
  })
})

describe('query tools', () => {
  it('are read-only, one per area, each with its area as the gate', () => {
    expect(getTool('query_portfolio')).toMatchObject({ scope: 'read', domain: 'portfolio' })
    expect(getTool('query_lps')).toMatchObject({ scope: 'read', domain: 'lp' })
    expect(getTool('query_deals')).toMatchObject({ scope: 'read', domain: 'deals' })
    expect(getTool('query_diligence')).toMatchObject({ scope: 'read', domain: 'diligence' })
    expect(getTool('query_ledger')).toMatchObject({ scope: 'read', domain: 'ledger' })
  })

  it('aggregates KPIs over only the companies the member can see', async () => {
    const q = { dataset: 'kpis', where: [{ column: 'metric', op: 'eq', value: 'ARR' }, { column: 'period', op: 'eq', value: 'Q2 2026' }], aggregates: [{ fn: 'sum', column: 'value' }] }
    expect(((await H.query_portfolio(ctx(member({ portfolio: 'read' })), q)) as any).rows).toEqual([{ sum_value: 1050 }])
    expect(((await H.query_portfolio(ctx(member({ portfolio: 'read' }, false)), q)) as any).rows).toEqual([{ sum_value: 150 }])
  })

  it('lists companies through the same scope as list_companies', async () => {
    const out = await H.query_portfolio(ctx(member({ portfolio: 'read' }, false)), { dataset: 'companies', columns: ['company'] }) as any
    expect(out.rows).toEqual([{ company: 'Acme' }])
  })

  it("holds a dataset to its source tool's switch", async () => {
    const off = member({ portfolio: 'read' }, true, { investments: 'off' })
    await expect(H.query_portfolio(ctx(off), { dataset: 'transactions' })).rejects.toThrow('transactions dataset needs access')
    const out = await H.query_portfolio(ctx(member({ portfolio: 'read' })), { dataset: 'transactions', columns: ['company', 'invested'] }) as any
    expect(out.rows).toEqual([{ company: 'Acme', invested: 250000 }])
  })

  it('sums posted journal lines by quarter, and folds carry recipients without GP economics', async () => {
    const legal = await H.query_ledger(ctx(member({ accounting: 'read' }), 'Fund I'), {
      where: [{ column: 'account_name', op: 'eq', value: 'Legal fees' }], group_by: ['date:quarter'], aggregates: [{ fn: 'sum', column: 'debit' }], order_by: [{ column: 'date_quarter' }],
    }) as any
    expect(legal.rows).toEqual([{ date_quarter: '2026-Q1', sum_debit: 1000 }, { date_quarter: '2026-Q2', sum_debit: 2500 }])
    const carry = (a: AccessContext) => H.query_ledger(ctx(a, 'Fund I'), { where: [{ column: 'account_type', op: 'eq', value: 'equity' }], columns: ['lp'] })
    expect(((await carry(member({ accounting: 'read' }))) as any).rows).toEqual([{ lp: 'Carried interest recipients' }])
    expect(((await carry(member({ accounting: 'read', gp_economics: 'read' }))) as any).rows).toEqual([{ lp: 'GP Carry LLC' }])
  })

  it('needs a dataset when an area has several, and says which', async () => {
    await expect(H.query_portfolio(ctx(member({ portfolio: 'read' })), {})).rejects.toThrow('Pass a dataset: positions, companies, transactions, kpis')
  })
})

describe('query datasets load the whole authorized set, past the 1000-row cap', () => {
  const pad = (i: number) => String(i).padStart(5, '0')
  const count = (out: any) => out.rows[0].count
  beforeEach(() => {
    store = memoryAdmin({
      fund_vehicles: [{ id: 'v1', fund_id: 'f1', name: 'Fund I', active: true, kind: 'fund', aliases: null }],
      // 1200 pitches, alternating between two entities; the first 200 are from 2020, so the newest
      // 500 (deals_list_inbound's cap) never reach them.
      inbound_deals: Array.from({ length: 1200 }, (_, i) => ({
        id: `d${pad(i)}`, fund_id: 'f1', vehicle_id: i % 2 ? 'v2' : 'v1', company_name: `Co ${i}`, status: 'new',
        created_at: i < 200 ? `2020-01-01T00:00:${pad(i).slice(-2)}Z` : `2026-01-01T00:00:00Z`,
      })),
      diligence_deals: Array.from({ length: 1100 }, (_, i) => ({
        id: `dd${pad(i)}`, fund_id: 'f1', vehicle_id: i % 2 ? 'v2' : 'v1', name: `Deal ${i}`, deal_status: 'active', created_at: '2026-01-01T00:00:00Z',
      })),
      // 1100 other companies first, so Acme and Birch are past the cap of an unpaged companies read.
      companies: [
        ...Array.from({ length: 1100 }, (_, i) => ({ id: `a${pad(i)}`, fund_id: 'f1', name: `Filler ${i}`, holding_type: 'company', status: 'active', portfolio_group: ['Fund I'] })),
        { id: 'c1', fund_id: 'f1', name: 'Acme', holding_type: 'company', status: 'active', portfolio_group: ['Fund I'] },
        { id: 'c2', fund_id: 'f1', name: 'Birch', holding_type: 'company', status: 'active', portfolio_group: ['Fund II'] },
      ],
      // Acme sorts after the 1100 fillers, so its KPIs sit past an unpaged companies read's cap.
      metrics: [{ id: 'm1', company_id: 'c1', name: 'ARR', unit: 'USD' }],
      metric_values: [{ id: 'mv1', metric_id: 'm1', period_label: 'Q2 2026', period_year: 2026, period_quarter: 2, value_number: 150 }],
      investment_transactions: [
        ...Array.from({ length: 1100 }, (_, i) => ({ id: `t${pad(i)}`, fund_id: 'f1', company_id: 'c1', portfolio_group: 'Fund I', transaction_type: 'investment', transaction_date: '2025-01-01', investment_cost: 1 })),
        ...Array.from({ length: 50 }, (_, i) => ({ id: `u${pad(i)}`, fund_id: 'f1', company_id: 'c2', portfolio_group: 'Fund II', transaction_type: 'investment', transaction_date: '2025-01-01', investment_cost: 1 })),
      ],
    }, { maxRows: 1000 })
  })

  it('counts every inbound deal, the oldest included', async () => {
    const a = member({ dealflow: 'read' })
    expect(count(await H.query_deals(ctx(a), { aggregates: [{ fn: 'count' }] }))).toBe(1200)
    const old = await H.query_deals(ctx(a), { where: [{ column: 'created_at', op: 'lt', value: '2021-01-01' }], aggregates: [{ fn: 'count' }] })
    expect(count(old)).toBe(200)
  })

  it("still shows a scoped caller only their entity's deals", async () => {
    const scoped = member({ dealflow: 'read', diligence: 'read' }, false)
    expect(count(await H.query_deals(ctx(scoped), { aggregates: [{ fn: 'count' }] }))).toBe(600)
    expect(count(await H.query_deals(ctx(scoped), { where: [{ column: 'created_at', op: 'lt', value: '2021-01-01' }], aggregates: [{ fn: 'count' }] }))).toBe(100)
    expect(count(await H.query_diligence(ctx(scoped), { aggregates: [{ fn: 'count' }] }))).toBe(550)
  })

  it('counts every diligence deal', async () => {
    expect(count(await H.query_diligence(ctx(member({ diligence: 'read' })), { aggregates: [{ fn: 'count' }] }))).toBe(1100)
  })

  it("counts every transaction, through list_investments' company and entity scope", async () => {
    const q = { dataset: 'transactions', aggregates: [{ fn: 'count' }] }
    expect(count(await H.query_portfolio(ctx(member({ portfolio: 'read' })), q))).toBe(1150)
    expect(count(await H.query_portfolio(ctx(member({ portfolio: 'read' }, false)), q))).toBe(1100)
    const named = await H.query_portfolio(ctx(member({ portfolio: 'read' }, false)), { dataset: 'transactions', group_by: ['company'], aggregates: [{ fn: 'sum', column: 'invested' }] }) as any
    expect(named.rows).toEqual([{ company: 'Acme', sum_invested: 1100 }])
  })

  it('a scoped caller with no entities sees no deals, rather than a failed query', async () => {
    const none = { ...member({ dealflow: 'read', diligence: 'read' }, false), vehicles: { all: false, ids: [] } }
    // PostgREST rejects `in.()`, which this client does not: so pin that no deal query is sent at all.
    const sent: string[] = []
    const from = store.admin.from.bind(store.admin)
    ;(store.admin as any).from = (t: string) => { sent.push(t); return from(t) }
    // No rows in, no aggregate row out (the engine's answer for an empty set) — and no throw.
    expect(((await H.query_deals(ctx(none), { aggregates: [{ fn: 'count' }] })) as any).rows).toEqual([])
    expect(((await H.query_diligence(ctx(none), { aggregates: [{ fn: 'count' }] })) as any).rows).toEqual([])
    expect(await DEALS_HANDLERS.deals_list_inbound(ctx(none), {})).toEqual([])
    expect(sent.filter(t => t === 'inbound_deals' || t === 'diligence_deals')).toEqual([])
  })

  it('keeps the direct tool capped: 100 by default, 500 at most', async () => {
    const a = { ...ctx(member({ dealflow: 'read' })) }
    expect(await DEALS_HANDLERS.deals_list_inbound(a, {})).toHaveLength(100)
    expect(await DEALS_HANDLERS.deals_list_inbound(a, { limit: 5000 })).toHaveLength(500)
  })

  it('surfaces a read that fails on a later page instead of answering over the first', async () => {
    let pages = 0
    const from = store.admin.from.bind(store.admin)
    ;(store.admin as any).from = (t: string) => {
      if (t === 'inbound_deals' && ++pages === 2) store.failNext('inbound_deals', 'select', 'statement timeout')
      return from(t)
    }
    await expect(H.query_deals(ctx(member({ dealflow: 'read' })), { aggregates: [{ fn: 'count' }] })).rejects.toMatchObject({ message: 'statement timeout' })
    expect(pages).toBe(2)
  })

  it('reads KPIs for companies past the 1000-row cap', async () => {
    const out = await H.query_portfolio(ctx(member({ portfolio: 'read' })), { dataset: 'kpis', group_by: ['company'], aggregates: [{ fn: 'sum', column: 'value' }] }) as any
    expect(out.rows).toEqual([{ company: 'Acme', sum_value: 150 }])
  })

  it('rejects when the KPI companies read fails, rather than answering "no companies"', async () => {
    store.failNext('companies', 'select', 'statement timeout')
    await expect(H.query_portfolio(ctx(member({ portfolio: 'read' })), { dataset: 'kpis' })).rejects.toMatchObject({ message: 'statement timeout' })
  })

  it("reads one company's whole transaction history past the cap (txnsFor)", async () => {
    const rows = await PORTFOLIO_HANDLERS.list_investments(ctx(member({ portfolio: 'read' })), { company: 'Acme' }) as any[]
    expect(rows).toHaveLength(1100)
  })
})
