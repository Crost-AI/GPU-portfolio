import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccessContext } from '@/lib/access/effective'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureVisibilityMap } from '@/lib/types/features'
import { memoryAdmin } from './helpers/memory-admin'

/**
 * The holding tools (lib/agent/holding-tools.ts) and merge_companies (lib/agent/destructive-tools.ts):
 * renaming a holding and its accounts, changing its kind, moving a transaction to the right holding,
 * a fund holding's terms, notices (linked or booked) and NAV statements, and merging two records.
 * The ledger side of a move (retract and re-derive) is stubbed: what is checked here is which
 * company each transaction and register row ends up on, and what is refused.
 */

vi.mock('@/lib/cache/tags', () => ({ expireTag: () => {} }))
vi.mock('@/lib/activity', () => ({ logActivity: vi.fn() }))
const retract = vi.fn(async () => ({ retracted: 1 }))
const derive = vi.fn(async (...args: any[]) => ({ drafted: true, posted: true, entryId: `e-${args[3].id}` }))
vi.mock('@/lib/accounting/from-portfolio', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/accounting/from-portfolio')>()),
  retractEntriesForTransaction: (...args: any[]) => (retract as any)(...args),
  draftEntryForTransaction: (...args: any[]) => (derive as any)(...args),
}))
const saveNav = vi.fn(async (..._args: any[]) => ({ ok: true, navId: 'nav-1', booking: { status: 'no_change', message: 'The ledger already carries this NAV.' } }))
vi.mock('@/lib/portfolio/fof-nav', () => ({
  saveNavStatement: (...args: any[]) => (saveNav as any)(...args),
  rebookNavsFrom: async () => [],
}))

import { getTool } from '@/lib/accounting/agent-tools'
import { DESTRUCTIVE_PREVIEWS } from '@/lib/agent/destructive-tools'

const access: AccessContext = {
  fundId: 'fund-1', userId: 'me', vehicles: { all: true, ids: [] }, role: 'admin',
  features: Object.fromEntries(Object.keys(DEFAULT_FEATURE_VISIBILITY).map(k => [k, 'everyone'])) as FeatureVisibilityMap,
  grants: {}, defaults: {},
}
let store: ReturnType<typeof memoryAdmin>
const run = (name: string, input: Record<string, unknown>) =>
  getTool(name)!.handler({ admin: store.admin, fundId: 'fund-1', portfolioGroup: '', userId: 'me', access }, input)
const preview = (name: string, input: Record<string, unknown>) =>
  DESTRUCTIVE_PREVIEWS[name]({ admin: store.admin, fundId: 'fund-1', userId: 'me', access }, input)

beforeEach(() => {
  retract.mockClear(); derive.mockClear(); saveNav.mockClear()
  store = memoryAdmin({
    fund_vehicles: [{ id: 'v1', fund_id: 'fund-1', name: 'Fund I', active: true, kind: 'fund', aliases: null }],
    companies: [
      { id: 'fh', fund_id: 'fund-1', name: 'Northwind Fund II', aliases: null, holding_type: 'fund', status: 'active', portfolio_group: ['Fund I'] },
      { id: 'dup', fund_id: 'fund-1', name: 'Northwind Custody', aliases: ['NW Custody'], holding_type: 'company', status: 'active', portfolio_group: ['Fund I'] },
      { id: 'co', fund_id: 'fund-1', name: 'Acme', aliases: null, holding_type: 'company', status: 'active', portfolio_group: ['Fund I'] },
    ],
    company_vehicles: [],
    fund_holding_terms: [],
    fund_capital_events: [],
    fund_nav_statements: [],
    investment_transactions: [
      { id: 't-call', fund_id: 'fund-1', company_id: 'dup', portfolio_group: 'Fund I', transaction_type: 'investment', transaction_date: '2024-01-10', investment_cost: 100_000 },
      { id: 't-mark', fund_id: 'fund-1', company_id: 'dup', portfolio_group: 'Fund I', transaction_type: 'unrealized_gain_change', transaction_date: '2024-03-31', unrealized_value_change: 5_000 },
      { id: 't-dist', fund_id: 'fund-1', company_id: 'fh', portfolio_group: 'Fund I', transaction_type: 'proceeds', transaction_date: '2024-06-01', proceeds_received: 20_000, cost_basis_exited: 15_000 },
      { id: 't-acme', fund_id: 'fund-1', company_id: 'co', portfolio_group: 'Fund I', transaction_type: 'investment', transaction_date: '2024-02-01', investment_cost: 50_000 },
    ],
    chart_of_accounts: [
      { id: 'a1', fund_id: 'fund-1', company_id: 'co', vehicle_id: 'v1', code: '1100-co', name: 'Investment — Acme', is_active: true },
      { id: 'a2', fund_id: 'fund-1', company_id: 'co', vehicle_id: 'v1', code: '1200-co', name: 'Unrealized — Acme', is_active: true },
      { id: 'a3', fund_id: 'fund-1', company_id: 'co', vehicle_id: 'v1', code: '1300-co', name: 'Acme receivable', is_active: true },
      { id: 'a4', fund_id: 'fund-1', company_id: 'dup', vehicle_id: 'v1', code: '1100-dup', name: 'Investment — Northwind Custody', is_active: true },
      { id: 'a5', fund_id: 'fund-1', company_id: 'fh', vehicle_id: 'v1', code: '1100-fh', name: 'Investment — Northwind Fund II', is_active: true },
    ],
    journal_postings: [{ id: 'p1', fund_id: 'fund-1', account_id: 'a4', book: 'actual', amount: 100_000 }],
    accounting_schedule_lines: [],
    company_documents: [],
    company_notes: [{ id: 'n1', fund_id: 'fund-1', company_id: 'dup', content: 'Wire instructions' }],
    metrics: [], metric_values: [],
    company_updates: [], company_update_artifacts: [], company_update_chunks: [], inbound_emails: [], company_summaries: [], received_k1s: [],
  })
})

describe('update_company', () => {
  it('renames the holding and the accounts that carry its old name, and adds aliases', async () => {
    const out = await run('update_company', { company: 'Acme', name: 'Acme Labs', add_aliases: ['Acme', 'ACME Inc'] })
    expect(out).toMatchObject({ name: 'Acme Labs', previousName: 'Acme', aliases: ['Acme', 'ACME Inc'], accountsRenamed: 2 })
    expect(store.tables.chart_of_accounts.filter(a => a.company_id === 'co').map(a => a.name))
      .toEqual(['Investment — Acme Labs', 'Unrealized — Acme Labs', 'Acme receivable'])
  })

  it('refuses an empty name and a change of nothing', async () => {
    await expect(run('update_company', { company: 'co', name: ' ' })).rejects.toThrow('Name cannot be empty.')
    await expect(run('update_company', { company: 'co' })).rejects.toThrow('Nothing to change.')
  })
})

describe('set_holding_type', () => {
  it('makes a company a fund holding', async () => {
    expect(await run('set_holding_type', { company: 'co', holding_type: 'fund' })).toMatchObject({ from: 'company', to: 'fund' })
    expect(store.tables.companies.find(c => c.id === 'co')!.holding_type).toBe('fund')
  })

  it('refuses to make a fund holding with notices a company', async () => {
    store.tables.fund_capital_events.push({ id: 'ev0', fund_id: 'fund-1', company_id: 'fh', vehicle_id: 'v1' })
    await expect(run('set_holding_type', { company: 'fh', holding_type: 'company' })).rejects.toThrow(/clear_fund_register/)
  })
})

describe('move_investment', () => {
  it('moves a transaction to another holding and re-derives its entry there', async () => {
    const out = await run('move_investment', { company: 'dup', transaction_id: 't-call', to_company: 'Northwind Fund II' })
    expect(out).toMatchObject({ moved: 't-call', from: { id: 'dup' }, to: { id: 'fh' } })
    expect(store.tables.investment_transactions.find(t => t.id === 't-call')!.company_id).toBe('fh')
    expect(retract).toHaveBeenCalledTimes(1)
    expect(derive.mock.calls[0][4]).toBe('Northwind Fund II')
  })

  it('refuses a transaction the fund register owns', async () => {
    store.tables.fund_capital_events.push({ id: 'ev0', fund_id: 'fund-1', company_id: 'fh', vehicle_id: 'v1', investment_transaction_id: 't-dist' })
    await expect(run('move_investment', { company: 'fh', transaction_id: 't-dist', to_company: 'co' })).rejects.toThrow(/capital notice/)
    expect(retract).not.toHaveBeenCalled()
  })
})

describe('the fund register', () => {
  it('sets terms on the entity the holding already uses', async () => {
    const out = await run('set_fund_terms', { company: 'Northwind Fund II', commitment: 250_000, commitment_date: '2023-06-30' })
    expect(out).toMatchObject({ holding: 'Northwind Fund II', vehicleId: 'v1' })
    expect(store.tables.fund_holding_terms).toEqual([expect.objectContaining({ company_id: 'fh', vehicle_id: 'v1', commitment: 250_000, commitment_date: '2023-06-30' })])
  })

  it('refuses terms for a company', async () => {
    await expect(run('set_fund_terms', { company: 'Acme', vehicle: 'Fund I', commitment: 1 })).rejects.toThrow('is not a fund holding')
  })

  it('links a distribution to the proceeds already booked, with its character from the transaction', async () => {
    const out = await run('record_fund_notice', { company: 'fh', kind: 'distribution', event_date: '2024-06-01', amount: 20_000, transaction_id: 't-dist' })
    expect(out).toMatchObject({ mode: 'linked', status: 'confirmed', transactionId: 't-dist' })
    expect(store.tables.fund_capital_events[0]).toMatchObject({
      company_id: 'fh', vehicle_id: 'v1', kind: 'distribution', amount: 20_000, status: 'confirmed', investment_transaction_id: 't-dist',
      char_return_of_capital: 15_000, char_realized_gain: 5_000,
    })
    expect(derive).not.toHaveBeenCalled()
    // Once linked, the transaction is the notice's.
    await expect(run('record_fund_notice', { company: 'fh', kind: 'distribution', event_date: '2024-06-01', amount: 20_000, transaction_id: 't-dist' }))
      .rejects.toThrow('already linked to the fund register')
  })

  it('refuses a link to a transaction of another amount, type or holding', async () => {
    await expect(run('record_fund_notice', { company: 'fh', kind: 'distribution', event_date: '2024-06-01', amount: 19_000, transaction_id: 't-dist' }))
      .rejects.toThrow('booked 20000')
    await expect(run('record_fund_notice', { company: 'fh', kind: 'call', event_date: '2024-06-01', amount: 20_000, transaction_id: 't-dist' }))
      .rejects.toThrow('that one is proceeds')
    await expect(run('record_fund_notice', { company: 'fh', kind: 'call', event_date: '2024-01-10', amount: 100_000, transaction_id: 't-call' }))
      .rejects.toThrow('No transaction t-call on Northwind Fund II')
    expect(store.tables.fund_capital_events).toHaveLength(0)
  })

  it('books a call that is not on the books yet', async () => {
    const out = await run('record_fund_notice', { company: 'fh', kind: 'call', event_date: '2024-09-01', amount: 30_000, purpose_fees: 2_000 })
    expect(out).toMatchObject({ mode: 'booked', status: 'confirmed' })
    const ev = store.tables.fund_capital_events[0]
    expect(ev).toMatchObject({ status: 'confirmed', purpose_investments: 28_000, purpose_fees: 2_000 })
    const txn = store.tables.investment_transactions.find(t => t.id === ev.investment_transaction_id)!
    expect(txn).toMatchObject({ company_id: 'fh', transaction_type: 'investment', portfolio_group: 'Fund I' })
  })

  it('refuses a call whose purposes do not add up', async () => {
    await expect(run('record_fund_notice', { company: 'fh', kind: 'call', event_date: '2024-09-01', amount: 30_000, purpose_investments: 10_000, purpose_fees: 1_000 }))
      .rejects.toThrow('add up to 11000')
  })

  it('saves a NAV statement through the one NAV writer', async () => {
    const out = await run('record_nav_statement', { company: 'fh', as_of_date: '2024-06-30', reported_nav: 90_000 })
    expect(out).toMatchObject({ holding: 'Northwind Fund II', booking: { status: 'no_change' } })
    expect(saveNav.mock.calls[0][3]).toMatchObject({ companyId: 'fh', vehicleId: 'v1', asOfDate: '2024-06-30', reportedNav: 90_000 })
    await expect(run('record_nav_statement', { company: 'co', as_of_date: '2024-06-30', reported_nav: 1 })).rejects.toThrow('is not a fund holding')
  })
})

describe('merge_companies', () => {
  it('previews what moves', async () => {
    const p = await preview('merge_companies', { from: 'Northwind Custody', into: 'Northwind Fund II' })
    expect(p.pin).toEqual({ from: 'dup', into: 'fh' })
    expect(p.summary).toMatch(/^Merge company Northwind Custody into fund holding Northwind Fund II: move 2 investment transaction\(s\)/)
  })

  it('moves the transactions, notes and names, and keeps the empty record when its accounts carry postings', async () => {
    const out: any = await run('merge_companies', { from: 'dup', into: 'fh' })
    expect(out).toMatchObject({ transactionsMoved: 2, rowsMoved: { company_notes: 1 }, aliases: ['Northwind Custody', 'NW Custody'], deleted: false })
    expect(out.keptBecause).toMatch(/ledger posting/)
    expect(store.tables.investment_transactions.filter(t => t.company_id === 'fh').map(t => t.id).sort()).toEqual(['t-call', 't-dist', 't-mark'])
    expect(store.tables.company_notes[0].company_id).toBe('fh')
    expect(store.tables.chart_of_accounts.find(a => a.id === 'a4')!.is_active).toBe(false)
  })

  it('deletes the merged record when nothing is left on its accounts', async () => {
    store.tables.journal_postings = []
    const out: any = await run('merge_companies', { from: 'dup', into: 'fh' })
    expect(out.deleted).toBe(true)
    expect(store.tables.companies.map(c => c.id)).toEqual(['fh', 'co'])
  })

  it('moves a fund register only into a fund holding', async () => {
    store.tables.fund_holding_terms.push({ id: 'ht1', fund_id: 'fund-1', company_id: 'fh', vehicle_id: 'v1', commitment: 1 })
    await expect(run('merge_companies', { from: 'fh', into: 'co' })).rejects.toThrow('is not a fund holding')
    expect(retract).not.toHaveBeenCalled()
  })
})
