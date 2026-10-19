import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccessContext } from '@/lib/access/effective'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureVisibilityMap } from '@/lib/types/features'
import { memoryAdmin } from './helpers/memory-admin'

/**
 * delete_fund_holding, clear_fund_register and delete_inactive_company_accounts
 * (lib/agent/destructive-tools.ts): what each preview shows, what approval removes, and what it
 * leaves alone. Staging and the flag are tests/agent-destructive-actions.test.ts; the route side of
 * the fund-holding delete is tests/fund-holding-delete-route.test.ts.
 */

vi.mock('@/lib/cache/tags', () => ({ expireTag: () => {} }))
vi.mock('@/lib/activity', () => ({ logActivity: vi.fn() }))

import { getTool } from '@/lib/accounting/agent-tools'
import { DESTRUCTIVE_PREVIEWS } from '@/lib/agent/destructive-tools'

const access: AccessContext = {
  fundId: 'fund-1', userId: 'me', vehicles: { all: true, ids: [] }, role: 'admin',
  features: Object.fromEntries(Object.keys(DEFAULT_FEATURE_VISIBILITY).map(k => [k, 'everyone'])) as FeatureVisibilityMap,
  grants: {}, defaults: {},
}
let store: ReturnType<typeof memoryAdmin>
const ctx = (portfolioGroup = '') => ({ admin: store.admin, fundId: 'fund-1', portfolioGroup, userId: 'me', access })
const run = (name: string, input: Record<string, unknown>, group = '') => getTool(name)!.handler(ctx(group), input)
const preview = (name: string, input: Record<string, unknown>) =>
  DESTRUCTIVE_PREVIEWS[name]({ admin: store.admin, fundId: 'fund-1', userId: 'me', access }, input)

const acct = (id: string, companyId: string, vehicleId: string, code: string, isActive: boolean) =>
  ({ id, fund_id: 'fund-1', company_id: companyId, vehicle_id: vehicleId, code, name: `Account ${code}`, is_active: isActive })

beforeEach(() => {
  store = memoryAdmin({
    fund_vehicles: [
      { id: 'v1', fund_id: 'fund-1', name: 'Fund I', active: true, kind: 'fund', aliases: null },
      { id: 'v2', fund_id: 'fund-1', name: 'Fund II', active: true, kind: 'fund', aliases: null },
    ],
    companies: [
      { id: 'h1', fund_id: 'fund-1', name: 'Delta Ventures III', holding_type: 'fund', portfolio_group: ['Fund I'] },
      { id: 'co1', fund_id: 'fund-1', name: 'Echo', holding_type: 'company', portfolio_group: ['Fund I'] },
      { id: 'co2', fund_id: 'fund-1', name: 'Foxtrot', holding_type: 'company', portfolio_group: ['Fund I', 'Fund II'] },
    ],
    company_vehicles: [],
    fund_holding_terms: [
      { id: 'ht1', fund_id: 'fund-1', company_id: 'h1', vehicle_id: 'v1', commitment: 0 },
      { id: 'ht2', fund_id: 'fund-1', company_id: 'co1', vehicle_id: 'v1', commitment: 100_000 },
      { id: 'ht3', fund_id: 'fund-1', company_id: 'co1', vehicle_id: 'v2', commitment: 50_000 },
    ],
    fund_capital_events: [
      { id: 'ev1', fund_id: 'fund-1', company_id: 'co1', vehicle_id: 'v1', investment_transaction_id: 't1' },
      { id: 'ev2', fund_id: 'fund-1', company_id: 'co1', vehicle_id: 'v1', investment_transaction_id: 't2' },
    ],
    fund_nav_statements: [],
    investment_transactions: [
      { id: 't1', fund_id: 'fund-1', company_id: 'co1', portfolio_group: 'Fund I' },
      { id: 't2', fund_id: 'fund-1', company_id: 'co1', portfolio_group: 'Fund I' },
    ],
    chart_of_accounts: [
      acct('a1', 'h1', 'v1', '1100-h1', false),
      acct('a2', 'co2', 'v1', '1100-co2', false),
      acct('a3', 'co2', 'v1', '1200-co2', false),
      acct('a4', 'co2', 'v2', '1100-co2', true),
    ],
    journal_postings: [],
    accounting_schedule_lines: [],
    company_documents: [],
  })
})

describe('delete_fund_holding', () => {
  it('previews the register and accounts, then deletes a holding with nothing on the ledger', async () => {
    const p = await preview('delete_fund_holding', { company: 'Delta Ventures III' })
    expect(p.pin).toEqual({ company: 'h1' })
    expect(p.summary).toBe('Delete fund holding Delta Ventures III for every entity, with 1 terms row(s), 0 capital notice(s), 0 NAV statement(s) and 1 chart account(s).')
    const out = await run('delete_fund_holding', { company: 'h1' })
    expect(out).toMatchObject({ deleted: { id: 'h1' }, accountsRemoved: 1 })
    expect(store.tables.companies.map(c => c.id)).toEqual(['co1', 'co2'])
    expect(store.tables.chart_of_accounts.map(a => a.id)).toEqual(['a2', 'a3', 'a4'])
  })

  it('refuses a holding whose accounts carry a posting', async () => {
    store.tables.journal_postings.push({ id: 'p1', fund_id: 'fund-1', account_id: 'a1', book: 'actual', amount: 10 })
    await expect(run('delete_fund_holding', { company: 'h1' })).rejects.toThrow("This holding's accounts carry 1 ledger posting(s)")
    expect(store.tables.companies).toHaveLength(3)
  })

  it('refuses a company, pointing at delete_company', async () => {
    expect((await preview('delete_fund_holding', { company: 'Echo' })).summary).toMatch(/not a fund holding, so the delete will be refused: use delete_company/)
    await expect(run('delete_fund_holding', { company: 'co1' })).rejects.toThrow('Fund holding not found')
  })
})

describe('clear_fund_register', () => {
  it('deletes one entity\'s register rows and keeps the transactions they booked', async () => {
    const p = await preview('clear_fund_register', { company: 'Echo', vehicle: 'Fund I' })
    expect(p.pin).toEqual({ company: 'co1', vehicle: 'Fund I' })
    expect(p.summary).toBe("Delete Echo's fund-register rows on Fund I: 1 terms row(s), 2 capital notice(s) and 0 NAV statement(s). "
      + 'The 2 investment transaction(s) they booked stay, with their journal entries.')
    const out = await run('clear_fund_register', { company: 'co1', vehicle: 'Fund I' })
    expect(out).toMatchObject({ vehicle: 'Fund I', deleted: { capitalEvents: 2, navStatements: 0, terms: 1 }, transactionsReleased: ['t1', 't2'] })
    expect(store.tables.fund_capital_events).toHaveLength(0)
    // The other entity's terms and every transaction stay.
    expect(store.tables.fund_holding_terms.map(t => t.id)).toEqual(['ht1', 'ht3'])
    expect(store.tables.investment_transactions.map(t => t.id)).toEqual(['t1', 't2'])
  })

  it('refuses a fund holding, whose register is its record', async () => {
    await expect(run('clear_fund_register', { company: 'h1', vehicle: 'Fund I' })).rejects.toThrow('is a fund holding, so its register is its record')
    expect(store.tables.fund_holding_terms).toHaveLength(3)
  })
})

describe('delete_inactive_company_accounts', () => {
  it('deletes the inactive accounts on this entity only', async () => {
    const p = await preview('delete_inactive_company_accounts', { company: 'Foxtrot', vehicle: 'Fund I' })
    expect(p.summary).toBe('Delete 2 inactive chart account(s) of Foxtrot on Fund I (1100-co2, 1200-co2); 0 active account(s) stay.')
    const out = await run('delete_inactive_company_accounts', { company: 'co2' }, 'Fund I')
    expect(out).toMatchObject({ vehicle: 'Fund I', deleted: [{ code: '1100-co2' }, { code: '1200-co2' }], activeKept: 0 })
    expect(store.tables.chart_of_accounts.map(a => a.id)).toEqual(['a1', 'a4'])
    expect(store.tables.companies).toHaveLength(3)
  })

  it('refuses while one of them carries a posting', async () => {
    store.tables.journal_postings.push({ id: 'p1', fund_id: 'fund-1', account_id: 'a3', book: 'tax', amount: 10 })
    expect((await preview('delete_inactive_company_accounts', { company: 'co2', vehicle: 'Fund I' })).summary).toMatch(/1 posting\(s\) and 0 schedule line\(s\), so the delete will be refused/)
    await expect(run('delete_inactive_company_accounts', { company: 'co2' }, 'Fund I')).rejects.toThrow('still carry 1 ledger posting(s)')
    expect(store.tables.chart_of_accounts).toHaveLength(4)
  })

  it('leaves active accounts alone', async () => {
    await expect(run('delete_inactive_company_accounts', { company: 'co2' }, 'Fund II')).rejects.toThrow('no inactive accounts on this entity')
    expect(store.tables.chart_of_accounts).toHaveLength(4)
  })
})
