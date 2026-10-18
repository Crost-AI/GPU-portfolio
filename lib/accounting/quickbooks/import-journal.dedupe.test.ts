import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

const s = vi.hoisted(() => ({ m: null as any, n: 0 }))
vi.mock('@/lib/accounting/persist', () => ({
  accountIdByCode: async () => new Map([['1000', 'cash'], ['1100', 'inv'], ['3100', 'pooled'], ['4900', 'k1'], ['5100', 'fees']]),
  persistEntry: vi.fn(async (_a: any, fundId: string, _g: string, _u: any, entry: any, status: string, book = 'actual') => {
    const id = `new-${++s.n}`
    s.m.tables.journal_entries.push({ id, fund_id: fundId, vehicle_id: 'v', book, status, source_type: entry.sourceType, source_ref: entry.sourceRef, vendor_id: entry.vendorId ?? null, entry_date: entry.entryDate })
    for (const p of entry.postings) s.m.tables.journal_postings.push({ journal_entry_id: id, account_id: p.accountId, amount: p.amount, lp_entity_id: p.lpEntityId ?? null })
    return { entryId: id }
  }),
}))
vi.mock('@/lib/accounting/vehicle-id', () => ({ vehicleIdByName: async () => 'v' }))
vi.mock('@/lib/accounting/vehicle-domain', () => ({ vehicleKindByName: async () => 'fund' }))
vi.mock('@/lib/accounting/provision-accounts', () => ({ ensureVehicleAccounts: async () => {} }))
vi.mock('@/lib/accounting/vendors', async (orig) => ({ ...(await orig<any>()), vendorResolver: () => async () => null }))
const reviewed = vi.hoisted(() => ({ entries: [] as any[][] }))
vi.mock('@/lib/accounting/import-review', () => ({
  reviewImport: async (_a: any, _f: string, _g: string, input: any) => { reviewed.entries.push(input.entries); return { differences: [], token: 't' } },
}))

import { importQbJournal, saveQbMappings } from './import-journal'
import { qbLegacySourceRef, qbSourceRef } from './build-entries'
import type { QbTransaction } from './parse-journal'
import type { JournalSource } from './sources'

const deposit = (name: string, amount = 25_000, date = '2024-03-01', num: string | null = null): QbTransaction => ({
  date, type: 'Deposit', num, memo: null,
  lines: [
    { account: 'Bank', name, memo: null, debit: amount, credit: 0 },
    { account: 'Partner investments', name: null, memo: null, debit: 0, credit: amount },
  ],
})
const PAUL = deposit('Paul Sethi')
const ANN = deposit('Ann Lee')

/** An entry as the first-version importer wrote it. */
function legacy(t: QbTransaction, id: string, over: { lp?: string | null; vendor?: string | null; status?: string; source?: JournalSource } = {}) {
  return {
    entry: { id, fund_id: 'f', vehicle_id: 'v', book: 'actual', status: over.status ?? 'draft', source_type: over.source ?? 'quickbooks', source_ref: qbLegacySourceRef(t, over.source), vendor_id: over.vendor ?? null },
    postings: [
      { journal_entry_id: id, account_id: 'cash', amount: 25_000, lp_entity_id: null },
      { journal_entry_id: id, account_id: over.lp ? `${over.lp}-capital` : 'pooled', amount: -25_000, lp_entity_id: over.lp ?? null },
    ],
  }
}

function seed(old: ReturnType<typeof legacy>[] = [], vendors: { id: string; name: string }[] = [], extra: Record<string, any[]> = {}) {
  s.n = 0
  reviewed.entries = []
  s.m = memoryAdmin({
    qb_account_mappings: ['quickbooks', 'carta'].flatMap(source => [
      { fund_id: 'f', vehicle_id: 'v', source, qb_account: 'Bank', account_code: '1000', excluded: false },
      { fund_id: 'f', vehicle_id: 'v', source, qb_account: 'Partner investments', account_code: '3100', excluded: false },
    ]),
    chart_of_accounts: [
      { id: 'pooled', fund_id: 'f', vehicle_id: 'v', code: '3100', type: 'equity', subtype: 'lp_capital', is_active: true, lp_entity_id: null },
      { id: 'paul-capital', fund_id: 'f', vehicle_id: 'v', code: '3101', type: 'equity', subtype: 'lp_capital', is_active: true, lp_entity_id: 'paul', lp_entities: { entity_name: 'Paul Sethi' } },
      { id: 'ann-capital', fund_id: 'f', vehicle_id: 'v', code: '3102', type: 'equity', subtype: 'lp_capital', is_active: true, lp_entity_id: 'ann', lp_entities: { entity_name: 'Ann Lee' } },
    ],
    journal_entries: old.map(o => o.entry),
    journal_postings: old.flatMap(o => o.postings),
    vendors: vendors.map(v => ({ ...v, fund_id: 'f' })),
    qb_import_runs: [],
    tax_year_closes: [],
    ...extra,
  })
}

const run = (transactions: QbTransaction[], opts: { dryRun?: boolean; source?: JournalSource } = {}) => importQbJournal(s.m.admin, {
  fundId: 'f', group: 'Fund I', userId: 'u', transactions, parseErrors: [], dryRun: !!opts.dryRun, includeLp: true, source: opts.source,
}) as Promise<any>
const created = () => s.m.tables.journal_entries.filter((e: any) => e.id.startsWith('new-'))

beforeEach(() => seed())

describe('importQbJournal duplicate check', () => {
  it('imports two same-day, same-amount contributions from different payers, each to its LP', async () => {
    const result = await run([PAUL, ANN])
    expect(result).toMatchObject({ created: 2, alreadyPresent: 0, duplicates: [], recovered: [] })
    expect(created().map((e: any) => e.source_ref)).toEqual([qbSourceRef(PAUL), qbSourceRef(ANN)])
    const lps = s.m.tables.journal_postings.filter((p: any) => p.lp_entity_id).map((p: any) => p.lp_entity_id)
    expect(lps).toEqual(['paul', 'ann'])
    // And a second run adds nothing.
    expect(await run([PAUL, ANN])).toMatchObject({ created: 0, alreadyPresent: 2 })
  })

  it('imports both of two identical transactions in one batch, and neither again on re-run', async () => {
    const result = await run([PAUL, PAUL])
    expect(result).toMatchObject({ created: 2, alreadyPresent: 0 })
    expect(created().map((e: any) => e.source_ref)).toEqual([qbSourceRef(PAUL), `${qbSourceRef(PAUL)}:2`])
    expect(await run([PAUL, PAUL])).toMatchObject({ created: 0, alreadyPresent: 2 })
    // A third copy in a later file is new.
    expect(await run([PAUL, PAUL, PAUL])).toMatchObject({ created: 1, alreadyPresent: 2 })
  })

  it('re-importing a file imported under the old refs imports nothing', async () => {
    const other = deposit('Paul Sethi', 10_000, '2024-04-01', '1001')
    seed([legacy(PAUL, 'old-1', { lp: 'paul' }), legacy(other, 'old-2')])
    const result = await run([PAUL, other])
    expect(result).toMatchObject({ created: 0, alreadyPresent: 2, recovered: [] })
    expect(result.duplicates.map((d: any) => d.existingEntryId)).toEqual(['old-1', 'old-2'])
    expect(result.duplicates[0].reason).toMatch(/before payees were part of the reference; that entry has the same payee or LP/)
    expect(result.duplicates[1].reason).toMatch(/same date, accounts and amounts/)
  })

  it('imports only the contribution an old import dropped, choosing it by LP', async () => {
    // The old importer kept Ann's deposit (the first in its file) and dropped Paul's.
    seed([legacy(ANN, 'old-ann', { lp: 'ann' })])
    const result = await run([PAUL, ANN], { dryRun: true })
    expect(result).toMatchObject({ wouldCreate: 1, alreadyPresent: 1 })
    expect(result.duplicates).toEqual([expect.objectContaining({ existingEntryId: 'old-ann', sourceRef: qbSourceRef(ANN) })])
    expect(result.recovered).toEqual([expect.objectContaining({ sourceRef: qbSourceRef(PAUL), legacyRef: qbLegacySourceRef(PAUL) })])
    expect(result.recovered[0].reason).toMatch(/different payee or LP/)

    await run([PAUL, ANN])
    expect(created().map((e: any) => e.source_ref)).toEqual([qbSourceRef(PAUL)])
    expect(await run([PAUL, ANN])).toMatchObject({ created: 0, alreadyPresent: 2 })
  })

  it('matches by vendor when the old entry carries one', async () => {
    seed([legacy(ANN, 'old-ann', { vendor: 'vendor-ann' })], [{ id: 'vendor-ann', name: 'Ann  Lee' }, { id: 'vendor-paul', name: 'Paul Sethi' }])
    const result = await run([PAUL, ANN], { dryRun: true })
    expect(result.duplicates.map((d: any) => d.sourceRef)).toEqual([qbSourceRef(ANN)])
    expect(result.recovered.map((d: any) => d.sourceRef)).toEqual([qbSourceRef(PAUL)])
  })

  it('pairs by count when the old entry cannot say whose it was, and says so', async () => {
    seed([legacy(PAUL, 'old-1')])
    const result = await run([PAUL, ANN], { dryRun: true })
    expect(result).toMatchObject({ wouldCreate: 1, alreadyPresent: 1 })
    expect(result.duplicates[0].reason).toMatch(/paired by count\. Check that entry is for Paul Sethi/)
    expect(result.recovered[0].reason).toMatch(/2 transactions in this import share an older reference .* with 1 entry in the book; this is one of the 1 not there yet/)
  })

  it('a partly imported file imports only what is missing', async () => {
    const a = deposit('Paul Sethi', 1_000, '2024-05-01', '7')
    const b = deposit('Ann Lee', 2_000, '2024-05-02', '8')
    const c = deposit('Ann Lee', 3_000, '2024-05-03', '9')
    seed([legacy(a, 'old-a'), legacy(b, 'old-b')])
    const result = await run([a, b, c])
    expect(result).toMatchObject({ created: 1, alreadyPresent: 2, recovered: [] })
    expect(created().map((e: any) => e.source_ref)).toEqual([qbSourceRef(c)])
  })

  it('across batches: the other LP\'s deposit in a later batch is not hidden by the old entry', async () => {
    seed([legacy(ANN, 'old-ann', { lp: 'ann' })])
    expect(await run([ANN])).toMatchObject({ created: 0, alreadyPresent: 1 })
    expect(await run([PAUL])).toMatchObject({ created: 1, alreadyPresent: 0 })
  })

  it('a voided entry still blocks re-import, and the reason says so', async () => {
    seed([legacy(PAUL, 'old-1', { lp: 'paul', status: 'void' })])
    const result = await run([PAUL], { dryRun: true })
    expect(result).toMatchObject({ wouldCreate: 0, alreadyPresent: 1 })
    expect(result.duplicates[0]).toMatchObject({ existingStatus: 'void', reason: expect.stringMatching(/voided/) })
  })

  it('runs the same way for Carta, without matching QuickBooks entries', async () => {
    seed([legacy(ANN, 'old-ann', { lp: 'ann', source: 'carta' }), legacy(PAUL, 'qb-paul', { lp: 'paul' })])
    const result = await run([PAUL, ANN], { source: 'carta' })
    expect(result).toMatchObject({ created: 1, alreadyPresent: 1 })
    expect(created().map((e: any) => e.source_ref)).toEqual([qbSourceRef(PAUL, 'carta')])
  })
})

describe('importQbJournal tax-book routing', () => {
  // A preparer's year-end K-1 entry in a tax-basis file: a lower-tier fund's pass-through loss
  // booked against the investment account and a K-1 income account.
  const k1 = (date = '2024-12-31', amount = 5_000): QbTransaction => ({
    date, type: 'Journal Entry', num: 'K1', memo: 'Example Fund I K-1',
    lines: [
      { account: 'K-1 attributes', name: null, memo: null, debit: amount, credit: 0 },
      { account: 'Investments', name: null, memo: null, debit: 0, credit: amount },
    ],
  })
  const fee: QbTransaction = {
    date: '2024-12-31', type: 'Bill', num: '9', memo: 'Audit fee',
    lines: [
      { account: 'Professional fees', name: 'Acme Audit', memo: null, debit: 1_000, credit: 0 },
      { account: 'Bank', name: 'Acme Audit', memo: null, debit: 0, credit: 1_000 },
    ],
  }
  const mappings = (taxBook: boolean) => [
    { fund_id: 'f', vehicle_id: 'v', source: 'quickbooks', qb_account: 'Bank', account_code: '1000', excluded: false },
    { fund_id: 'f', vehicle_id: 'v', source: 'quickbooks', qb_account: 'Investments', account_code: '1100', excluded: false },
    { fund_id: 'f', vehicle_id: 'v', source: 'quickbooks', qb_account: 'Professional fees', account_code: '5100', excluded: false },
    { fund_id: 'f', vehicle_id: 'v', source: 'quickbooks', qb_account: 'K-1 attributes', account_code: '4900', excluded: false, tax_book: taxBook },
  ]
  const seedTax = (opts: { taxBook?: boolean; entries?: any[]; closed?: number[] } = {}) => {
    seed([], [], {
      qb_account_mappings: mappings(opts.taxBook ?? true),
      journal_entries: opts.entries ?? [],
      tax_year_closes: (opts.closed ?? []).map(y => ({ fund_id: 'f', vehicle_id: 'v', tax_year: y, status: 'closed' })),
    })
  }
  const existing = (t: QbTransaction, id: string, book: 'actual' | 'tax', status = 'draft') =>
    ({ id, fund_id: 'f', vehicle_id: 'v', book, status, source_type: 'quickbooks', source_ref: qbSourceRef(t), vendor_id: null })

  it('sends a transaction touching a tax-book account to the tax book, whole, and leaves the rest in the ledger', async () => {
    seedTax()
    const result = await run([k1(), fee])
    expect(result).toMatchObject({ created: 2, taxBook: { entries: 1, accounts: ['K-1 attributes'] }, bookConflicts: [] })
    expect(result.taxBook.routed).toEqual([expect.objectContaining({ account: 'K-1 attributes', entryDate: '2024-12-31' })])
    const byRef = new Map<string, any>(created().map((e: any) => [e.source_ref, e]))
    expect(byRef.get(qbSourceRef(k1()))).toMatchObject({ book: 'tax', status: 'draft' })
    expect(byRef.get(qbSourceRef(fee))).toMatchObject({ book: 'actual', status: 'draft' })
    // Both legs of the K-1 entry went with it: one book, balanced.
    const k1Id = byRef.get(qbSourceRef(k1())).id
    expect(s.m.tables.journal_postings.filter((p: any) => p.journal_entry_id === k1Id).map((p: any) => p.amount)).toEqual([5_000, -5_000])
    // The comparison with investment and LP records sees only the actual-book entry.
    expect(reviewed.entries.at(-1)!.map((e: any) => e.sourceRef)).toEqual([qbSourceRef(fee)])
  })

  it('a re-run imports nothing, whichever book the entries are in', async () => {
    seedTax()
    await run([k1(), fee])
    expect(await run([k1(), fee])).toMatchObject({ created: 0, alreadyPresent: 2, bookConflicts: [] })
  })

  it('reports, and does not move, an entry imported to the actual book before the account was marked', async () => {
    seedTax({ entries: [existing(k1(), 'old-k1', 'actual', 'posted')] })
    const result = await run([k1()], { dryRun: true })
    expect(result).toMatchObject({ wouldCreate: 0, alreadyPresent: 1, taxBook: { entries: 0 } })
    expect(result.duplicates[0]).toMatchObject({ existingEntryId: 'old-k1', existingBook: 'actual' })
    expect(result.bookConflicts).toEqual([expect.objectContaining({
      existingEntryId: 'old-k1', existingBook: 'actual', mappedBook: 'tax', existingStatus: 'posted',
      reason: expect.stringMatching(/left where it is.*void that entry/),
    })])
    await run([k1()])
    expect(created()).toEqual([])
  })

  it('also reports the reverse move: in the tax book, now mapped to the ledger', async () => {
    seedTax({ taxBook: false, entries: [existing(k1(), 'tax-k1', 'tax')] })
    const result = await run([k1()])
    expect(result).toMatchObject({ created: 0, bookConflicts: [expect.objectContaining({ existingBook: 'tax', mappedBook: 'actual', reason: expect.stringMatching(/discard that draft/) })] })
  })

  it('a voided entry in the other book is how a transaction moves: it imports into the new one', async () => {
    seedTax({ entries: [existing(k1(), 'old-k1', 'actual', 'void')] })
    const result = await run([k1()])
    expect(result).toMatchObject({ created: 1, alreadyPresent: 0, bookConflicts: [], taxBook: { entries: 1 } })
    expect(created()[0]).toMatchObject({ book: 'tax', source_ref: qbSourceRef(k1()) })
  })

  it('a voided entry in the SAME book still blocks re-import', async () => {
    seedTax({ entries: [existing(k1(), 'old-k1', 'tax', 'void')] })
    expect(await run([k1()])).toMatchObject({ created: 0, alreadyPresent: 1, bookConflicts: [] })
  })

  it('refuses and names a tax-book entry dated in a closed tax year, on a dry run too', async () => {
    seedTax({ closed: [2024] })
    const preview = await run([k1('2024-12-31'), k1('2025-12-31', 7_000), fee], { dryRun: true })
    expect(preview).toMatchObject({ wouldCreate: 2, alreadyPresent: 0, skipped: 1, taxBook: { entries: 1 } })
    expect(preview.taxBook.lockedYears).toEqual([{ entryDate: '2024-12-31', memo: expect.any(String), taxYear: 2024 }])
    expect(preview.errors.join(' ')).toMatch(/tax year 2024 is closed/)

    const result = await run([k1('2024-12-31'), k1('2025-12-31', 7_000), fee])
    expect(result).toMatchObject({ created: 2, skipped: 1 })
    // The actual-book entry dated in 2024 is not the tax lock's business.
    expect(created().map((e: any) => [e.book, e.entry_date]).sort()).toEqual([['actual', '2024-12-31'], ['tax', '2025-12-31']])
  })
})

describe('saveQbMappings tax-book flag', () => {
  beforeEach(() => seed([], [], {
    qb_account_mappings: [{ fund_id: 'f', vehicle_id: 'v', source: 'quickbooks', qb_account: 'K-1 attributes', account_code: '1000', excluded: false, tax_book: true }],
    chart_of_accounts: [{ id: 'cash', fund_id: 'f', vehicle_id: 'v', code: '1000', type: 'asset', is_active: true }],
  }))
  const saved = (account: string) => s.m.tables.qb_account_mappings.filter((r: any) => r.qb_account === account).at(-1)

  it('keeps the saved flag when a row does not mention it', async () => {
    await saveQbMappings(s.m.admin, 'f', 'Fund I', [{ qbAccount: 'K-1 attributes', accountCode: '1000' }])
    expect(saved('K-1 attributes').tax_book).toBe(true)
  })

  it('sets and clears it when a row says so, and never on an excluded account', async () => {
    await saveQbMappings(s.m.admin, 'f', 'Fund I', [{ qbAccount: 'K-1 attributes', accountCode: '1000', taxBook: false }])
    expect(saved('K-1 attributes').tax_book).toBe(false)
    await saveQbMappings(s.m.admin, 'f', 'Fund I', [{ qbAccount: 'Bank', accountCode: '1000', taxBook: true }, { qbAccount: 'Old', excluded: true, taxBook: true }])
    expect(saved('Bank').tax_book).toBe(true)
    expect(saved('Old').tax_book).toBe(false)
  })
})

