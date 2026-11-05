import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

// ── GPU fleet (P3) ── The review queue's shared functions (lib/review/resolve.ts) serve the review
// page's route AND the agent's review_queue / resolve_review tools. The tools read with the service
// role, so RLS's fleet policy (20261019310000) is not in their path: a review or a needs-review email
// about a GPU SPV's fleet company must be left out, and resolving one refused, for a caller without
// fleet (#91), by these functions themselves.

const s = vi.hoisted(() => ({ access: null as any }))
vi.mock('@/lib/access/effective', async (orig) => ({ ...(await orig<any>()), loadAccessContext: async () => s.access }))
vi.mock('@/lib/activity', () => ({ logActivity: () => {} }))
vi.mock('@/lib/cache/tags', () => ({ expireTag: () => {} }))
import { loadReviewForAccess, loadReviewQueue, resolveReview } from '@/lib/review/resolve'

const member = (fleet: 'none' | 'read' | 'write') => ({
  fundId: 'f', userId: 'u', role: 'member', features: { gpu_fleet: 'everyone', accounting: 'everyone' },
  grants: { portfolio: 'write', accounting: 'read', fleet }, defaults: {}, vehicles: { all: true, ids: [] },
})

const review = (id: string, companyId: string) => ({
  id, fund_id: 'f', email_id: null, metric_id: null, company_id: companyId, vehicle_id: null,
  issue_type: 'ambiguous_period', resolution: null, extracted_value: '1', payload: null,
  context_snippet: null, created_at: '2026-10-01T00:00:00Z',
})

let m: ReturnType<typeof memoryAdmin>
beforeEach(() => {
  m = memoryAdmin({
    companies: [
      { id: 'fleet-co', fund_id: 'f', name: 'GPU fleet', holding_type: 'gpu_fleet' },
      { id: 'vc-co', fund_id: 'f', name: 'Acme', holding_type: 'company' },
    ],
    fund_members: [{ fund_id: 'f', user_id: 'u', role: 'member' }],
    parsing_reviews: [review('r-fleet', 'fleet-co'), review('r-vc', 'vc-co')],
    inbound_emails: [
      { id: 'e-fleet', fund_id: 'f', company_id: 'fleet-co', processing_status: 'needs_review', received_at: '2026-10-01', subject: 'a', from_address: 'a@x.example' },
      { id: 'e-vc', fund_id: 'f', company_id: 'vc-co', processing_status: 'needs_review', received_at: '2026-10-01', subject: 'b', from_address: 'b@x.example' },
    ],
    fund_settings: [{ fund_id: 'f', retain_resolved_reviews: true }],
  })
})

describe('the agent review queue and a fleet company', () => {
  it('leaves fleet reviews and emails out for a caller without fleet read', async () => {
    s.access = member('none')
    const q = await loadReviewQueue(m.admin as any, s.access)
    expect(q.items.map(i => i.id)).toEqual(['r-vc'])
    expect(q.needsReviewEmails.map(e => e.id)).toEqual(['e-vc'])
    expect(await loadReviewForAccess(m.admin as any, s.access, 'r-fleet')).toBeNull()
    expect(await loadReviewForAccess(m.admin as any, s.access, 'r-vc')).not.toBeNull()
  })

  it('shows them to a caller with fleet read', async () => {
    s.access = member('read')
    const q = await loadReviewQueue(m.admin as any, s.access)
    expect(q.items.map(i => i.id).sort()).toEqual(['r-fleet', 'r-vc'])
    expect(q.needsReviewEmails.map(e => e.id).sort()).toEqual(['e-fleet', 'e-vc'])
  })
})

describe('resolving a review about a fleet company', () => {
  const caller = () => ({ fundId: 'f', userId: 'u', loadAccess: async () => s.access })
  const fleetRow = () => m.tables.parsing_reviews.find((r: any) => r.id === 'r-fleet')!

  it('is not found, and nothing is claimed, without fleet write', async () => {
    s.access = member('read')
    const out = await resolveReview(m.admin as any, caller(), fleetRow() as any, { resolution: 'rejected' })
    expect(out).toEqual({ ok: false, status: 404, error: 'Not found' })
    expect(fleetRow().resolution).toBeNull()
  })

  it('goes through with fleet write', async () => {
    s.access = member('write')
    const out = await resolveReview(m.admin as any, caller(), fleetRow() as any, { resolution: 'rejected' })
    expect(out.ok).toBe(true)
    expect(fleetRow().resolution).toBe('rejected')
  })

  it('leaves a VC company review as it was', async () => {
    s.access = member('none')
    const vc = m.tables.parsing_reviews.find((r: any) => r.id === 'r-vc')
    const out = await resolveReview(m.admin as any, caller(), vc as any, { resolution: 'rejected' })
    expect(out.ok).toBe(true)
  })
})
