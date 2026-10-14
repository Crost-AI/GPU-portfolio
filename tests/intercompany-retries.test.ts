import { beforeEach, describe, expect, it, vi } from 'vitest'

// An in-memory Supabase with just enough PostgREST to run the real issuance, settlement and
// balance code: filters, order, range, the 1000-row cap, and the two unique indexes from
// 20261014190000 (one live charge per invoice, one live settlement entry per vehicle).
type Row = Record<string, any>
const FUND = 'fund'
const MANCO = 'manco-vehicle'
const FUNDV = 'fund-vehicle'
const NAMES: Record<string, string> = { [MANCO]: 'Manco', [FUNDV]: 'Fund I' }

const mocks = vi.hoisted(() => ({ persist: vi.fn(), liveEntryByRef: vi.fn() }))
vi.mock('@/lib/accounting/vehicle-id', () => ({
  vehicleIdByName: async (_a: unknown, _f: string, name: string) => Object.keys(NAMES).find(id => NAMES[id] === name) ?? null,
  vehicleNameById: async (_a: unknown, _f: string, id: string) => NAMES[id] ?? null,
}))
vi.mock('@/lib/accounting/persist', () => ({ persistEntry: mocks.persist, liveEntryByRef: mocks.liveEntryByRef }))
import { issuePartnershipInvoice } from '@/lib/accounting/partnership-invoices'
import { intercompanyBalances, settleIntercompanyCharge } from '@/lib/accounting/intercompany'

function fakeDb(tables: Record<string, Row[]>) {
  let seq = 0
  const log: { table: string; op: string; order?: string; range?: [number, number] }[] = []
  const failNext: { table: string; when: (patch: Row) => boolean }[] = []
  let insertGate: ((table: string) => Promise<void>) | null = null
  const uniqueViolation = (table: string, row: Row) => {
    const live = (r: Row) => r.status !== 'void'
    if (table === 'intercompany_transactions' && row.partnership_invoice_id) {
      return tables[table].some(r => live(r) && r.partnership_invoice_id === row.partnership_invoice_id)
    }
    return false
  }
  const from = (table: string) => {
    tables[table] ??= []
    let op = 'select', payload: any, returning = false, order: string | undefined, range: [number, number] | undefined, limit: number | undefined
    const filters: ((r: Row) => boolean)[] = []
    const exec = async (): Promise<{ data: any; error: any }> => {
      log.push({ table, op, order, range })
      const match = () => tables[table].filter(r => filters.every(f => f(r)))
      if (op === 'insert') {
        if (insertGate) await insertGate(table)
        const rows = (Array.isArray(payload) ? payload : [payload]).map((r: Row) => ({ id: `${table}-${++seq}`, ...r }))
        for (const r of rows) {
          if (uniqueViolation(table, r)) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } }
        }
        tables[table].push(...rows)
        return { data: rows, error: null }
      }
      if (op === 'update') {
        const i = failNext.findIndex(f => f.table === table && f.when(payload))
        if (i >= 0) { failNext.splice(i, 1); return { data: null, error: { message: 'connection reset' } } }
        const rows = match()
        for (const r of rows) Object.assign(r, payload)
        return { data: returning ? rows.map(r => ({ id: r.id })) : null, error: null }
      }
      if (op === 'delete') {
        const gone = new Set(match())
        tables[table] = tables[table].filter(r => !gone.has(r))
        return { data: null, error: null }
      }
      let rows = match()
      if (order) rows = [...rows].sort((a, b) => String(a[order!]).localeCompare(String(b[order!])))
      // PostgREST's max_rows: an unranged read silently stops at 1000.
      const [lo, hi] = range ?? [0, Math.min(limit ?? 1000, 1000) - 1]
      return { data: rows.slice(lo, hi + 1), error: null }
    }
    const q: any = {
      select: () => { if (op === 'select') return q; returning = true; return q },
      insert: (rows: any) => { op = 'insert'; payload = rows; return q },
      update: (patch: Row) => { op = 'update'; payload = patch; return q },
      delete: () => { op = 'delete'; return q },
      eq: (c: string, v: unknown) => { filters.push(r => r[c] === v); return q },
      neq: (c: string, v: unknown) => { filters.push(r => r[c] !== v); return q },
      in: (c: string, vs: unknown[]) => { filters.push(r => vs.includes(r[c])); return q },
      is: (c: string, v: unknown) => { filters.push(r => (r[c] ?? null) === v); return q },
      order: (c: string) => { order = c; return q },
      range: (lo: number, hi: number) => { range = [lo, hi]; return q },
      limit: (n: number) => { limit = n; return q },
      maybeSingle: async () => { const { data, error } = await exec(); return { data: Array.isArray(data) ? data[0] ?? null : data, error } },
      single: async () => { const { data, error } = await exec(); return { data: Array.isArray(data) ? data[0] ?? null : data, error } },
      then: (ok: any, bad: any) => exec().then(ok, bad),
    }
    return q
  }
  return {
    admin: { from } as any,
    tables, log,
    failNextUpdate: (table: string, when: (patch: Row) => boolean) => failNext.push({ table, when }),
    gateInserts: (g: typeof insertGate) => { insertGate = g },
  }
}

/** Resolves for every caller once `n` have arrived, in arrival order. */
function barrier(n: number) {
  let arrived = 0
  let release!: () => void
  const all = new Promise<void>(r => { release = r })
  return () => { if (++arrived >= n) release(); return all }
}

function world() {
  const chart = (vehicle_id: string, rows: [string, string][]) =>
    rows.map(([code, subtype]) => ({ id: `${vehicle_id}:${code}`, fund_id: FUND, vehicle_id, code, subtype }))
  const db = fakeDb({
    fund_vehicles: [{ id: MANCO, fund_id: FUND, name: 'Manco' }, { id: FUNDV, fund_id: FUND, name: 'Fund I' }],
    chart_of_accounts: [
      ...chart(MANCO, [['1000', 'cash'], ['4100', 'reimbursement_income']]),
      ...chart(FUNDV, [['1000', 'cash'], ['5100', 'partnership_expense']]),
    ],
    partnership_invoices: [{
      id: 'inv-1', fund_id: FUND, from_vehicle_id: MANCO, to_vehicle_id: FUNDV, period_start: '2026-01-01', period_end: '2026-03-31',
      invoice_number: 'INV-1', invoice_date: '2026-04-05', amount: 100, currency: 'USD', status: 'draft', intercompany_transaction_id: null,
    }],
    partnership_invoice_lines: [{ fund_id: FUND, invoice_id: 'inv-1', journal_entry_id: 'exp-1', journal_posting_id: 'exp-1-p', amount: 100, active: true }],
    journal_entries: [{ id: 'exp-1', fund_id: FUND, vehicle_id: MANCO, book: 'actual', status: 'posted', entry_date: '2026-02-01', vendor_id: null }],
    journal_postings: [{ id: 'exp-1-p', book: 'actual', amount: 100 }],
    receipts: [],
    intercompany_transactions: [],
  })
  // persistEntry writes a posted entry, and the settlement index refuses a second live one.
  mocks.persist.mockImplementation(async (_a: unknown, fundId: string, group: string, _u: unknown, entry: any) => {
    const vehicle_id = Object.keys(NAMES).find(id => NAMES[id] === group)
    const live = db.tables.journal_entries.find(e =>
      e.vehicle_id === vehicle_id && e.source_ref === entry.sourceRef && e.status !== 'void' && String(entry.sourceRef).startsWith('intercompany-settlement:'))
    if (live) return { error: `This entry is already in the books as entry ${live.id}`, duplicateOf: live.id }
    const id = `je-${db.tables.journal_entries.length}`
    db.tables.journal_entries.push({ id, fund_id: fundId, vehicle_id, book: 'actual', status: 'posted', entry_date: entry.entryDate, source_ref: entry.sourceRef })
    return { entryId: id }
  })
  mocks.liveEntryByRef.mockImplementation(async (_a: unknown, _f: string, vehicleId: string, ref: string) => {
    const e = db.tables.journal_entries.find(r => r.vehicle_id === vehicleId && r.source_ref === ref && r.status !== 'void')
    return e ? { id: e.id, status: e.status, entryDate: e.entry_date } : null
  })
  return db
}

beforeEach(() => { vi.clearAllMocks() })

describe('issuing a partnership invoice', () => {
  it('books the fund side once when two issues race past the draft check', async () => {
    const db = world()
    // Hold every charge insert until both requests have read the invoice as a draft and found no
    // charge: the window the old code had no defence for.
    const bothArrived = barrier(2)
    db.gateInserts(async table => { if (table === 'intercompany_transactions') await bothArrived() })

    const results = await Promise.all([
      issuePartnershipInvoice(db.admin, FUND, 'u', 'inv-1'),
      issuePartnershipInvoice(db.admin, FUND, 'u', 'inv-1'),
    ])

    expect(results.filter(r => 'ok' in r)).toHaveLength(1)
    expect(results.find(r => 'error' in r)).toMatchObject({ status: 409, error: expect.stringContaining('another request') })
    expect(mocks.persist).toHaveBeenCalledTimes(1)
    const charges = db.tables.intercompany_transactions.filter(c => c.status !== 'void')
    expect(charges).toHaveLength(1)
    expect(charges[0].partnership_invoice_id).toBe('inv-1')
    expect(db.tables.partnership_invoices[0]).toMatchObject({ status: 'issued', intercompany_transaction_id: charges[0].id })
  })

  it('finishes a half-issued invoice on retry without booking the fund side again', async () => {
    const db = world()
    db.failNextUpdate('partnership_invoices', patch => patch.status === 'issued')

    const first = await issuePartnershipInvoice(db.admin, FUND, 'u', 'inv-1')
    expect(first).toMatchObject({ error: expect.stringContaining('Issue it again') })
    expect(db.tables.partnership_invoices[0].status).toBe('draft')
    expect(mocks.persist).toHaveBeenCalledTimes(1)

    const retry = await issuePartnershipInvoice(db.admin, FUND, 'u', 'inv-1')
    const chargeId = db.tables.intercompany_transactions[0].id
    expect(retry).toEqual({ ok: true, intercompanyTransactionId: chargeId })
    expect(mocks.persist).toHaveBeenCalledTimes(1)
    expect(db.tables.intercompany_transactions).toHaveLength(1)
    expect(db.tables.partnership_invoices[0]).toMatchObject({ status: 'issued', intercompany_transaction_id: chargeId })
  })
})

describe('settling an intercompany charge', () => {
  const accrued = (db: ReturnType<typeof world>) => db.tables.intercompany_transactions.push({
    id: 'ic-1', fund_id: FUND, from_vehicle_id: FUNDV, to_vehicle_id: MANCO, kind: 'expense_reimbursement',
    charge_date: '2026-04-05', amount: 100, memo: null, status: 'accrued',
  })
  const settlements = (db: ReturnType<typeof world>) =>
    db.tables.journal_entries.filter(e => e.source_ref === 'intercompany-settlement:ic-1' && e.status !== 'void')

  it('posts the cash once when two settles race past the status check', async () => {
    const db = world()
    accrued(db)
    // Hold the first two posts until both requests have passed the status read and the ledger check.
    const bothArrived = barrier(2)
    const persist = mocks.persist.getMockImplementation()!
    let calls = 0
    mocks.persist.mockImplementation(async (...args: any[]) => {
      if (++calls <= 2) await bothArrived()
      return persist(...args)
    })

    const results = await Promise.all([
      settleIntercompanyCharge(db.admin, FUND, 'u', 'ic-1', '2026-05-01'),
      settleIntercompanyCharge(db.admin, FUND, 'u', 'ic-1', '2026-05-01'),
    ])

    expect(results.filter(r => 'ok' in r)).toHaveLength(1)
    expect(results.find(r => 'error' in r)).toMatchObject({ error: expect.stringContaining('another request') })
    // One payee entry and one payer entry: the loser posted nothing on the payer's books.
    expect(settlements(db).map(e => e.vehicle_id).sort()).toEqual([FUNDV, MANCO])
    const row = db.tables.intercompany_transactions[0]
    expect(row.status).toBe('settled')
    expect([row.to_settlement_entry_id, row.from_settlement_entry_id].sort()).toEqual(settlements(db).map(e => e.id).sort())
  })

  it('finishes a half-settled charge on retry without posting the cash again', async () => {
    const db = world()
    accrued(db)
    db.failNextUpdate('intercompany_transactions', patch => patch.status === 'settled')

    const first = await settleIntercompanyCharge(db.admin, FUND, 'u', 'ic-1', '2026-05-01')
    expect(first).toMatchObject({ error: expect.stringContaining('Settle it again') })
    expect(db.tables.intercompany_transactions[0].status).toBe('accrued')
    expect(mocks.persist).toHaveBeenCalledTimes(2)

    const retry = await settleIntercompanyCharge(db.admin, FUND, 'u', 'ic-1', '2026-06-30')
    expect(retry).toEqual({ ok: true })
    expect(mocks.persist).toHaveBeenCalledTimes(2)
    const [payeeEntry] = settlements(db).filter(e => e.vehicle_id === MANCO)
    // Dated when the cash entries were, not when the retry happened.
    expect(db.tables.intercompany_transactions[0]).toMatchObject({
      status: 'settled', settled_date: '2026-05-01', to_settlement_entry_id: payeeEntry.id,
    })
  })

  it('refuses rather than posting when only one side of a settlement is on the books', async () => {
    const db = world()
    accrued(db)
    db.tables.journal_entries.push({ id: 'orphan', fund_id: FUND, vehicle_id: MANCO, book: 'actual', status: 'posted', entry_date: '2026-05-01', source_ref: 'intercompany-settlement:ic-1' })

    const res = await settleIntercompanyCharge(db.admin, FUND, 'u', 'ic-1', '2026-05-01')
    expect(res).toMatchObject({ error: expect.stringContaining('orphan') })
    expect(mocks.persist).not.toHaveBeenCalled()
    expect(db.tables.intercompany_transactions[0].status).toBe('accrued')
  })
})

describe('intercompany balances', () => {
  it('reads every posting past the 1000-row cap, in a stable order', async () => {
    const db = world()
    const dueFrom = { id: 'manco:1900-fund-veh', fund_id: FUND, vehicle_id: MANCO, code: `1900-${FUNDV.slice(0, 8)}`, subtype: 'intercompany_receivable' }
    db.tables.chart_of_accounts.push(dueFrom)
    for (let i = 0; i < 1500; i++) {
      const id = `bal-${String(i).padStart(4, '0')}`
      db.tables.journal_entries.push({ id, fund_id: FUND, vehicle_id: MANCO, book: 'actual', status: 'posted' })
      db.tables.journal_postings.push({ id: `${id}-p`, fund_id: FUND, vehicle_id: MANCO, book: 'actual', journal_entry_id: id, account_id: dueFrom.id, amount: 1 })
    }

    const [row] = await intercompanyBalances(db.admin, FUND, 'Manco')
    expect(row).toMatchObject({ counterpartyVehicleId: FUNDV, dueFrom: 1500, dueTo: 0, net: 1500 })
    for (const table of ['journal_entries', 'journal_postings']) {
      const reads = db.log.filter(l => l.table === table && l.op === 'select')
      expect(reads.map(r => r.range)).toEqual([[0, 999], [1000, 1999]])
      expect(reads.every(r => r.order === 'id')).toBe(true)
    }
  })
})
