import { describe, it, expect } from 'vitest'
import { CCD_TRANSACTION_TYPES, ccdColumn, ccdNetSign } from './ccd-types'
import { buildCcdNotice, callTransactions, ccdSheetRows, distributionTransactions, splitToCents } from './ccd'
import { UNCHARACTERISED } from '@/lib/accounting/distribution-character'

describe('ILPA CCD transaction types', () => {
  it('has the 27 types of the v. 2.0 template, each once', () => {
    expect(CCD_TRANSACTION_TYPES).toHaveLength(27)
    expect(new Set(CCD_TRANSACTION_TYPES).size).toBe(27)
  })

  it('signs a line the way the template formula does', () => {
    for (const t of CCD_TRANSACTION_TYPES) {
      const called = t.startsWith('Capital Call:') || t === 'Distribution: Carry' || t === 'Distribution: Tax Withheld'
      expect(ccdNetSign(t)).toBe(called ? 1 : -1)
    }
  })

  it('totals a return of excess capital called as a (negative) contribution, not a distribution', () => {
    expect(ccdColumn('Negative Contribution: Return of Excess Capital Called')).toBe('contribution')
    expect(ccdNetSign('Negative Contribution: Return of Excess Capital Called')).toBe(-1)
    expect(ccdColumn('Distribution: Carry')).toBe('distribution')
  })
})

describe('splitToCents', () => {
  it('adds back to the total, the remainder on the largest part', () => {
    const parts = splitToCents(100, [1, 1, 1])
    expect(parts.reduce((s, p) => s + p, 0)).toBeCloseTo(100, 10)
    expect(parts).toEqual([33.34, 33.33, 33.33])
  })
})

describe('callTransactions', () => {
  it('splits the partner amount over the frozen purposes, each reducing unfunded', () => {
    const ts = callTransactions({
      amount: 10_000,
      description: 'Call 3',
      purposes: [
        { category: 'investment', amount: 800_000, description: 'Series A in Acme' },
        { category: 'management_fee', amount: 200_000 },
      ],
      charges: [],
    })
    expect(ts.map(t => [t.type, t.lpAmount, t.impactValue, t.netAmount])).toEqual([
      ['Capital Call: Investments', 8_000, -8_000, 8_000],
      ['Capital Call: Management Fees', 2_000, -2_000, 2_000],
    ])
    expect(ts[0].description).toBe('Series A in Acme')
  })

  it('uses Total Amount when the call was issued without purposes', () => {
    const [t] = callTransactions({ amount: 5_000, description: null, purposes: null, charges: [] })
    expect(t.type).toBe('Capital Call: Total Amount - Inside Fund')
    expect(t.impact).toBe('Decrease')
  })

  it('puts a charge outside the fund with no impact on unfunded', () => {
    const ts = callTransactions({ amount: 5_000, description: null, purposes: null, charges: [{ amount: 150, description: 'Equalization interest' }] })
    expect(ts[1]).toMatchObject({ type: 'Capital Call: Other (Provide explanation in far-left column)', insideOutside: 'Outside', impactValue: 0, netAmount: 150 })
  })
})

describe('distributionTransactions', () => {
  const base = { amount: 1_000, role: 'lp' as const, description: 'Exit of Northwind', kind: 'cash', waterfallReturnOfCapital: null, deductions: [] }

  it('uses the declared character', () => {
    const ts = distributionTransactions({ ...base, character: { returnOfCapital: 400, realizedGain: 500, income: 100 } })
    expect(ts.map(t => [t.type, t.lpAmount, t.netAmount])).toEqual([
      ['Distribution: Return of Capital - Cash', 400, -400],
      ['Distribution: Realized Gain / (Loss) - Cash (input negative value for loss)', 500, -500],
      ['Distribution: Income', 100, -100],
    ])
  })

  it('falls back to the waterfall return-of-capital tier, then to Other', () => {
    const tiered = distributionTransactions({ ...base, character: UNCHARACTERISED, waterfallReturnOfCapital: 700 })
    expect(tiered.map(t => [t.type, t.lpAmount])).toEqual([
      ['Distribution: Return of Capital - Cash', 700],
      ['Distribution: Realized Gain / (Loss) - Cash (input negative value for loss)', 300],
    ])
    const bare = distributionTransactions({ ...base, character: UNCHARACTERISED })
    expect(bare.map(t => t.type)).toEqual(['Distribution: Other (Provide explanation in far-left column)'])
  })

  it('uses the Stock types for an in-kind distribution', () => {
    const ts = distributionTransactions({ ...base, kind: 'in_kind', character: { returnOfCapital: 1_000, realizedGain: 0, income: 0 } })
    expect(ts.map(t => t.type)).toEqual(['Distribution: Return of Capital - Stock'])
  })

  it('books tax withheld as Tax Withheld and any other deduction as money paid to the fund', () => {
    const ts = distributionTransactions({ ...base, character: UNCHARACTERISED, deductions: [{ amount: 50, description: 'Tax withheld' }, { amount: 20, description: 'Unpaid call netted' }] })
    expect(ts.slice(1).map(t => [t.type, t.netAmount])).toEqual([
      ['Distribution: Tax Withheld', 50],
      ['Capital Call: Other (Provide explanation in far-left column)', 20],
    ])
  })
})

describe('buildCcdNotice', () => {
  it('rolls the unfunded commitment and cumulative amounts forward for a call', () => {
    const n = buildCcdNotice({
      kind: 'capital_call',
      noticeDate: '2027-01-15',
      dueDate: '2027-01-29',
      fundName: 'Example Fund I',
      currency: 'USD',
      fundSize: 10_000_000,
      gpCommitment: 100_000,
      noticeTotal: 1_000_000,
      lp: { id: 'lp-1', name: 'Jane Doe', commitment: 1_000_000, contributionsPrior: 300_000, distributionsPrior: 50_000 },
      transactions: callTransactions({ amount: 100_000, description: null, purposes: null, charges: [{ amount: 500, description: 'Late interest' }] }),
    })
    expect(n.fund.currentNotice).toEqual({ contributions: 1_000_000, distributions: 0, net: 1_000_000 })
    expect(n.lp.percentOfFund).toBeCloseTo(0.1)
    expect(n.lp.insideFund.current).toEqual({ contributions: 100_000, distributions: 0, net: 100_000 })
    expect(n.lp.insideFund.percentOfFundAmount.contributions).toBeCloseTo(0.1)
    expect(n.lp.insideFund.cumulativePrior).toEqual({ contributions: 300_000, distributions: -50_000 })
    expect(n.lp.insideFund.cumulativeIncluding).toEqual({ contributions: 400_000, distributions: -50_000 })
    expect(n.lp.outsideFund).toEqual({ outflowFromLp: 500, inflowToLp: 0, net: 500 })
    expect(n.lp.unfunded).toEqual({ prior: 700_000, impact: -100_000, expiredReleased: 0, otherAdjustment: 0, after: 600_000 })
    expect(n.lp.totalNet).toBe(100_500)
  })

  it('shows a distribution as negative and leaves unfunded alone', () => {
    const n = buildCcdNotice({
      kind: 'distribution',
      noticeDate: '2027-06-30',
      dueDate: null,
      fundName: 'Example Fund I',
      currency: 'USD',
      fundSize: 10_000_000,
      gpCommitment: 0,
      noticeTotal: 500_000,
      lp: { id: 'lp-1', name: 'Jane Doe', commitment: 1_000_000, contributionsPrior: 400_000, distributionsPrior: 0 },
      transactions: distributionTransactions({ amount: 50_000, role: 'lp', description: null, kind: 'cash', character: UNCHARACTERISED, waterfallReturnOfCapital: 50_000, deductions: [] }),
    })
    expect(n.fund.currentNotice.distributions).toBe(-500_000)
    expect(n.lp.insideFund.current.distributions).toBe(-50_000)
    expect(n.lp.unfunded.after).toBe(600_000)
    expect(n.lp.totalNet).toBe(-50_000)
  })

  it('lists the transactions under the ILPA column names', () => {
    const n = buildCcdNotice({
      kind: 'capital_call', noticeDate: '2027-01-15', dueDate: null, fundName: 'Example Fund I', currency: 'USD',
      fundSize: 1_000, gpCommitment: 0, noticeTotal: 100,
      lp: { id: 'lp-1', name: 'Jane Doe', commitment: 1_000, contributionsPrior: 0, distributionsPrior: 0 },
      transactions: callTransactions({ amount: 100, description: null, purposes: null, charges: [] }),
    })
    const rows = ccdSheetRows(n)
    const header = rows.findIndex(r => r[0] === 'Transaction Description')
    expect(rows[header][1]).toBe('Transaction Type')
    expect(rows[header + 1]).toEqual(['Capital call', 'Capital Call: Total Amount - Inside Fund', 100, 'Decrease', -100, 100, 'Inside'])
  })
})
