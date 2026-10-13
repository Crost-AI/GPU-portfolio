import { describe, it, expect, vi, beforeEach } from 'vitest'

// Publishing an issued call's notices from chat: a review first (what each partner would get, and
// what is missing or wrong), a token tying the request to that review, and an approval that runs
// only in the app, confirmed twice (lib/accounting/call-notice-review.ts,
// lib/pending-actions/call-notices.ts, lib/pending-actions/service.ts).

const m = vi.hoisted(() => ({
  reg: null as any,
  recipients: [] as any[],
  portalEnabled: true,
  facts: { wireInstructions: 'Bank: First' as string | null, storedNoticeDays: 10 as number | null, storedNoticeBasis: 'calendar', today: '2026-10-13' },
  publish: vi.fn(),
}))

vi.mock('@/lib/accounting/notice-register', () => ({
  loadNoticeRegister: async () => m.reg,
  previewNoticeRecipients: async (_a: any, _f: string, _g: string, _r: any, ids: string[]) => ({
    recipients: m.recipients.filter(r => ids.includes(r.lpEntityId)), portalEnabled: m.portalEnabled, hasProvider: true, subject: '', html: '',
  }),
}))
vi.mock('@/lib/accounting/notices', () => ({
  loadNoticeRegister: async () => m.reg,
  publishNotices: m.publish,
}))
vi.mock('@/lib/accounting/proposed-calls', () => ({ loadCallFacts: async () => m.facts }))
vi.mock('@/lib/accounting/vehicle-resolver', () => ({ resolveVehicle: async (_a: any, _f: string, v?: string) => v ?? 'Fund I' }))

import { reviewCallNotices } from '@/lib/accounting/call-notice-review'
import { previewPublishCallNotices, STALE_PREVIEW_MESSAGE } from '@/lib/pending-actions/call-notices'
import { executePublishCallNotices } from '@/lib/pending-actions/call-notices-publish'
import { previewBlockers } from '@/lib/pending-actions/blockers'

const ctx = { fundId: 'f1', group: 'Fund I' }
const deps = { admin: {} as any, fundId: 'f1', userId: 'u1', access: {} as any }

function setUp() {
  m.reg = {
    kind: 'capital_call', id: 'call1', noticeDate: '2026-10-13', dueDate: '2026-10-30', description: 'Acme round',
    numberLabel: 3, purposes: [{ label: 'Acme round', amount: 1_000_000 }], tiers: null, posted: true, tracking: false,
    lines: [
      { id: 'l1', lpEntityId: 'lp1', amount: 600_000, role: 'lp', noticeDocumentId: null },
      { id: 'l2', lpEntityId: 'lp2', amount: 400_000, role: 'lp', noticeDocumentId: null },
    ],
  }
  m.recipients = [
    { lpEntityId: 'lp1', name: 'Alpha LP', amount: 600_000, to: 'alpha@example.com', cc: [], skipped: null },
    { lpEntityId: 'lp2', name: 'Beta LP', amount: 400_000, to: null, cc: [], skipped: 'No portal account yet' },
  ]
  m.portalEnabled = true
  m.facts = { wireInstructions: 'Bank: First', storedNoticeDays: 10, storedNoticeBasis: 'calendar', today: '2026-10-13' }
  m.publish.mockReset().mockResolvedValue({ published: [{ reused: false }, { reused: false }], errors: [] })
}

describe('reviewing a call\'s notices', () => {
  beforeEach(setUp)

  it('lists each partner from the register, with share and who can open it', async () => {
    const r = await reviewCallNotices({} as any, ctx, 'call1')
    if (!r.ok) throw new Error(r.error)
    expect(r.value.partners.map(p => [p.name, p.amount, p.share])).toEqual([['Alpha LP', 600_000, 0.6], ['Beta LP', 400_000, 0.4]])
    expect(r.value.newNotices).toBe(2)
    expect(r.value.flags.map(f => f.code)).toEqual(['not_shared'])
  })

  it('flags a due date inside the LPA notice period, and lists what is missing', async () => {
    m.reg.dueDate = '2026-10-20'
    m.facts.wireInstructions = null
    const r = await reviewCallNotices({} as any, ctx, 'call1')
    if (!r.ok) throw new Error(r.error)
    expect(r.value.earliestDueDate).toBe('2026-10-23')
    expect(r.value.flags.map(f => f.code)).toContain('due_inside_notice_period')
    expect(r.value.missing.map(x => x.field)).toContain('wire_instructions')
  })

  it('changes its token when anything on the notice changes', async () => {
    const a = await reviewCallNotices({} as any, ctx, 'call1')
    m.reg.lines[0].amount = 600_000.01
    const b = await reviewCallNotices({} as any, ctx, 'call1')
    m.reg.lines[0].amount = 600_000
    m.facts.wireInstructions = 'Bank: Second'
    const c = await reviewCallNotices({} as any, ctx, 'call1')
    if (!a.ok || !b.ok || !c.ok) throw new Error('review failed')
    expect(new Set([a.value.previewToken, b.value.previewToken, c.value.previewToken]).size).toBe(3)
  })

  it('blocks when every partner already has the notice, and refuses a partner not on the call', async () => {
    for (const l of m.reg.lines) l.noticeDocumentId = 'doc'
    const r = await reviewCallNotices({} as any, ctx, 'call1')
    if (!r.ok) throw new Error(r.error)
    expect(r.value.flags.find(f => f.code === 'nothing_to_publish')?.severity).toBe('blocker')
    expect(await reviewCallNotices({} as any, ctx, 'call1', { lpEntityIds: ['lp9'] })).toMatchObject({ ok: false, status: 400 })
  })
})

describe('staging and publishing', () => {
  beforeEach(setUp)

  it('a stale token is a blocker in the preview, so it cannot be staged', async () => {
    const p = await previewPublishCallNotices(deps, { vehicle: 'Fund I', callId: 'call1', previewToken: 'old' })
    expect(previewBlockers(p)).toContain('changed since they were previewed')
  })

  it('publishes only what was previewed', async () => {
    const r = await reviewCallNotices({} as any, ctx, 'call1')
    if (!r.ok) throw new Error(r.error)
    const out = await executePublishCallNotices(deps, { vehicle: 'Fund I', callId: 'call1', previewToken: r.value.previewToken })
    expect(out).toMatchObject({ published: 2, reused: 0 })
    expect(m.publish).toHaveBeenCalledWith(deps.admin, { fundId: 'f1', group: 'Fund I', userId: 'u1' }, m.reg, { lpEntityIds: ['lp1', 'lp2'] })
  })

  it('refuses when the call changed after the preview, publishing nothing', async () => {
    const r = await reviewCallNotices({} as any, ctx, 'call1')
    if (!r.ok) throw new Error(r.error)
    m.reg.dueDate = '2026-11-15'
    await expect(executePublishCallNotices(deps, { vehicle: 'Fund I', callId: 'call1', previewToken: r.value.previewToken }))
      .rejects.toThrow(STALE_PREVIEW_MESSAGE)
    expect(m.publish).not.toHaveBeenCalled()
  })
})

describe('a staged request whose call can no longer be noticed', () => {
  beforeEach(setUp)

  it('still previews, as a blocker, so the approver can reject it', async () => {
    m.reg = { error: 'Its journal entry is voided, not posted.', status: 400 }
    const p = await previewPublishCallNotices(deps, { vehicle: 'Fund I', callId: 'call1', previewToken: 't' })
    expect(previewBlockers(p)).toContain('voided')
  })
})
