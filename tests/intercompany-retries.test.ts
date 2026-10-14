import { beforeEach, describe, expect, it, vi } from 'vitest'

// An in-memory Supabase with just enough PostgREST to run the real issuance, settlement and
// balance code: filters, order, range, the 1000-row cap, and the two unique indexes from
// 20261014190000 (one live charge per invoice, one live settlement entry per vehicle).
//
// The settlement index is modelled inside the persistEntry mock below, not by the fake database, so
// its real predicate (`source_ref like 'intercompany-settlement:%' and status <> 'void'`) is checked
// only by reading the migration. The phased tests cover the race the indexes cannot: a posted header
// that is not yet a finished posting.
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
import { issuePartnershipInvoice, voidPartnershipInvoice } from '@/lib/accounting/partnership-invoices'
import { intercompanyBalances, settleIntercompanyCharge } from '@/lib/accounting/intercompany'

function fakeDb(tables: Record<string, Row[]>) {
  let seq = 0
  const log: { table: string; op: string; order?: string; range?: [number, number] }[] = []
  // An update that fails outright, or (commit) one that lands but whose response is lost.
  const failNext: { table: string; when: (patch: Row) => boolean; commit?: boolean }[] = []
  const failDeletes: { table: string }[] = []
  const failSelects: { table: string }[] = []
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
        const fail = i >= 0 ? failNext.splice(i, 1)[0] : null
        if (fail && !fail.commit) return { data: null, error: { message: 'connection reset' } }
        const rows = match()
        if (fail) { for (const r of rows) Object.assign(r, payload); return { data: null, error: { message: 'connection reset' } } }
        for (const r of rows) Object.assign(r, payload)
        return { data: returning ? rows.map(r => ({ id: r.id })) : null, error: null }
      }
      if (op === 'delete') {
        const d = failDeletes.findIndex(f => f.table === table)
        if (d >= 0) { failDeletes.splice(d, 1); return { data: null, error: { message: 'Period "Q2 2026" is closed. Reopen it before creating or changing entries' } } }
        const gone = new Set(match())
        tables[table] = tables[table].filter(r => !gone.has(r))
        return { data: null, error: null }
      }
      const f = failSelects.findIndex(x => x.table === table)
      if (f >= 0) { failSelects.splice(f, 1); return { data: null, error: { message: 'connection reset' } } }
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
      like: (c: string, pattern: string) => { const re = new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')}$`); filters.push(r => re.test(String(r[c] ?? ''))); return q },
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
    loseNextUpdateResponse: (table: string, when: (patch: Row) => boolean) => failNext.push({ table, when, commit: true }),
    failNextDelete: (table: string) => failDeletes.push({ table }),
    failNextSelect: (table: string) => failSelects.push({ table }),
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
    db.tables.journal_entries.push({ id, fund_id: fundId, vehicle_id, book: 'actual', status: 'posted', entry_date: entry.entryDate, source_ref: entry.sourceRef, source_type: entry.sourceType })
    return { entryId: id }
  })
  mocks.liveEntryByRef.mockImplementation(async (_a: unknown, fundId: string, vehicleId: string, ref: string) => {
    const e = db.tables.journal_entries.find(r => r.fund_id === fundId && r.vehicle_id === vehicleId && r.book === 'actual' && r.source_ref === ref && r.status !== 'void')
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

describe('re-issuing an invoice whose charge already exists', () => {
  const fundEntry = (db: ReturnType<typeof world>) => db.tables.journal_entries.find(e => e.vehicle_id === FUNDV && String(e.source_ref).startsWith('intercompany:'))!

  it('does not mark the invoice issued when the fund entry was voided in between', async () => {
    const db = world()
    db.failNextUpdate('partnership_invoices', patch => patch.status === 'issued')
    await issuePartnershipInvoice(db.admin, FUND, 'u', 'inv-1')
    fundEntry(db).status = 'void'

    const retry = await issuePartnershipInvoice(db.admin, FUND, 'u', 'inv-1')
    expect(retry).toMatchObject({ status: 409, error: expect.stringContaining('was voided') })
    expect(db.tables.partnership_invoices[0].status).toBe('draft')
    expect(db.tables.intercompany_transactions[0].status).toBe('void')
    expect(mocks.persist).toHaveBeenCalledTimes(1)
  })

  it('refuses while the linked fund entry is only a draft', async () => {
    const db = world()
    db.failNextUpdate('partnership_invoices', patch => patch.status === 'issued')
    await issuePartnershipInvoice(db.admin, FUND, 'u', 'inv-1')
    fundEntry(db).status = 'draft'

    const retry = await issuePartnershipInvoice(db.admin, FUND, 'u', 'inv-1')
    expect(retry).toMatchObject({ status: 409, error: expect.stringContaining('is a draft') })
    expect(db.tables.partnership_invoices[0].status).toBe('draft')
  })

  it('never adopts a posted fund entry whose issue is still allocating it', async () => {
    const db = world()
    // Request A: the fund entry is written and flipped to posted, then allocation runs (held here)
    // and fails, and persistEntry deletes the entry. A posted header is not a finished posting.
    let reached!: () => void
    const atAllocation = new Promise<void>(r => { reached = r })
    let finishAllocation!: () => void
    const allocation = new Promise<void>(r => { finishAllocation = r })
    const persist = mocks.persist.getMockImplementation()!
    mocks.persist.mockImplementationOnce(async (...args: any[]) => {
      const res = await persist(...args)
      reached()
      await allocation
      db.tables.journal_entries = db.tables.journal_entries.filter(e => e.id !== res.entryId)
      return { error: 'Entry was not posted because its partner allocation failed: no bridge account', allocationFailed: true }
    })

    const a = issuePartnershipInvoice(db.admin, FUND, 'u', 'inv-1')
    await atAllocation
    expect(fundEntry(db).status).toBe('posted')

    // Request B sees the charge and A's posted entry, and must not take it as booked.
    const b = await issuePartnershipInvoice(db.admin, FUND, 'u', 'inv-1')
    expect(b).toMatchObject({ status: 409, error: expect.stringContaining('another request') })
    expect(db.tables.partnership_invoices[0].status).toBe('draft')
    expect(db.tables.intercompany_transactions[0].from_entry_id ?? null).toBeNull()

    finishAllocation()
    expect(await a).toMatchObject({ error: expect.stringContaining('allocation failed') })
    expect(mocks.persist).toHaveBeenCalledTimes(1)
    expect(db.tables.partnership_invoices[0]).toMatchObject({ status: 'draft', intercompany_transaction_id: null })
    expect(db.tables.intercompany_transactions).toHaveLength(0)
    expect(db.tables.journal_entries.filter(e => e.vehicle_id === FUNDV && String(e.source_ref).startsWith('intercompany:'))).toHaveLength(0)
  })

  it('retries a failed link once, and finishes when the retry lands', async () => {
    const db = world()
    db.failNextUpdate('intercompany_transactions', patch => 'from_entry_id' in patch)

    const res = await issuePartnershipInvoice(db.admin, FUND, 'u', 'inv-1')
    const charge = db.tables.intercompany_transactions[0]
    expect(res).toEqual({ ok: true, intercompanyTransactionId: charge.id })
    expect(charge.from_entry_id).toBe(fundEntry(db).id)
    expect(mocks.persist).toHaveBeenCalledTimes(1)
  })

  it('unwinds the fund entry and the charge when the link cannot be written, leaving no orphan', async () => {
    const db = world()
    db.failNextUpdate('intercompany_transactions', patch => 'from_entry_id' in patch)
    db.failNextUpdate('intercompany_transactions', patch => 'from_entry_id' in patch)

    const first = await issuePartnershipInvoice(db.admin, FUND, 'u', 'inv-1')
    expect(first).toMatchObject({ error: expect.stringContaining('could not be linked') })
    expect(db.tables.intercompany_transactions).toHaveLength(0)
    expect(db.tables.journal_entries.filter(e => String(e.source_ref).startsWith('intercompany:'))).toHaveLength(0)
    expect(db.tables.partnership_invoices[0].status).toBe('draft')

    // Nothing left behind, so issuing again simply books it.
    const retry = await issuePartnershipInvoice(db.admin, FUND, 'u', 'inv-1')
    expect(retry).toMatchObject({ ok: true })
    expect(db.tables.partnership_invoices[0].status).toBe('issued')
  })
})

describe('voiding a draft invoice while it is being issued', () => {
  it('unwinds the fresh fund entry when the charge was voided before it could be linked', async () => {
    const db = world()
    // Hold A before it writes the fund entry: the charge exists, unlinked, with nothing behind it.
    let reached!: () => void
    const atPost = new Promise<void>(r => { reached = r })
    let go!: () => void
    const held = new Promise<void>(r => { go = r })
    const persist = mocks.persist.getMockImplementation()!
    mocks.persist.mockImplementationOnce(async (...args: any[]) => { reached(); await held; return persist(...args) })

    const a = issuePartnershipInvoice(db.admin, FUND, 'u', 'inv-1')
    await atPost
    expect(await voidPartnershipInvoice(db.admin, FUND, 'inv-1')).toEqual({ ok: true })
    go()

    expect(await a).toMatchObject({ error: expect.stringContaining('neither side was booked') })
    expect(db.tables.partnership_invoices[0].status).toBe('void')
    expect(db.tables.journal_entries.filter(e => String(e.source_ref).startsWith('intercompany:'))).toHaveLength(0)
    // The voided charge is kept as the record of what happened, not deleted by the unwind.
    expect(db.tables.intercompany_transactions).toHaveLength(1)
    expect(db.tables.intercompany_transactions[0].status).toBe('void')
    expect(db.tables.intercompany_transactions[0].from_entry_id ?? null).toBeNull()
  })

  it('unwinds the fresh fund entry when the invoice was voided before its charge existed', async () => {
    const db = world()
    // Hold A's charge insert: it has read the invoice as a draft, and the void finds no charge yet.
    let reached!: () => void
    const atInsert = new Promise<void>(r => { reached = r })
    let go!: () => void
    const held = new Promise<void>(r => { go = r })
    db.gateInserts(async table => { if (table === 'intercompany_transactions') { reached(); await held } })

    const a = issuePartnershipInvoice(db.admin, FUND, 'u', 'inv-1')
    await atInsert
    db.gateInserts(null)
    expect(await voidPartnershipInvoice(db.admin, FUND, 'inv-1')).toEqual({ ok: true })
    go()

    expect(await a).toMatchObject({ status: 409, error: expect.stringContaining('Nothing is booked') })
    expect(db.tables.partnership_invoices[0].status).toBe('void')
    expect(db.tables.journal_entries.filter(e => String(e.source_ref).startsWith('intercompany:'))).toHaveLength(0)
    expect(db.tables.intercompany_transactions.every(c => c.status === 'void')).toBe(true)
  })
})

describe('a lost or refused write on the way out', () => {
  const fundEntries = (db: ReturnType<typeof world>) => db.tables.journal_entries.filter(e => String(e.source_ref).startsWith('intercompany:'))

  it('accepts a charge link that committed although its response was lost', async () => {
    const db = world()
    db.loseNextUpdateResponse('intercompany_transactions', patch => 'from_entry_id' in patch)

    const res = await issuePartnershipInvoice(db.admin, FUND, 'u', 'inv-1')
    expect(res).toMatchObject({ ok: true })
    expect(fundEntries(db)).toHaveLength(1)
    expect(db.tables.intercompany_transactions[0].from_entry_id).toBe(fundEntries(db)[0].id)
  })

  it('undoes nothing when it cannot tell whether a failed link committed', async () => {
    const db = world()
    db.failNextUpdate('intercompany_transactions', patch => 'from_entry_id' in patch)
    // The retried link fails too, and so does the re-read that would say whether it landed.
    db.failNextUpdate('intercompany_transactions', patch => {
      if (!('from_entry_id' in patch)) return false
      db.failNextSelect('intercompany_transactions')
      return true
    })

    const res = await issuePartnershipInvoice(db.admin, FUND, 'u', 'inv-1')
    const [entry] = fundEntries(db)
    const charge = db.tables.intercompany_transactions[0]
    expect(res).toMatchObject({ error: expect.stringContaining('Nothing was undone') })
    expect((res as any).error).toContain(charge.id)
    expect((res as any).error).toContain(entry.id)
    expect(entry.status).toBe('posted')
    expect(db.tables.partnership_invoices[0].status).toBe('draft')
  })

  it('keeps the charge, and names what is left, when the unwind is refused', async () => {
    const db = world()
    db.failNextUpdate('intercompany_transactions', patch => 'from_entry_id' in patch)
    db.failNextUpdate('intercompany_transactions', patch => 'from_entry_id' in patch)
    db.failNextDelete('journal_postings')

    const res = await issuePartnershipInvoice(db.admin, FUND, 'u', 'inv-1')
    const [left] = fundEntries(db)
    expect(res).toMatchObject({ error: expect.stringContaining(left.id) })
    expect((res as any).error).not.toContain('neither side was booked')
    // The charge stays as the guard: issuing again is refused rather than booking over it.
    expect(db.tables.intercompany_transactions).toHaveLength(1)
    expect(await issuePartnershipInvoice(db.admin, FUND, 'u', 'inv-1')).toMatchObject({ status: 409 })
    expect(mocks.persist).toHaveBeenCalledTimes(1)
  })
})

describe('voiding a draft invoice that carries a charge', () => {
  const orphan = (db: ReturnType<typeof world>) => db.tables.intercompany_transactions.push({
    id: 'ic-orphan', fund_id: FUND, from_vehicle_id: FUNDV, to_vehicle_id: MANCO, kind: 'expense_reimbursement',
    charge_date: '2026-04-05', amount: 100, status: 'accrued', partnership_invoice_id: 'inv-1', from_entry_id: null,
  })

  it('refuses while an unlinked charge has a live entry on the fund, naming it', async () => {
    const db = world()
    orphan(db)
    db.tables.journal_entries.push({ id: 'fund-orphan', fund_id: FUND, vehicle_id: FUNDV, book: 'actual', status: 'posted', entry_date: '2026-04-05', source_ref: 'intercompany:ic-orphan' })

    const res = await voidPartnershipInvoice(db.admin, FUND, 'inv-1')
    expect(res).toMatchObject({ status: 409, error: expect.stringContaining('fund-orphan') })
    expect(db.tables.partnership_invoices[0].status).toBe('draft')
    expect(db.tables.intercompany_transactions[0].status).toBe('accrued')
  })

  it('voids the charge with the invoice once nothing is booked behind it', async () => {
    const db = world()
    orphan(db)

    expect(await voidPartnershipInvoice(db.admin, FUND, 'inv-1')).toEqual({ ok: true })
    expect(db.tables.partnership_invoices[0].status).toBe('void')
    expect(db.tables.intercompany_transactions[0].status).toBe('void')
  })

  it('refuses while a linked charge\'s fund entry is live', async () => {
    const db = world()
    db.failNextUpdate('partnership_invoices', patch => patch.status === 'issued')
    await issuePartnershipInvoice(db.admin, FUND, 'u', 'inv-1')

    const res = await voidPartnershipInvoice(db.admin, FUND, 'inv-1')
    expect(res).toMatchObject({ status: 409, error: expect.stringContaining('Void that entry first') })
    expect(db.tables.partnership_invoices[0].status).toBe('draft')
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
    expect(results.find(r => 'error' in r)).toMatchObject({ error: expect.any(String) })
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

  // Before 20261014190000 settlement entries carried the accrual's ref; only source_type told them apart.
  const legacy = (db: ReturnType<typeof world>, vehicle_id: string, id: string) => db.tables.journal_entries.push({
    id, fund_id: FUND, vehicle_id, book: 'actual', status: 'posted', entry_date: '2026-05-01',
    source_ref: 'intercompany:ic-1', source_type: 'intercompany_settlement',
  })

  it('finishes a pre-migration half-settled charge without posting the cash again', async () => {
    const db = world()
    accrued(db)
    // The accrual entries share the legacy ref and must not be mistaken for settlements.
    db.tables.journal_entries.push({ id: 'accrual-fund', fund_id: FUND, vehicle_id: FUNDV, book: 'actual', status: 'posted', entry_date: '2026-04-05', source_ref: 'intercompany:ic-1', source_type: 'intercompany' })
    legacy(db, MANCO, 'legacy-payee')
    legacy(db, FUNDV, 'legacy-payer')

    const results = await Promise.all([
      settleIntercompanyCharge(db.admin, FUND, 'u', 'ic-1', '2026-06-30'),
      settleIntercompanyCharge(db.admin, FUND, 'u', 'ic-1', '2026-06-30'),
    ])
    expect(results).toEqual([{ ok: true }, { ok: true }])
    expect(mocks.persist).not.toHaveBeenCalled()
    expect(db.tables.intercompany_transactions[0]).toMatchObject({
      status: 'settled', settled_date: '2026-05-01', to_settlement_entry_id: 'legacy-payee', from_settlement_entry_id: 'legacy-payer',
    })
  })

  it('refuses a pre-migration one-sided settlement, naming the orphan', async () => {
    const db = world()
    accrued(db)
    legacy(db, FUNDV, 'legacy-orphan')

    const res = await settleIntercompanyCharge(db.admin, FUND, 'u', 'ic-1', '2026-05-01')
    expect(res).toMatchObject({ error: expect.stringContaining('legacy-orphan') })
    expect(mocks.persist).not.toHaveBeenCalled()
    expect(db.tables.intercompany_transactions[0].status).toBe('accrued')
  })

  it('names an unlinked settlement entry left by a request that died before linking it', async () => {
    const db = world()
    accrued(db)
    // Posted by persistEntry, then the request died before writing to_settlement_entry_id.
    db.tables.journal_entries.push({ id: 'orphan', fund_id: FUND, vehicle_id: MANCO, book: 'actual', status: 'posted', entry_date: '2026-05-01', source_ref: 'intercompany-settlement:ic-1' })

    const res = await settleIntercompanyCharge(db.admin, FUND, 'u', 'ic-1', '2026-05-02')
    expect(res).toMatchObject({ error: expect.stringMatching(/orphan, dated 2026-05-01.*void that entry/) })
    // The index refused the second payee entry; nothing was posted on the payer's books either.
    expect(settlements(db).map(e => e.id)).toEqual(['orphan'])
    expect(db.tables.intercompany_transactions[0]).toMatchObject({ status: 'accrued' })
    expect(db.tables.intercompany_transactions[0].to_settlement_entry_id ?? null).toBeNull()
  })

  it('finishes from linked ids without posting when both sides are linked but the row is accrued', async () => {
    const db = world()
    accrued(db)
    db.tables.journal_entries.push(
      { id: 'set-payee', fund_id: FUND, vehicle_id: MANCO, book: 'actual', status: 'posted', entry_date: '2026-05-01', source_ref: 'intercompany-settlement:ic-1' },
      { id: 'set-payer', fund_id: FUND, vehicle_id: FUNDV, book: 'actual', status: 'posted', entry_date: '2026-05-01', source_ref: 'intercompany-settlement:ic-1' },
    )
    Object.assign(db.tables.intercompany_transactions[0], { to_settlement_entry_id: 'set-payee', from_settlement_entry_id: 'set-payer' })

    expect(await settleIntercompanyCharge(db.admin, FUND, 'u', 'ic-1', '2026-06-30')).toEqual({ ok: true })
    expect(mocks.persist).not.toHaveBeenCalled()
    expect(db.tables.intercompany_transactions[0]).toMatchObject({ status: 'settled', settled_date: '2026-05-01' })
  })

  it('posts only the missing side when one side is linked, dated like the side already booked', async () => {
    const db = world()
    accrued(db)
    db.tables.journal_entries.push({ id: 'set-payee', fund_id: FUND, vehicle_id: MANCO, book: 'actual', status: 'posted', entry_date: '2026-05-01', source_ref: 'intercompany-settlement:ic-1' })
    db.tables.intercompany_transactions[0].to_settlement_entry_id = 'set-payee'

    expect(await settleIntercompanyCharge(db.admin, FUND, 'u', 'ic-1', '2026-06-30')).toEqual({ ok: true })
    expect(mocks.persist).toHaveBeenCalledTimes(1)
    const payer = settlements(db).find(e => e.vehicle_id === FUNDV)!
    expect(payer.entry_date).toBe('2026-05-01')
    expect(db.tables.intercompany_transactions[0]).toMatchObject({
      status: 'settled', settled_date: '2026-05-01', to_settlement_entry_id: 'set-payee', from_settlement_entry_id: payer.id,
    })
  })

  it('never undoes a payee entry another attempt has already paired', async () => {
    const db = world()
    accrued(db)
    // A: posts and links the payee side, then is held at its payer post.
    let reached!: () => void
    const atPayer = new Promise<void>(r => { reached = r })
    let go!: () => void
    const held = new Promise<void>(r => { go = r })
    const persist = mocks.persist.getMockImplementation()!
    let calls = 0
    mocks.persist.mockImplementation(async (...args: any[]) => {
      if (++calls === 2) { reached(); await held }
      return persist(...args)
    })

    const a = settleIntercompanyCharge(db.admin, FUND, 'u', 'ic-1', '2026-05-01')
    await atPayer
    // B: reads A's linked payee entry, posts and links the payer side, and settles the charge.
    expect(await settleIntercompanyCharge(db.admin, FUND, 'u', 'ic-1', '2026-05-01')).toEqual({ ok: true })
    go()

    // A loses the payer race to the index and must not delete the payee entry B settled with.
    expect(await a).toMatchObject({ error: expect.stringContaining('another request') })
    const row = db.tables.intercompany_transactions[0]
    expect(row.status).toBe('settled')
    expect(settlements(db).map(e => e.id).sort()).toEqual([row.to_settlement_entry_id, row.from_settlement_entry_id].sort())
    expect(settlements(db)).toHaveLength(2)
  })

  it('does not mark a charge settled over a side another attempt unwound meanwhile', async () => {
    const db = world()
    accrued(db)
    // A posts and links the payee side, then is held at its payer post. B reads A's payee link,
    // posts the payer side and is held before linking it. A's payer post then fails (not on the
    // index), so A unwinds its payee: B has not linked the payer yet, so that unlink matches.
    let aReached!: () => void, bReached!: () => void, releaseA!: () => void, releaseB!: () => void
    const atA = new Promise<void>(r => { aReached = r }), atB = new Promise<void>(r => { bReached = r })
    const holdA = new Promise<void>(r => { releaseA = r }), holdB = new Promise<void>(r => { releaseB = r })
    const persist = mocks.persist.getMockImplementation()!
    let calls = 0
    mocks.persist.mockImplementation(async (...args: any[]) => {
      const n = ++calls
      if (n === 2) { aReached(); await holdA; return { error: 'connection reset' } }
      const res = await persist(...args)
      if (n === 3) { bReached(); await holdB }
      return res
    })

    const a = settleIntercompanyCharge(db.admin, FUND, 'u', 'ic-1', '2026-05-01')
    await atA
    const b = settleIntercompanyCharge(db.admin, FUND, 'u', 'ic-1', '2026-05-01')
    await atB
    releaseA()
    expect(await a).toMatchObject({ error: expect.stringContaining('connection reset') })
    releaseB()

    expect(await b).toMatchObject({ error: expect.stringContaining('was not marked settled') })
    const row = db.tables.intercompany_transactions[0]
    expect(row.status).toBe('accrued')
    expect(settlements(db).map(e => e.vehicle_id)).toEqual([FUNDV])

    // Settling again posts only the missing payee side and finishes.
    mocks.persist.mockImplementation(persist)
    expect(await settleIntercompanyCharge(db.admin, FUND, 'u', 'ic-1', '2026-05-01')).toEqual({ ok: true })
    expect(settlements(db).map(e => e.vehicle_id).sort()).toEqual([FUNDV, MANCO])
    expect(db.tables.intercompany_transactions[0].status).toBe('settled')
  })

  it('accepts a settlement link that committed although its response was lost', async () => {
    const db = world()
    accrued(db)
    db.loseNextUpdateResponse('intercompany_transactions', patch => 'to_settlement_entry_id' in patch)

    expect(await settleIntercompanyCharge(db.admin, FUND, 'u', 'ic-1', '2026-05-01')).toEqual({ ok: true })
    expect(settlements(db)).toHaveLength(2)
    expect(db.tables.intercompany_transactions[0].status).toBe('settled')
  })

  it('unwinds and unlinks the payee side when the payer side fails', async () => {
    const db = world()
    accrued(db)
    const persist = mocks.persist.getMockImplementation()!
    mocks.persist.mockImplementation(async (...args: any[]) =>
      args[2] === 'Fund I' ? { error: 'The period covering 2026-05-01 is closed' } : persist(...args))

    const res = await settleIntercompanyCharge(db.admin, FUND, 'u', 'ic-1', '2026-05-01')
    expect(res).toMatchObject({ error: expect.stringContaining('closed') })
    expect(settlements(db)).toHaveLength(0)
    expect(db.tables.intercompany_transactions[0]).toMatchObject({ status: 'accrued', to_settlement_entry_id: null })
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
