import { describe, it, expect } from 'vitest'
import { buildNoticeHtml } from './notice-pdf'
import { distributionTierLines, type NoticeData } from './notice-types'
import { roundCents } from './ledger'

// A fund's distribution notice renders byte-identically to main. Main built the tier rows inline in
// noticeDataFor (notice-register.ts); that code is reproduced here verbatim as the reference, and
// the rendered HTML from it and from distributionTierLines must be the same string.

function mainTierRows(tiers: { returnOfCapital: number; preferred: number; lpTotal: number }, amount: number) {
  const context: { label: string; value: number | null }[] = []
  if (tiers && tiers.lpTotal > 0) {
    const share = amount / tiers.lpTotal
    context.push({ label: 'Of which return of capital', value: roundCents(tiers.returnOfCapital * share) })
    if (tiers.preferred > 0) context.push({ label: 'Of which preferred return', value: roundCents(tiers.preferred * share) })
  }
  return context
}

const base: Omit<NoticeData, 'context' | 'amount'> = {
  kind: 'distribution', fundName: 'Fund I LP', fundLogo: null, fundAddress: '1 Main St', currency: 'USD', vehicle: 'Fund I',
  partnerName: 'Alpha LP', noticeDate: '2026-06-30', number: 4, description: 'Q2 distribution', dueDate: null,
} as any

describe('a fund distribution notice is unchanged', () => {
  const cases = [
    { tiers: { returnOfCapital: 600_000, preferred: 40_000.01, lpTotal: 1_000_000.03 }, amount: 333_333.34 },
    { tiers: { returnOfCapital: 123_456.78, preferred: 0, lpTotal: 200_000 }, amount: 0.07 },
    { tiers: { returnOfCapital: 1, preferred: 2, lpTotal: 0 }, amount: 50 },
  ]
  for (const { tiers, amount } of cases) {
    it(`renders the same HTML for ${amount} of ${tiers.lpTotal}`, () => {
      const deductions = [{ label: 'Less: withholding', value: -12.5 }]
      const before = buildNoticeHtml({ ...base, amount, context: [...deductions, ...mainTierRows(tiers, amount), { label: 'Capital account balance', value: 99 }] } as NoticeData)
      const after = buildNoticeHtml({ ...base, amount, context: [...deductions, ...distributionTierLines(tiers, amount), { label: 'Capital account balance', value: 99 }] } as NoticeData)
      expect(after).toBe(before)
    })
  }
})
