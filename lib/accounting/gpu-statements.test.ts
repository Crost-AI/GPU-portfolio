import { describe, expect, it } from 'vitest'
import { DEFAULT_CHART, GPU_SPV_CHART, assetAccountCode } from './chart'
import { computePayload, type LedgerData } from './statement-package'
import type { Account } from './types'
import type { SourcedPosting } from './load'

/**
 * A GPU SPV's statements (gpu-P4 B2, pivot plan §5.4): the cash-flow statement reports its
 * equipment as investing, and every other kind's statement package is byte-identical to before
 * (the `fof` precedent: an optional block, absent unless it applies).
 */

const A1 = 'aaaaaaaa-0000-0000-0000-000000000001'
const A2 = 'bbbbbbbb-0000-0000-0000-000000000002'

function chart(seeds: { code: string; name: string; type: string; subtype?: string | null }[], extra: { code: string; name: string; type: string; subtype: string }[] = []): Account[] {
  return [...seeds, ...extra].map(a => ({ id: `acct-${a.code}`, fundId: 'f1', code: a.code, name: a.name, type: a.type as Account['type'], subtype: a.subtype ?? null, lpEntityId: null, companyId: null }))
}
const id = (code: string) => `acct-${code}`

/** Entries as [entryId, date, sourceType, [code, amount][]] → the posting arrays LedgerData holds. */
function ledger(accounts: Account[], kind: string, entries: [string, string, string, [string, number][]][]): LedgerData {
  const sourced: SourcedPosting[] = entries.flatMap(([entryId, date, sourceType, legs]) =>
    legs.map(([code, amount]) => ({ entryId, entryDate: date, sourceType, memo: entryId, accountId: id(code), amount, currency: 'USD', lpEntityId: code.startsWith('3100') ? 'lp1' : null })))
  return {
    accounts, postings: sourced, sourcedPostings: sourced,
    capitalPostings: sourced.filter(p => p.lpEntityId).map(p => ({ entryId: p.entryId, lpEntityId: p.lpEntityId!, amount: p.amount, sourceType: p.sourceType, entryDate: p.entryDate })),
    names: new Map([['lp1', 'Investor One']]), txns: [], companies: [], group: 'V', fofRaw: null, feeds: [], observations: [],
    cashAccount: accounts.find(a => a.code === '1000'), gpAccount: accounts.find(a => a.code === '3000'),
    earliest: entries[0]?.[1] ?? null, kind,
  }
}
const YEAR = { start: '2027-01-01', end: '2027-12-31', label: '2027' } as any

export const VC_ENTRIES: [string, string, string, [string, number][]][] = [
  ['call', '2027-01-15', 'capital_call', [['1000', 1_000_000], ['3100', -1_000_000]]],
  ['invest', '2027-02-01', 'manual', [['1100', 800_000], ['1000', -800_000]]],
  ['fee', '2027-03-31', 'management_fee', [['5000', 20_000], ['1000', -20_000]]],
  ['exit', '2027-11-30', 'manual', [['1000', 900_000], ['1100', -800_000], ['4000', -100_000]]],
]

describe('every kind other than a GPU SPV: the statement package is unchanged', () => {
  it('a fund: the whole payload, pinned (taken before the GPU change)', () => {
    const p = computePayload(ledger(chart(DEFAULT_CHART), 'fund', VC_ENTRIES), YEAR)
    expect('investing' in p.cashFlows!).toBe(false)
    expect(JSON.stringify(p)).toMatchSnapshot()
  })
})
