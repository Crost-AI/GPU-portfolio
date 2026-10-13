import { describe, it, expect, vi, beforeEach } from 'vitest'

const capitalSource = vi.hoisted(() => ({ value: 'ledger' as 'ledger' | 'events' }))

vi.mock('@/lib/accounting/agent-tools', () => ({
  resolveVehicle: async (_a: any, _f: string, g: string) => g ?? 'V1',
}))
// Capital calls post to the ledger, so the preview refuses a vehicle still on event sourcing.
vi.mock('@/lib/accounting/capital-source', () => ({
  loadCapitalSource: async () => capitalSource.value,
}))
vi.mock('@/lib/accounting/load', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  loadOwnership: async () => [
    { lpEntityId: 'lp1', commitment: 60 },
    { lpEntityId: 'lp2', commitment: 40 },
  ],
  loadEntityNames: async () => new Map([['lp1', 'Alpha LP'], ['lp2', 'Beta LP']]),
}))

const issue = vi.hoisted(() => vi.fn(async () => ({ callId: 'call1', entryId: 'e1' })))
vi.mock('@/lib/accounting/capital-calls', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  issueCapitalCall: issue,
}))
// The records the checks read: a 10-day LPA notice period, nothing called yet.
vi.mock('@/lib/accounting/proposed-calls', () => ({
  loadCallFacts: async () => ({
    vehicle: 'V1', currency: 'USD', fundAddress: '1 Main St', wireInstructions: 'Bank: First',
    storedNoticeDays: 10, storedNoticeBasis: 'calendar', today: '2026-07-01',
    partners: [
      { lpEntityId: 'lp1', name: 'Alpha LP', commitment: 600_000, calledToDate: 0 },
      { lpEntityId: 'lp2', name: 'Beta LP', commitment: 400_000, calledToDate: 0 },
    ],
  }),
}))

import { previewIssueCapitalCall, executeIssueCapitalCall } from '@/lib/pending-actions/capital-call'

const deps = { admin: {} as any, fundId: 'f1', userId: 'u1', access: {} as any }

describe('capital-call action preview', () => {
  beforeEach(() => {
    capitalSource.value = 'ledger'
    issue.mockClear()
  })

  it('splits a call pro-rata by commitment and totals correctly, writing nothing', async () => {
    const p = await previewIssueCapitalCall(
      deps,
      { vehicle: 'V1', callDate: '2026-07-01', total: 1_000_000 },
    )
    expect(p.details.total).toBe(1_000_000)
    const perLp = p.details.perLp as Array<{ lp: string; commitment: number; amount: number }>
    expect(perLp).toHaveLength(2)
    const byName = Object.fromEntries(perLp.map(x => [x.lp, x.amount]))
    expect(byName['Alpha LP']).toBe(600_000)
    expect(byName['Beta LP']).toBe(400_000)
    // commitments surfaced for the approver
    expect(perLp.find(x => x.lp === 'Alpha LP')?.commitment).toBe(60)
  })

  it('previews a call without requiring accounting activation', async () => {
    capitalSource.value = 'events'
    await expect(previewIssueCapitalCall(deps, { vehicle: 'V1', callDate: '2026-07-01', total: 1_000_000 }))
      .resolves.toHaveProperty('details.total', 1_000_000)
  })

  it('shows the approver the same checks a proposed call gets', async () => {
    const p = await previewIssueCapitalCall(deps, {
      vehicle: 'V1', callDate: '2026-07-01', dueDate: '2026-07-05', total: 100,
      purposes: [{ category: 'investment', amount: 100 }],
    })
    expect(p.details.earliestDueDate).toBe('2026-07-11')
    expect((p.details.flags as any[]).map(f => f.code)).toContain('due_inside_notice_period')
  })
})

describe('capital-call action execute', () => {
  beforeEach(() => { issue.mockClear() })

  it('refuses a blocker, writing nothing', async () => {
    await expect(executeIssueCapitalCall(deps, {
      vehicle: 'V1', callDate: '2026-07-01', total: 100,
      purposes: [{ category: 'investment', amount: 60 }],
    })).rejects.toThrow(/add up to/)
    expect(issue).not.toHaveBeenCalled()
  })

  it('issues with the due date and freezes the purposes on the call', async () => {
    const update = vi.fn(() => ({ eq: () => ({ eq: async () => ({ error: null }) }) }))
    const admin = { from: vi.fn(() => ({ update })) } as any
    const out = await executeIssueCapitalCall({ ...deps, admin }, {
      vehicle: 'V1', callDate: '2026-07-01', dueDate: '2026-07-15', total: 100,
      purposes: [{ category: 'investment', amount: 100 }],
    })
    expect(out).toEqual({ callId: 'call1' })
    expect(issue).toHaveBeenCalledWith(admin, 'f1', 'V1', 'u1', expect.objectContaining({ dueDate: '2026-07-15' }))
    expect(update).toHaveBeenCalledWith({ purposes: [expect.objectContaining({ category: 'investment', amount: 100 })] })
  })
})
