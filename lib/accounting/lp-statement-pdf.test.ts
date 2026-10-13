import { describe, it, expect } from 'vitest'
import { buildStatementHtml, NET_PNL_LABEL, type StatementPdfData } from './lp-statement-pdf'
import { ytdWindow } from './statement-period'
import { emptyAccount, type CapitalAccount } from './capital-account'

// One 3SE Holdings LP partner's books, inception to date (capital_accounts, Oct 2026).
const itd: CapitalAccount = {
  ...emptyAccount(),
  contributions: 90000, managementFees: -10000, expenses: -5157.35,
  operatingIncome: 1821.5, realizedGains: 134.3, ending: 76798.45,
}

function data(over: Partial<StatementPdfData> = {}): StatementPdfData {
  return {
    fundName: 'Laconia', fundLogo: null, fundAddress: null, currency: 'USD',
    vehicle: '3SE Holdings LP', partnerName: 'Jon May',
    period: { label: 'Inception to date', start: null, end: null } as any,
    row: { commitment: 100000, called: 90000, funded: 90000, outstanding: 10000, receivable: 0, ending: 76798.45 },
    periodRollForward: itd, ytdRollForward: itd, rollForward: itd, ownership: 0.02,
    ...over,
  }
}

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

describe('buildStatementHtml', () => {
  it('shows beginning, management fees, net profit or loss, ending capital and the commitment', () => {
    const t = text(buildStatementHtml(data()))
    expect(t).toContain('Beginning capital')
    expect(t).toContain('Management fees ($10,000.00)')
    // -10000 - 5157.35 + 1821.50 + 134.30
    expect(t).toContain(`${NET_PNL_LABEL} ($13,201.55)`)
    expect(t).toContain('Ending capital $76,798.45')
    expect(t).toContain('Commitment $100,000.00')
  })

  it('keeps the rows outside the profit and loss block summing to ending capital', () => {
    // beginning + contributions + net P&L = ending; the components are indented under the subtotal.
    expect(0 + 90000 - 13201.55).toBeCloseTo(itd.ending, 2)
    const html = buildStatementHtml(data())
    expect(html.indexOf('Contributions')).toBeLessThan(html.indexOf('Management fees'))
    expect(html.indexOf('Net realized gain')).toBeLessThan(html.indexOf(NET_PNL_LABEL))
    expect(html.indexOf(NET_PNL_LABEL)).toBeLessThan(html.indexOf('Ending capital'))
  })

  it('leaves the subtotal out when nothing in the period is profit or loss', () => {
    const flat = { ...emptyAccount(), contributions: 5000, ending: 5000 }
    expect(buildStatementHtml(data({ periodRollForward: flat, ytdRollForward: flat, rollForward: flat }))).not.toContain(NET_PNL_LABEL)
  })

  it("puts the vehicle's logo in the header when one is passed", () => {
    expect(buildStatementHtml(data({ fundLogo: 'data:image/png;base64,3SE' }))).toContain('src="data:image/png;base64,3SE"')
  })

  it('adds a year-to-date column, and lays the commitment summary out in the same columns', () => {
    const quarter = { ...emptyAccount(), beginning: 75940, operatingIncome: 170, ending: 76110 }
    const html = buildStatementHtml(data({
      period: { label: 'Q1 2026', start: '2026-01-01', end: '2026-03-31' } as any,
      periodRollForward: quarter, ytdRollForward: quarter,
    }))
    const t = text(html)
    expect(t).toContain('Statement period Year to date Inception to date')
    expect(t).toContain('Ending capital $76,110.00 $76,110.00 $76,798.45')
    // Called capital is a flow (nothing called this quarter); the balances sit under inception to date.
    expect(t).toContain('Called capital — — $90,000.00')
    expect(t).toContain('Remaining to be called $10,000.00')
    expect(t).toContain('unaudited')
  })

  it('always prints three columns, even when the period is itself year to date', () => {
    const ytd = { ...emptyAccount(), beginning: 82792.03, operatingIncome: 373.25, ending: 83165.28 }
    const t = text(buildStatementHtml(data({
      period: { preset: 'ytd', label: 'YTD 2026', start: '2026-01-01', end: '2026-10-13' } as any,
      periodRollForward: ytd, ytdRollForward: ytd,
    })))
    expect(t).toContain('Statement period Year to date Inception to date')
    expect(t).toContain('Ending capital $83,165.28 $83,165.28 $76,798.45')
  })

  it('ends at the commitment summary', () => {
    const t = text(buildStatementHtml(data()))
    expect(t).toContain('Commitment summary')
    for (const gone of ['Contributions and distributions in the period', 'Commitments to underlying funds', 'Underlying fund performance', 'Basis of valuation']) {
      expect(t).not.toContain(gone)
    }
  })
})

describe('ytdWindow', () => {
  const today = new Date('2026-10-13T00:00:00Z')
  it('runs from January 1 of the period end year to the period end', () => {
    expect(ytdWindow({ start: '2026-04-01', end: '2026-06-30' }, today))
      .toEqual({ start: '2026-01-01', end: '2026-06-30' })
  })
  it('repeats the period for a Q1 or year-to-date statement', () => {
    expect(ytdWindow({ start: '2026-01-01', end: '2026-03-31' }, today))
      .toEqual({ start: '2026-01-01', end: '2026-03-31' })
    expect(ytdWindow({ start: '2026-01-01', end: '2026-10-13' }, today))
      .toEqual({ start: '2026-01-01', end: '2026-10-13' })
  })
  it('ends today for an inception-to-date statement', () => {
    expect(ytdWindow({ start: null, end: null }, today))
      .toEqual({ start: '2026-01-01', end: '2026-10-13' })
    expect(ytdWindow(undefined, today))
      .toEqual({ start: '2026-01-01', end: '2026-10-13' })
  })
})
