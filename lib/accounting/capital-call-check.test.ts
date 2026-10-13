import { describe, it, expect } from 'vitest'
import { checkCapitalCall, earliestDue, type CallFacts, type ProposedCallRequest } from './capital-call-check'
import { approvable, needsAcknowledgement } from '@/lib/drafting/checks'

const facts = (over: Partial<CallFacts> = {}): CallFacts => ({
  vehicle: 'Fund II',
  currency: 'USD',
  fundAddress: '1 Main St',
  wireInstructions: 'Bank: First Bank\nAcct: 123',
  storedNoticeDays: 10,
  storedNoticeBasis: 'calendar',
  partners: [
    { lpEntityId: 'a', name: 'Alpha LP', commitment: 6_000_000, calledToDate: 1_000_000 },
    { lpEntityId: 'b', name: 'Beta LP', commitment: 3_000_000, calledToDate: 500_000 },
    { lpEntityId: 'c', name: 'Gamma LP', commitment: 1_000_000, calledToDate: 0 },
  ],
  today: '2026-10-13',
  ...over,
})

const request = (over: Partial<ProposedCallRequest> = {}): ProposedCallRequest => ({
  total: 1_000_000,
  purposes: [
    { category: 'investment', amount: 800_000, description: 'Series A in Acme' },
    { category: 'management_fee', amount: 150_000, basis: '2% of commitments, Q1 2027' },
    { category: 'fund_expense', amount: 50_000, description: 'Audit and tax' },
  ],
  noticeDate: '2026-10-15',
  dueDate: '2026-10-30',
  ...over,
})

const codes = (r: ReturnType<typeof checkCapitalCall>) => r.flags.map(f => f.code)
const fields = (r: ReturnType<typeof checkCapitalCall>) => r.missing.map(m => m.field)

describe('checkCapitalCall: each LP share', () => {
  it('splits the call by STORED commitment, to the cent, summing to the total', () => {
    const r = checkCapitalCall(request(), facts())
    expect(r.lines.map(l => [l.name, l.amount])).toEqual([['Alpha LP', 600_000], ['Beta LP', 300_000], ['Gamma LP', 100_000]])
    expect(r.lines.reduce((s, l) => s + l.amount, 0)).toBe(1_000_000)
    expect(r.lines[0].share).toBeCloseTo(0.6)
    expect(r.totalCommitments).toBe(10_000_000)
  })

  it('rounds an uneven split to the cent without losing a cent', () => {
    const r = checkCapitalCall(request({ total: 100, purposes: [{ category: 'other', amount: 100 }] }), facts({
      partners: [1, 2, 3].map(i => ({ lpEntityId: `p${i}`, name: `P${i}`, commitment: 1, calledToDate: 0 })),
    }))
    expect(r.lines.map(l => l.amount).sort()).toEqual([33.33, 33.33, 33.34])
  })

  it('shows what each LP has left to call after this one', () => {
    const r = checkCapitalCall(request(), facts())
    expect(r.lines[0].remainingAfter).toBe(4_400_000)
  })

  it('blocks a call that takes an LP past their commitment', () => {
    const r = checkCapitalCall(request(), facts({
      partners: [{ lpEntityId: 'a', name: 'Alpha LP', commitment: 1_000_000, calledToDate: 900_000 }],
    }))
    expect(r.flags).toContainEqual(expect.objectContaining({ code: 'exceeds_uncalled_commitment', severity: 'blocker', subject: 'a' }))
    expect(approvable(r)).toBe(false)
  })

  it('lists commitments as missing when none are recorded, and computes no shares', () => {
    const r = checkCapitalCall(request(), facts({ partners: [] }))
    expect(fields(r)).toContain('commitments')
    expect(r.lines).toEqual([])
    expect(approvable(r)).toBe(false)
  })
})

describe('checkCapitalCall: never invents', () => {
  it('lists a missing notice date and due date rather than assuming today', () => {
    const r = checkCapitalCall(request({ noticeDate: null, dueDate: null }), facts())
    expect(r.noticeDate).toBeNull()
    expect(r.dueDate).toBeNull()
    expect(r.earliestDueDate).toBeNull()
    expect(fields(r)).toEqual(expect.arrayContaining(['notice_date', 'due_date']))
    expect(r.missing.find(m => m.field === 'notice_date')?.required).toBe(true)
  })

  it('lists wire instructions as missing when the vehicle has none, and does not block on it', () => {
    const r = checkCapitalCall(request(), facts({ wireInstructions: null }))
    const m = r.missing.find(x => x.field === 'wire_instructions')
    expect(m?.required).toBe(false)
    expect(approvable(r)).toBe(true)
    expect(needsAcknowledgement(r)).toBe(true)
  })

  it('lists a management fee basis as missing when the user gave only an amount', () => {
    const r = checkCapitalCall(request({
      purposes: [{ category: 'investment', amount: 900_000 }, { category: 'management_fee', amount: 100_000 }],
    }), facts())
    expect(fields(r)).toContain('purposes[1].basis')
  })

  it('lists the purpose as missing when none was given, for the approver to accept', () => {
    const r = checkCapitalCall(request({ purposes: [] }), facts())
    expect(fields(r)).toContain('purposes')
    expect(approvable(r)).toBe(true)
    expect(needsAcknowledgement(r)).toBe(true)
  })

  it('blocks purposes that do not add up to the total', () => {
    const r = checkCapitalCall(request({ total: 1_200_000 }), facts())
    expect(codes(r)).toContain('purposes_do_not_sum')
    expect(approvable(r)).toBe(false)
  })
})

describe('checkCapitalCall: the LPA notice period', () => {
  it('passes a due date on or after the end of the period', () => {
    const r = checkCapitalCall(request({ dueDate: '2026-10-25' }), facts())
    expect(r.earliestDueDate).toBe('2026-10-25')
    expect(codes(r)).not.toContain('due_inside_notice_period')
    expect(approvable(r)).toBe(true)
    expect(needsAcknowledgement(r)).toBe(false)
  })

  it('flags a due date inside the period and names the earliest allowed', () => {
    const r = checkCapitalCall(request({ dueDate: '2026-10-20' }), facts())
    const f = r.flags.find(x => x.code === 'due_inside_notice_period')
    expect(f).toMatchObject({ severity: 'warning', date: '2026-10-20' })
    expect(f?.message).toContain('2026-10-25')
    expect(needsAcknowledgement(r)).toBe(true)
  })

  it('flags any purpose date inside the period', () => {
    const r = checkCapitalCall(request({
      purposes: [{ category: 'investment', amount: 1_000_000, description: 'Acme closing', date: '2026-10-18' }],
    }), facts())
    expect(r.flags).toContainEqual(expect.objectContaining({ code: 'purpose_date_inside_notice_period', date: '2026-10-18' }))
  })

  it('blocks a due date before the notice date', () => {
    const r = checkCapitalCall(request({ dueDate: '2026-10-01' }), facts())
    expect(codes(r)).toContain('due_before_notice')
  })

  it('warns about a backdated notice', () => {
    const r = checkCapitalCall(request({ noticeDate: '2026-10-01', dueDate: '2026-10-20' }), facts())
    expect(codes(r)).toContain('notice_date_past')
  })

  it('uses the period the user gave when the vehicle has none recorded', () => {
    const r = checkCapitalCall(request({ noticePeriodDays: 20 }), facts({ storedNoticeDays: null }))
    expect(r.noticePeriod).toEqual({ days: 20, basis: 'calendar', source: 'request' })
    expect(codes(r)).toContain('due_inside_notice_period')
  })

  it('takes the longer period and flags the disagreement when the user and the LPA record differ', () => {
    const r = checkCapitalCall(request({ noticePeriodDays: 5 }), facts({ storedNoticeDays: 10 }))
    expect(r.noticePeriod).toMatchObject({ days: 10, source: 'vehicle' })
    expect(codes(r)).toContain('notice_period_disagrees')
  })

  it('lists the notice period as missing, and checks no date, when nobody knows it', () => {
    const r = checkCapitalCall(request({ dueDate: '2026-10-16' }), facts({ storedNoticeDays: null }))
    expect(fields(r)).toContain('notice_period_days')
    expect(codes(r)).not.toContain('due_inside_notice_period')
    expect(approvable(r)).toBe(true)
    expect(needsAcknowledgement(r)).toBe(true)
  })

  it('counts business days, skipping weekends, and says holidays are not known', () => {
    // 2026-10-16 is a Friday; ten business days later is Friday 2026-10-30.
    expect(earliestDue('2026-10-16', 10, 'business')).toBe('2026-10-30')
    const r = checkCapitalCall(request({ noticeDate: '2026-10-16', dueDate: '2026-10-29' }), facts({ storedNoticeBasis: 'business' }))
    expect(r.earliestDueDate).toBe('2026-10-30')
    expect(codes(r)).toEqual(expect.arrayContaining(['due_inside_notice_period', 'business_days_without_holidays']))
  })
})

describe('checkCapitalCall: description', () => {
  it('builds the notice line from the purposes when none is given', () => {
    const r = checkCapitalCall(request(), facts())
    expect(r.description).toContain('Series A in Acme ($800,000.00)')
    expect(r.description).toContain('management fees ($150,000.00)')
  })
})

describe('LP figures the request stated', () => {
  it('flags a stated commitment or share that differs from the register, and uses the register', () => {
    const r = checkCapitalCall(request({
      statedPartners: [{ lp: 'alpha lp', commitment: 5_000_000, sharePct: 10 }, { lp: 'Nobody LP', commitment: 1 }],
    }), facts())
    expect(codes(r)).toEqual(expect.arrayContaining(['stated_commitment_differs', 'stated_share_differs', 'stated_partner_unknown']))
    expect(r.lines.find(l => l.name === 'Alpha LP')?.commitment).not.toBe(5_000_000)
  })

  it('says nothing when the stated figures match', () => {
    const base = checkCapitalCall(request(), facts())
    const alpha = base.lines[0]
    const r = checkCapitalCall(request({
      statedPartners: [{ lp: alpha.lpEntityId, commitment: alpha.commitment, sharePct: Math.round(alpha.share * 10000) / 100 }],
    }), facts())
    expect(codes(r).filter(c => c.startsWith('stated_'))).toEqual([])
  })
})
