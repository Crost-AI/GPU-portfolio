import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { loadK1Year } from '@/lib/accounting/k1-load'
import { allocateK1 } from '@/lib/accounting/k1-allocation'
import { loadActualBookYear, postTaxAdjustments } from '@/lib/accounting/book-tax-run'
import { buildAllocationEntry } from '@/lib/accounting/allocation-actions'
import { emptyLines, k1CategoriesIn } from '@/lib/accounting/k1-allocation'
import { buildK1Html } from '@/lib/tax/k1-pdf'
import { buildK1Workbook } from '@/lib/tax/k1-workbook'
import * as XLSX from 'xlsx'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

// The PDF is the HTML the renderer is handed; nothing here launches a browser.
vi.mock('@/lib/tax/k1-pdf', async orig => {
  const m = await orig<typeof import('@/lib/tax/k1-pdf')>()
  return { ...m, generateK1Pdf: async (d: any) => Buffer.from(m.buildK1Html(d)) }
})

import { generateK1Package } from '@/lib/tax/k1-package'
import { buildK1WorkbookForPackage } from '@/lib/tax/k1-export'
import { k1Document } from '@/lib/reports/documents'

/**
 * ── GPU fleet (P1c) ── A VC fund's tax output is unchanged by the GPU SPV tax work. The expected
 * values are inline SNAPSHOTS captured by running this file on main @ cb0d5150, before the K-1,
 * book-to-tax and allocation loaders learned the GPU chart: the K-1 year and its allocation, the
 * book-to-tax year and its preview, and the allocation actions.
 */

const ACCOUNTS = [
  { id: 'cash', code: '1000', type: 'asset', subtype: 'cash', lp_entity_id: null },
  { id: 'due-gp', code: '2100', type: 'liability', subtype: 'due_to_gp', lp_entity_id: null },
  { id: 'gp-cap', code: '3000', type: 'equity', subtype: 'gp_capital', lp_entity_id: null },
  { id: 'bridge', code: '3200', type: 'equity', subtype: 'undistributed_earnings', lp_entity_id: null },
  { id: 'cap-a', code: '3100-a', type: 'equity', subtype: 'lp_capital', lp_entity_id: 'lp-a' },
  { id: 'cap-b', code: '3100-b', type: 'equity', subtype: 'lp_capital', lp_entity_id: 'lp-b' },
  { id: 'gain', code: '4000', type: 'income', subtype: 'realized_gain', lp_entity_id: null },
  { id: 'int', code: '4100', type: 'income', subtype: 'interest', lp_entity_id: null },
  { id: 'other', code: '4120', type: 'income', subtype: null, lp_entity_id: null },
  { id: 'unr', code: '4200', type: 'income', subtype: 'unrealized', lp_entity_id: null },
  { id: 'fee', code: '5000', type: 'expense', subtype: 'management_fee', lp_entity_id: null },
  { id: 'exp', code: '5100', type: 'expense', subtype: 'partnership_expense', lp_entity_id: null },
  { id: 'org', code: '5200', type: 'expense', subtype: 'organizational', lp_entity_id: null },
  { id: 'synd', code: '5250', type: 'expense', subtype: 'syndication', lp_entity_id: null },
]

const entry = (date: string, source_type: string) => ({ entry_date: date, status: 'posted', source_type, book: 'actual' })
const p = (account_id: string, amount: number, date: string, source_type: string, lp_entity_id: string | null = null) =>
  ({ account_id, amount, lp_entity_id, book: 'actual', journal_entries: entry(date, source_type) })

// A year of a small fund: contributions, a gain, interest and other income, fees and expenses
// (including organizational and syndication costs), each allocated to two partners 60/40.
const POSTINGS = [
  p('cash', 1_000_000, '2027-01-15', 'capital_call'), p('cap-a', -600_000, '2027-01-15', 'capital_call', 'lp-a'), p('cap-b', -400_000, '2027-01-15', 'capital_call', 'lp-b'),
  p('cash', 50_000, '2027-06-30', 'realized_gain'), p('gain', -50_000, '2027-06-30', 'realized_gain'),
  p('cap-a', -30_000, '2027-06-30', 'realized_gain', 'lp-a'), p('cap-b', -20_000, '2027-06-30', 'realized_gain', 'lp-b'), p('bridge', 50_000, '2027-06-30', 'realized_gain'),
  p('cash', 2_000, '2027-07-31', 'income'), p('int', -1_500, '2027-07-31', 'income'), p('other', -500, '2027-07-31', 'income'),
  p('cap-a', -1_200, '2027-07-31', 'income', 'lp-a'), p('cap-b', -800, '2027-07-31', 'income', 'lp-b'), p('bridge', 2_000, '2027-07-31', 'income'),
  p('fee', 20_000, '2027-03-31', 'management_fee'), p('due-gp', -20_000, '2027-03-31', 'management_fee'),
  p('cap-a', 12_000, '2027-03-31', 'management_fee', 'lp-a'), p('cap-b', 8_000, '2027-03-31', 'management_fee', 'lp-b'), p('bridge', -20_000, '2027-03-31', 'management_fee'),
  p('exp', 3_000, '2027-04-30', 'partnership_expense'), p('org', 9_000, '2027-02-28', 'partnership_expense'), p('synd', 4_000, '2027-02-28', 'partnership_expense'),
  p('cash', -16_000, '2027-04-30', 'partnership_expense'),
  p('cap-a', 9_600, '2027-04-30', 'partnership_expense', 'lp-a'), p('cap-b', 6_400, '2027-04-30', 'partnership_expense', 'lp-b'), p('bridge', -16_000, '2027-04-30', 'partnership_expense'),
]

const TABLES: Record<string, any[]> = {
  chart_of_accounts: ACCOUNTS,
  journal_postings: POSTINGS,
  journal_entries: [],
  fund_vehicles: [{ id: 'veh-1', fund_id: 'f', name: 'Fund I', kind: 'fund', aliases: [] }],
  lp_investments: [
    { id: 'i-a', fund_id: 'f', portfolio_group: 'Fund I', entity_id: 'lp-a', commitment: 600_000 },
    { id: 'i-b', fund_id: 'f', portfolio_group: 'Fund I', entity_id: 'lp-b', commitment: 400_000 },
  ],
  fund_settings: [{ fund_id: 'f', currency: 'USD', inception_date: '2027-01-15' }],
}

/** A chainable read-only fake: each table's rows, whatever the filters (the fixture is one vehicle, one year). */
function fakeAdmin() {
  const make = (rows: any[]) => {
    const q: any = {
      select: () => q, eq: () => q, neq: () => q, in: () => q, is: () => q, not: () => q, gte: () => q, lte: () => q, lt: () => q, gt: () => q,
      like: () => q, ilike: () => q, or: () => q, order: () => q, limit: () => q, contains: () => q,
      range: (from: number) => Promise.resolve({ data: from === 0 ? rows : [], error: null }),
      maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
      single: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
      then: (resolve: (v: any) => void, reject?: any) => Promise.resolve({ data: rows, error: null }).then(resolve, reject),
    }
    return q
  }
  return { from: (table: string) => make(TABLES[table] ?? []), rpc: async () => ({ data: null, error: null }) } as any
}

describe('a VC fund tax output is unchanged (snapshot from main)', () => {
  it('the K-1 year and its allocation', async () => {
    const inputs = await loadK1Year(fakeAdmin(), 'f', 'Fund I', 2027)
    expect(inputs).toMatchInlineSnapshot(`
      {
        "fund": {
          "deductions": 36000,
          "interest": 1500,
          "longTermGain": 0,
          "longTermGainWithinApiPeriod": 0,
          "ordinaryDividends": 0,
          "otherIncome": 500,
          "qualifiedDividends": 0,
          "shortTermGain": 0,
        },
        "notDerivable": [],
        "partners": [
          {
            "beginningCapital": 0,
            "carriedInterest": 0,
            "contributions": 600000,
            "distributions": 0,
            "distributionsByKind": undefined,
            "endingCapital": 609600,
            "expenses": 21600,
            "lpEntityId": "lp-a",
            "operatingIncome": 1200,
            "otherChanges": 0,
            "realizedGains": 30000,
            "unrealizedGains": 0,
          },
          {
            "beginningCapital": 0,
            "carriedInterest": 0,
            "contributions": 400000,
            "distributions": 0,
            "distributionsByKind": undefined,
            "endingCapital": 406400,
            "expenses": 14400,
            "lpEntityId": "lp-b",
            "operatingIncome": 800,
            "otherChanges": 0,
            "realizedGains": 20000,
            "unrealizedGains": 0,
          },
        ],
        "undeterminedGain": 0,
      }
    `)
    if ('error' in inputs) return
    expect(allocateK1({ fund: inputs.fund, partners: inputs.partners })).toMatchInlineSnapshot(`
      {
        "partners": [
          {
            "capitalAccount": {
              "beginning": 0,
              "contributions": 600000,
              "distributions": 0,
              "ending": 609600,
              "netIncome": 9600,
              "otherChanges": 0,
              "unrealized": 0,
            },
            "lines": {
              "deductions": 21600,
              "distributionsCash": 0,
              "distributionsOther": 0,
              "distributionsProperty": 0,
              "interest": 900,
              "longTermGain": 0,
              "ordinaryDividends": 0,
              "otherIncome": 300,
              "qualifiedDividends": 0,
              "section1061Recharacterized": 0,
              "shortTermGain": 0,
            },
            "lpEntityId": "lp-a",
            "tieOut": {
              "computed": -20400,
              "fromCapital": 9600,
              "variance": -30000,
            },
          },
          {
            "capitalAccount": {
              "beginning": 0,
              "contributions": 400000,
              "distributions": 0,
              "ending": 406400,
              "netIncome": 6400,
              "otherChanges": 0,
              "unrealized": 0,
            },
            "lines": {
              "deductions": 14400,
              "distributionsCash": 0,
              "distributionsOther": 0,
              "distributionsProperty": 0,
              "interest": 600,
              "longTermGain": 0,
              "ordinaryDividends": 0,
              "otherIncome": 200,
              "qualifiedDividends": 0,
              "section1061Recharacterized": 0,
              "shortTermGain": 0,
            },
            "lpEntityId": "lp-b",
            "tieOut": {
              "computed": -13600,
              "fromCapital": 6400,
              "variance": -20000,
            },
          },
        ],
        "unallocated": {},
      }
    `)
  })

  it('the book-to-tax year and its preview', async () => {
    const year = await loadActualBookYear(fakeAdmin(), 'f', 'Fund I', 2027, { inceptionDate: '2027-01-15' })
    expect('error' in year ? year : year.year).toMatchInlineSnapshot(`
      {
        "carryAccruedOnUnrealized": 0,
        "fxChange": 0,
        "org": {
          "isFirstYear": true,
          "monthsAlreadyAmortized": 0,
          "monthsInYear": 12,
        },
        "organizationalCostsToDate": 9000,
        "organizationalExpense": 9000,
        "syndicationExpense": 4000,
        "unrealizedChange": 0,
      }
    `)
    const preview = await postTaxAdjustments(fakeAdmin(), 'f', 'Fund I', 'u', 2027, { preview: true, inceptionDate: '2027-01-15' })
    expect(preview).toMatchInlineSnapshot(`
      {
        "entryIds": [],
        "missingAccounts": [
          "1400",
          "1450",
        ],
        "proposals": [
          {
            "amount": 3733.33,
            "kind": "organizational_709",
            "label": "Organizational costs capitalised under §709",
            "permanent": false,
            "rationale": "Book expensed 9000.00; §709 allows 5266.67 this year (5000.00 immediate + 266.67 over 12 of 180 months).",
          },
          {
            "amount": 4000,
            "kind": "syndication",
            "label": "Syndication costs — permanently non-deductible",
            "permanent": true,
            "rationale": "Costs of selling partnership interests are never deductible and never amortized (§709(a)). Book expenses them; tax capitalises them permanently. This difference does not reverse.",
          },
        ],
        "skipped": [],
        "taxYear": 2027,
        "voided": 0,
      }
    `)
  })

  it('the allocation actions', async () => {
    const out: Record<string, unknown> = {}
    for (const action of ['management_fee', 'expense', 'gain']) {
      out[action] = await buildAllocationEntry(fakeAdmin(), 'f', 'Fund I', { action, entryDate: '2027-06-30', amount: 1_000, annualRate: 0.02, periodFraction: 0.25 })
        .catch((e: Error) => ({ threw: e.message }))
    }
    expect(out).toMatchInlineSnapshot(`
      {
        "expense": {
          "entry": {
            "entryDate": "2027-06-30",
            "fundId": "f",
            "memo": undefined,
            "postings": [
              {
                "accountId": "exp",
                "amount": 1000,
                "currency": "USD",
                "lpEntityId": null,
              },
              {
                "accountId": "cash",
                "amount": -1000,
                "currency": "USD",
                "lpEntityId": null,
              },
            ],
            "sourceType": "partnership_expense",
          },
        },
        "gain": {
          "entry": {
            "entryDate": "2027-06-30",
            "fundId": "f",
            "memo": undefined,
            "postings": [
              {
                "accountId": "cash",
                "amount": 1000,
                "currency": "USD",
                "lpEntityId": null,
              },
              {
                "accountId": "gain",
                "amount": -1000,
                "currency": "USD",
                "lpEntityId": null,
              },
            ],
            "sourceType": "realized_gain",
          },
        },
        "management_fee": {
          "entry": {
            "entryDate": "2027-06-30",
            "fundId": "f",
            "memo": undefined,
            "postings": [
              {
                "accountId": "fee",
                "amount": 5000,
                "currency": "USD",
                "lpEntityId": null,
              },
              {
                "accountId": "due-gp",
                "amount": -5000,
                "currency": "USD",
                "lpEntityId": null,
              },
            ],
            "sourceType": "management_fee",
          },
        },
      }
    `)
  })
})

describe('box 1 and box 10 appear only when nonzero (P1c)', () => {
  it('a VC K-1 gets no new line: same keys, no box 1 or box 10 on the PDF or the workbook', async () => {
    const inputs = await loadK1Year(fakeAdmin(), 'f', 'Fund I', 2027)
    if ('error' in inputs) throw new Error(inputs.error)
    const { partners } = allocateK1(inputs)
    for (const p of partners) {
      expect(Object.keys(p.lines).sort()).toEqual(Object.keys(emptyLines()).sort())
      expect(k1CategoriesIn(p.lines)).not.toContain('ordinaryBusinessIncome')
      expect(k1CategoriesIn(p.lines)).not.toContain('section1231Gain')
      const html = buildK1Html({ fundName: 'F', fundLogo: null, fundAddress: null, vehicle: 'Fund I', taxYear: 2027, version: 1, status: 'draft', partnerName: p.lpEntityId, lines: p.lines, capitalAccount: { beginning: 0, contributions: 0, distributions: 0, netIncome: 0, ending: 0 } })
      expect(html).not.toMatch(/business income|section 1231/i)
    }
    const wb = buildK1Workbook({ fundName: 'F', vehicle: 'Fund I', taxYear: 2027, version: 1, status: 'draft', generatedAt: '2028-01-01T00:00:00Z', fundCharacter: null, warnings: [],
      partners: partners.map(p => ({ lpEntityId: p.lpEntityId, name: p.lpEntityId, lines: p.lines, capitalAccount: p.capitalAccount, tieOutVariance: 0, rollForwardVariance: 0 })) })
    const header = (XLSX.utils.sheet_to_json(wb.Sheets['K-1 lines'], { header: 1 }) as any[][])[0]
    expect(header.join('|')).not.toMatch(/box 1\)|box 10\)/)
  })
})

describe('the stored K-1 package, its workbook and its PDFs are unchanged (snapshot from main)', () => {
  // generateK1Package writes the package, partner and line rows; the workbook export and each
  // partner's PDF are then built from those STORED rows, as the app serves them. The rows are inline
  // snapshots; the workbook (every sheet, every cell) and the PDF HTML are SHA-256 of their content.
  // All captured by running this file on main @ 43e8101f.
  it('package rows, workbook cells and PDF content', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2028-02-01T00:00:00Z'))
    try {
      const inserted: Record<string, any[]> = {}
      const base = fakeAdmin()
      const admin = { ...base, from: (table: string) => ({
        ...base.from(table),
        insert: (payload: any) => {
          inserted[table] = [...(inserted[table] ?? []), ...(Array.isArray(payload) ? payload : [payload])]
          const done: any = {
            select: () => done,
            single: () => Promise.resolve({ data: { id: 'pkg-1' }, error: null }),
            then: (resolve: (v: any) => void, reject?: any) => Promise.resolve({ data: null, error: null }).then(resolve, reject),
          }
          return done
        },
      }) }
      const pkg = await generateK1Package(admin as any, 'f', 'Fund I', 'u', 2027)
      if ('error' in pkg) throw new Error(pkg.error)
      expect({ package: inserted.k1_packages, partners: inserted.k1_partners, lines: inserted.k1_lines }).toMatchInlineSnapshot(`
        {
          "lines": [
            {
              "amount": 900,
              "category": "interest",
              "fund_id": "f",
              "lp_entity_id": "lp-a",
              "package_id": "pkg-1",
            },
            {
              "amount": 300,
              "category": "otherIncome",
              "fund_id": "f",
              "lp_entity_id": "lp-a",
              "package_id": "pkg-1",
            },
            {
              "amount": 21600,
              "category": "deductions",
              "fund_id": "f",
              "lp_entity_id": "lp-a",
              "package_id": "pkg-1",
            },
            {
              "amount": 600,
              "category": "interest",
              "fund_id": "f",
              "lp_entity_id": "lp-b",
              "package_id": "pkg-1",
            },
            {
              "amount": 200,
              "category": "otherIncome",
              "fund_id": "f",
              "lp_entity_id": "lp-b",
              "package_id": "pkg-1",
            },
            {
              "amount": 14400,
              "category": "deductions",
              "fund_id": "f",
              "lp_entity_id": "lp-b",
              "package_id": "pkg-1",
            },
          ],
          "package": [
            {
              "created_by": "u",
              "fund_character": {
                "deductions": 36000,
                "interest": 1500,
                "longTermGain": 0,
                "longTermGainWithinApiPeriod": 0,
                "ordinaryDividends": 0,
                "otherIncome": 500,
                "qualifiedDividends": 0,
                "shortTermGain": 0,
              },
              "fund_id": "f",
              "status": "draft",
              "tax_year": 2027,
              "vehicle_id": "veh-1",
              "version": 1,
              "warnings": [
                {
                  "detail": "No tax form on file.",
                  "kind": "tax_form",
                  "lpEntityId": "lp-a",
                },
                {
                  "detail": "Lines total -20400.00 against 9600.00 of allocated activity.",
                  "kind": "tie_out",
                  "lpEntityId": "lp-a",
                },
                {
                  "detail": "No tax form on file.",
                  "kind": "tax_form",
                  "lpEntityId": "lp-b",
                },
                {
                  "detail": "Lines total -13600.00 against 6400.00 of allocated activity.",
                  "kind": "tie_out",
                  "lpEntityId": "lp-b",
                },
              ],
            },
          ],
          "partners": [
            {
              "beginning_capital": 0,
              "contributions": 600000,
              "distributions": 0,
              "ending_capital": 609600,
              "form_standing": "missing",
              "form_type": null,
              "fund_id": "f",
              "lp_entity_id": "lp-a",
              "net_income": 9600,
              "other_changes": 0,
              "package_id": "pkg-1",
              "roll_forward_variance": 0,
              "tie_out_variance": -30000,
            },
            {
              "beginning_capital": 0,
              "contributions": 400000,
              "distributions": 0,
              "ending_capital": 406400,
              "form_standing": "missing",
              "form_type": null,
              "fund_id": "f",
              "lp_entity_id": "lp-b",
              "net_income": 6400,
              "other_changes": 0,
              "package_id": "pkg-1",
              "roll_forward_variance": 0,
              "tie_out_variance": -20000,
            },
          ],
        }
      `)

      const stored = memoryAdmin({
        k1_packages: inserted.k1_packages.map(r => ({ id: 'pkg-1', ...r })),
        k1_partners: inserted.k1_partners,
        k1_lines: inserted.k1_lines,
        funds: [{ id: 'f', name: 'Fund' }],
        fund_vehicles: TABLES.fund_vehicles,
        lp_entities: [{ id: 'lp-a', fund_id: 'f', entity_name: 'Partner A' }, { id: 'lp-b', fund_id: 'f', entity_name: 'Partner B' }],
        lp_tax_forms: [],
      }).admin as any
      const { wb, filename } = await buildK1WorkbookForPackage(stored, 'f', { id: 'pkg-1', ...inserted.k1_packages[0] })
      const cells = wb.SheetNames.map(n => [n, XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true })])
      const pdfs = []
      for (const lp of ['lp-a', 'lp-b']) {
        const doc = await k1Document(stored, 'f', 'pkg-1', lp)
        if (!doc) throw new Error(`no K-1 for ${lp}`)
        pdfs.push([doc.fileName, Buffer.from(doc.body as any).toString('utf8')])
      }
      const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex')
      expect({ filename, sheets: wb.SheetNames, workbook: sha(cells), pdfs: pdfs.map(([name, html]) => [name, sha(html)]) }).toMatchInlineSnapshot(`
        {
          "filename": "k1-Fund-I-2027-v1",
          "pdfs": [
            [
              "k1-2027-v1.pdf",
              "173b704866f972fc573d56dbbb8a409e808abf58661e8fa14fabe82fb1bbcfde",
            ],
            [
              "k1-2027-v1.pdf",
              "7afcb281bf26c6e524b771a438d0f94f7a56b5fca5e8a735958f402cfcb11ff7",
            ],
          ],
          "sheets": [
            "Read first",
            "K-1 lines",
            "Capital accounts",
            "Fund character",
          ],
          "workbook": "948f92fba69265f172556e0e07a1ee9cb465b78b14bd24701f4ed0e64394513d",
        }
      `)
      // Not vacuous: the hashed content carries the figures.
      expect(JSON.stringify(cells)).toMatch(/Interest income/)
      expect(pdfs[0][1]).toMatch(/Interest income/)
    } finally {
      vi.useRealTimers()
    }
  })
})
