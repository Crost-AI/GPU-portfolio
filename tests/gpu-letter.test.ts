import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NO_CARRY } from '@/lib/accounting/carry'
import { GPU_SPV_CHART } from '@/lib/accounting/chart'
import { memoryAdmin } from './helpers/memory-admin'

/**
 * A GPU SPV's quarterly investor letter (gpu-P4 B2): the "GPU quarterly" template, seeded only for a
 * fund with a GPU SPV and taken only by a GPU SPV's letter; the brief's fleet block, with the profit
 * share as PAID and ACCRUED (memo, not booked) only for a writer with gp_economics.
 */

const mocks = vi.hoisted(() => ({ terms: null as any, capital: [] as any[], ledger: [] as any[] }))
vi.mock('@/lib/accounting/carry', async orig => ({ ...(await orig<typeof import('@/lib/accounting/carry')>()), loadCarryTerms: async () => mocks.terms }))
vi.mock('@/lib/accounting/capital-source', () => ({ loadCapitalPostings: async () => ({ postings: mocks.capital }) }))
vi.mock('@/lib/accounting/distributions', async orig => ({
  ...(await orig<typeof import('@/lib/accounting/distributions')>()), loadContingencyByDate: async () => new Map(), lastReserve: async () => null,
}))
vi.mock('@/lib/accounting/load', async orig => ({
  ...(await orig<typeof import('@/lib/accounting/load')>()),
  loadPostedLedger: async () => ({
    accounts: GPU_SPV_CHART.map(a => ({ id: a.code, fundId: 'f1', code: a.code, name: a.name, type: a.type, subtype: a.subtype ?? null, lpEntityId: null, companyId: null })),
    postings: mocks.ledger,
  }),
}))

import { fleetBrief, buildLetterBrief } from '@/lib/lp-letters/brief'
import { resolveTemplate } from '@/lib/lp-letters/draft-from-brief'
import { GPU_QUARTERLY_STYLE_GUIDE, GPU_QUARTERLY_TEMPLATE_NAME } from '@/lib/lp-letters/gpu-template'
import { DEFAULT_STYLE_GUIDE } from '@/lib/lp-letters/default-template'
import { loadFleetLetterData } from '@/lib/gpu/letter'
import { PACK_INPUTS } from '@/lib/gpu/fixtures/pack-v3'
import { xirr } from '@/lib/xirr'

const CASH_TERMS = { ...NO_CARRY, kind: 'distributable_cash', prefRate: 0.08, carryRate: 0.3, prefDayCount: '30_360', rocLpShare: 1, recipients: [{ lpEntityId: 'mgr', pct: 100 }] }
// The pack's Base case through Y3, dated so 30E/360 years are whole; Y3 paid 156,052.87 of profit share.
const BASE_Y3 = [
  { lpEntityId: 'lp1', amount: -PACK_INPUTS.capital, sourceType: 'capital_call', entryDate: '2026-12-31' },
  { lpEntityId: 'lp1', amount: 766_507.56, sourceType: 'distribution', entryDate: '2027-12-31' },
  { lpEntityId: 'lp1', amount: 713_960.08, sourceType: 'distribution', entryDate: '2028-12-31' },
  { lpEntityId: 'lp1', amount: 507_308.63, sourceType: 'distribution', entryDate: '2029-12-31' },
  { lpEntityId: 'mgr', amount: 156_052.87, sourceType: 'distribution', entryDate: '2029-12-31' },
]

beforeEach(() => { mocks.terms = CASH_TERMS; mocks.capital = BASE_Y3; mocks.ledger = [{ accountId: '1600', amount: 1_305_000, currency: 'USD' }, { accountId: '1650', amount: -704_700, currency: 'USD' }] })

describe('loadFleetLetterData', () => {
  it("the investors' position, paid profit share and the accrued memo at book NAV (equipment 600,300)", async () => {
    const f = (await loadFleetLetterData({} as any, 'f1', 'GPU SPV I', '2029-12-31', { showCarry: true }))!
    const p = f.report.position
    expect(p.contributed).toBe(PACK_INPUTS.capital)
    expect(p.capitalReturned).toBe(PACK_INPUTS.capital)
    expect(p.unreturned).toBe(0)
    expect(p.managerProfitSharePaid).toBe(156_052.87)
    expect(f.profitShare!.paid).toBe(156_052.87)
    expect(f.profitShare!.accrued.carryMemo).toBe(180_090)
    // The investors' own cash flows only (the manager's 156,052.87 is not theirs), no residual value.
    const own = BASE_Y3.filter(x => x.lpEntityId === 'lp1').map(x => ({ date: new Date(`${x.entryDate}T00:00:00Z`), amount: x.amount }))
    expect(f.irrToDate).toBe(xirr(own))
    expect(f.irrToDate!).toBeCloseTo(0.1963, 3)
    expect(f.projected).toBeNull()
  })

  it('without gp_economics there is no profit share, paid or accrued', async () => {
    const f = (await loadFleetLetterData({} as any, 'f1', 'GPU SPV I', '2029-12-31', { showCarry: false }))!
    expect(f.profitShare).toBeNull()
  })

  it('is null for a vehicle whose terms are not distributable_cash', async () => {
    mocks.terms = NO_CARRY
    expect(await loadFleetLetterData({} as any, 'f1', 'Fund I', '2029-12-31', { showCarry: true })).toBeNull()
  })
})

describe("the brief's fleet block", () => {
  const preview = { asOf: '2029-12-31', fundName: 'Hemrock', fundCurrency: 'USD', periodLabel: 'Q4 2029', portfolioGroup: 'GPU SPV I', companies: [], fundMetrics: null,
    totals: { totalInvested: 0, totalFmv: 0, totalRealized: 0, portfolioMoic: null, activeCount: 0, exitedCount: 0, writtenOffCount: 0 } } as any

  it('labels the accrued profit share a memo, beside the paid one, and says so in the basis notes', async () => {
    const f = (await loadFleetLetterData({} as any, 'f1', 'GPU SPV I', '2029-12-31', { showCarry: true }))!
    const brief = buildLetterBrief({ preview, year: 2029, quarter: 4, updates: new Map(), styleGuide: GPU_QUARTERLY_STYLE_GUIDE, fleet: f })
    expect(brief.fleet!.profit_share!.map(x => x.label)).toEqual([
      'Manager profit share PAID to date (booked)',
      'Manager profit share ACCRUED at book NAV, 2029-12-31 (memo, not booked)',
    ])
    expect(brief.fleet!.profit_share!.map(x => x.value)).toEqual(['$156K', '$180K'])
    expect(brief.basis_notes.some(n => /ACCRUED figure is a memo/.test(n))).toBe(true)
    expect(brief.missing_information).toContain('Fleet KPIs for Q4 2029 (revenue, utilisation, uptime): not entered for the quarter.')
    expect(brief.missing_information).toContain('A projected outcome from the forecast: not available for this letter yet.')
  })

  it('carries no profit share at all for a writer without gp_economics', async () => {
    const f = (await loadFleetLetterData({} as any, 'f1', 'GPU SPV I', '2029-12-31', { showCarry: false }))!
    const brief = buildLetterBrief({ preview, year: 2029, quarter: 4, updates: new Map(), styleGuide: GPU_QUARTERLY_STYLE_GUIDE, fleet: f })
    expect('profit_share' in brief.fleet!).toBe(false)
    expect(JSON.stringify(brief.fleet)).not.toMatch(/profit share|\$180K|\$156K/i)
    expect(brief.basis_notes.some(n => /ACCRUED/.test(n))).toBe(false)
  })

  it('is absent from every other letter', () => {
    const brief = buildLetterBrief({ preview, year: 2029, quarter: 4, updates: new Map(), styleGuide: DEFAULT_STYLE_GUIDE })
    expect('fleet' in brief).toBe(false)
    expect(fleetBrief).toBeTypeOf('function')
  })
})

describe('the GPU quarterly template', () => {
  it("a GPU SPV's letter takes the fund's GPU quarterly template, else the built-in one; any other letter never does", async () => {
    const { admin } = memoryAdmin({ lp_letter_templates: [
      { id: 'd', fund_id: 'f1', name: 'Default', style_guide: 'house style', is_default: true },
      { id: 'g', fund_id: 'f1', name: GPU_QUARTERLY_TEMPLATE_NAME, style_guide: 'gpu house style', is_default: false },
    ] })
    expect((await resolveTemplate(admin as any, 'f1', null, { gpu: true })).id).toBe('g')
    expect((await resolveTemplate(admin as any, 'f1', null, { gpu: false })).id).toBe('d')
    expect((await resolveTemplate(admin as any, 'f1', null)).id).toBe('d')
    const bare = memoryAdmin({ lp_letter_templates: [] }).admin
    expect(await resolveTemplate(bare as any, 'f1', null, { gpu: true })).toEqual({ id: null, name: GPU_QUARTERLY_TEMPLATE_NAME, styleGuide: GPU_QUARTERLY_STYLE_GUIDE })
    expect((await resolveTemplate(bare as any, 'f1', null)).styleGuide).toBe(DEFAULT_STYLE_GUIDE)
  })
})
