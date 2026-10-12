import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const { from, persistEntry } = vi.hoisted(() => ({ from: vi.fn(), persistEntry: vi.fn() }))
vi.mock('@/lib/accounting/persist', () => ({ accountIdByCode: async () => new Map([['1000', 'cash'], ['5100', 'expense']]), persistEntry }))
vi.mock('@/lib/accounting/vehicle-id', () => ({ vehicleIdByName: async () => 'vehicle-2' }))
vi.mock('@/lib/accounting/provision-accounts', () => ({ ensureVehicleAccounts: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/accounting/vendors', () => ({ vendorResolver: () => async () => null }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'user' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from }) }))
vi.mock('@/lib/api-helpers', () => ({ assertWriteAccess: async () => ({ fundId: 'tenant' }) }))
vi.mock('@/lib/accounting/http-vehicle', () => ({ resolveGroupOr400: async () => 'Fund II' }))

import { importBankTransactions } from '@/lib/accounting/bank-import'
import { POST as review } from '@/app/api/accounting/bank/duplicates/route'
import { POST as bankAction } from '@/app/api/accounting/bank/route'

let tables: Record<string, any[]>
let readError = false
let serial = 0
const qb = (overrides = {}) => ({ id: 'qb1', fund_id: 'tenant', vehicle_id: 'vehicle-2', book: 'actual', source_type: 'quickbooks', status: 'posted', entry_date: '2026-10-05', memo: 'Expense 42 — Acme software subscription', journal_postings: [{ account_id: 'cash', amount: -100 }, { account_id: 'expense', amount: 100 }], ...overrides })

beforeEach(() => {
  serial = 0; readError = false
  tables = {
    journal_entries: [qb()], bank_transactions: [],
    chart_of_accounts: [
      { id: 'cash', fund_id: 'tenant', vehicle_id: 'vehicle-2', code: '1000', name: 'Cash', type: 'asset', subtype: 'cash' },
      { id: 'lp', fund_id: 'tenant', vehicle_id: 'vehicle-2', code: '3100', name: "Partners' capital — LP (unallocated)", type: 'equity', subtype: 'lp_capital' },
      { id: 'expense', fund_id: 'tenant', vehicle_id: 'vehicle-2', code: '5100', name: 'Partnership expenses', type: 'expense', subtype: 'partnership_expense' },
    ],
  }
  persistEntry.mockReset().mockImplementation(async (_a, fundId, _g, _u, entry) => {
    const id = `draft-${++serial}`
    tables.journal_entries.push({ id, fund_id: fundId, status: 'draft', ...entry })
    return { entryId: id }
  })
  from.mockImplementation((table: string) => {
    const filters: ((row: any) => boolean)[] = []
    let mode = 'read'; let mutation: any; let start = 0; let end = Infinity
    const result = () => {
      if (mode === 'read' && readError) return { data: null, error: { message: 'Read failed' } }
      const selected = (tables[table] ?? []).filter(row => filters.every(f => f(row)))
      if (mode === 'delete') { tables[table] = tables[table].filter(row => !selected.includes(row)); return { data: [], error: null } }
      if (mode === 'insert' || mode === 'update') {
        if (mode === 'update' && !selected.length) return { data: [], error: null }
        const row = mode === 'insert' ? { id: `bank-${++serial}`, ...mutation } : { ...selected[0], ...mutation }
        if (table === 'bank_transactions' && tables[table].some(r => r.id !== row.id && r.fund_id === row.fund_id && r.vehicle_id === row.vehicle_id && r.dedup_hash === row.dedup_hash)) return { data: null, error: { message: 'duplicate claim' } }
        if (mode === 'insert') tables[table].push(row)
        else Object.assign(selected[0], mutation)
        return { data: [row], error: null }
      }
      return { data: selected.slice(start, end + 1), error: null }
    }
    const q: any = {
      select: () => q, order: () => q,
      eq: (k: string, v: unknown) => { filters.push(r => r[k] === v); return q },
      is: (k: string, v: unknown) => { filters.push(r => r[k] === v); return q },
      in: (k: string, vs: unknown[]) => { filters.push(r => vs.includes(r[k])); return q },
      gte: (k: string, v: string) => { filters.push(r => r[k] >= v); return q },
      lte: (k: string, v: string) => { filters.push(r => r[k] <= v); return q },
      range: (a: number, b: number) => { start = a; end = b; return q },
      limit: (n: number) => { end = n - 1; return q },
      insert: (row: any) => { mode = 'insert'; mutation = row; return q },
      update: (row: any) => { mode = 'update'; mutation = row; return q },
      delete: () => { mode = 'delete'; return q },
      maybeSingle: async () => { const r = result(); return { ...r, data: r.data?.[0] ?? null } },
      then: (resolve: any) => Promise.resolve(result()).then(resolve),
    }
    return q
  })
})

const csv = (description = 'Acme software subscription') => `Date,Description,Amount\n2026-10-06,${description},-100`
const ingest = (text = csv()) => importBankTransactions({ from } as any, 'tenant', 'Fund II', 'user', text)
const resolve = (id: string, action: string, entryId = 'qb1') => review(new NextRequest('http://localhost/api/accounting/bank/duplicates', { method: 'POST', body: JSON.stringify({ id, action, entryId, group: 'Fund II' }) }))

describe('QuickBooks first, bank second', () => {
  it('reconciles a bank row without adding to the posted ledger and skips a repeat file', async () => {
    expect(await ingest()).toMatchObject({ imported: 1, matched: 1, needsReview: 0 })
    expect(persistEntry).not.toHaveBeenCalled()
    expect(tables.bank_transactions[0]).toMatchObject({ status: 'reconciled', journal_entry_id: 'qb1', dedup_hash: 'qb-bank:qb1:out' })
    expect(await ingest()).toMatchObject({ imported: 0, skipped: 1 })
    expect(tables.journal_entries).toHaveLength(1)
  })

  it('holds uncertain descriptions without creating a postable draft', async () => {
    expect(await ingest(csv('ACH PAYMENT'))).toMatchObject({ needsReview: 1, matched: 0 })
    expect(tables.bank_transactions[0]).toMatchObject({ status: 'unmatched', journal_entry_id: null })
    expect(persistEntry).not.toHaveBeenCalled()
    const res = await resolve(tables.bank_transactions[0].id, 'link')
    expect(res.status).toBe(200)
    expect(tables.bank_transactions[0].status).toBe('reconciled')
    expect(tables.journal_entries).toHaveLength(1)
    expect(await ingest(csv('ACH PAYMENT'))).toMatchObject({ skipped: 1 })
  })

  it('never consumes one QuickBooks entry twice for identical bank payments', async () => {
    expect(await ingest(csv() + '\n2026-10-06,Acme software subscription,-100')).toMatchObject({ needsReview: 2, matched: 0 })
    const [first, second] = tables.bank_transactions
    expect((await resolve(first.id, 'link')).status).toBe(200)
    expect((await resolve(second.id, 'link')).status).toBe(409)
    expect((await resolve(second.id, 'separate')).status).toBe(200)
    expect(persistEntry).toHaveBeenCalledTimes(1)
    expect(tables.journal_entries).toHaveLength(2)
  })

  it('holds multiple ledger candidates and allows a specific choice', async () => {
    tables.journal_entries.push(qb({ id: 'qb2' }))
    expect(await ingest()).toMatchObject({ needsReview: 1 })
    expect((await resolve(tables.bank_transactions[0].id, 'link', 'qb2')).status).toBe(200)
    expect(tables.bank_transactions[0].journal_entry_id).toBe('qb2')
  })

  it('links both cash directions of a transfer without booking either again', async () => {
    tables.journal_entries = [qb({ journal_postings: [{ account_id: 'cash', amount: -100 }, { account_id: 'cash', amount: 100 }] })]
    expect(await ingest(csv('Transfer out') + '\n2026-10-06,Transfer in,100')).toMatchObject({ needsReview: 2 })
    for (const row of tables.bank_transactions) expect((await resolve(row.id, 'link')).status).toBe(200)
    expect(tables.bank_transactions.map(t => t.dedup_hash)).toEqual(['qb-bank:qb1:out', 'qb-bank:qb1:in'])
    expect(persistEntry).not.toHaveBeenCalled()
    expect(tables.journal_entries).toHaveLength(1)
  })

  it('does not dedupe against another vehicle, the tax book, void entries, or noncash postings', async () => {
    tables.journal_entries = [qb({ vehicle_id: 'vehicle-1' }), qb({ id: 'tax', book: 'tax' }), qb({ id: 'void', status: 'void' }), qb({ id: 'noncash', journal_postings: [{ account_id: 'expense', amount: -100 }] })]
    expect(await ingest()).toMatchObject({ matched: 0, needsReview: 0, imported: 1 })
    expect(persistEntry).toHaveBeenCalledTimes(1)
  })

  it('holds QuickBooks drafts and refuses to silently post them', async () => {
    tables.journal_entries[0].status = 'draft'
    expect(await ingest()).toMatchObject({ needsReview: 1 })
    expect((await resolve(tables.bank_transactions[0].id, 'link')).status).toBe(400)
    expect(persistEntry).not.toHaveBeenCalled()
  })

  it('refuses to import when the duplicate index cannot be read', async () => {
    readError = true
    expect(await ingest()).toHaveProperty('error')
    expect(persistEntry).not.toHaveBeenCalled()
    expect(tables.bank_transactions).toEqual([])
  })

  it('rejects a forged cross-vehicle match and a second review of a resolved row', async () => {
    tables.journal_entries.push(qb({ id: 'foreign', vehicle_id: 'vehicle-1' }))
    await ingest(csv('ACH PAYMENT'))
    const id = tables.bank_transactions[0].id
    expect((await resolve(id, 'link', 'foreign')).status).toBe(400)
    expect((await resolve(id, 'separate')).status).toBe(200)
    expect((await resolve(id, 'separate')).status).toBe(409)
    expect(persistEntry).toHaveBeenCalledTimes(1)
  })

  it('protects a matched QuickBooks entry from bank ignore, unpost, and recategorization', async () => {
    await ingest()
    const id = tables.bank_transactions[0].id
    for (const action of ['ignore', 'unpost', 'setAccount']) {
      const res = await bankAction(new NextRequest('http://localhost/api/accounting/bank', {
        method: 'POST', body: JSON.stringify({ id, action, accountCode: '5100', group: 'Fund II' }),
      }))
      expect(res.status).toBe(400)
    }
    expect(tables.journal_entries[0].status).toBe('posted')
    expect(tables.bank_transactions[0].status).toBe('reconciled')
  })

  it('does not bulk-post a row awaiting duplicate review', async () => {
    await ingest(csv('ACH PAYMENT'))
    const res = await bankAction(new NextRequest('http://localhost/api/accounting/bank', {
      method: 'POST', body: JSON.stringify({ ids: [tables.bank_transactions[0].id], action: 'postMany', group: 'Fund II' }),
    }))
    expect(await res.json()).toMatchObject({ posted: 0 })
    expect(tables.bank_transactions[0].status).toBe('unmatched')
    expect(persistEntry).not.toHaveBeenCalled()
  })
})
