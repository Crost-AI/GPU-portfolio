import { describe, expect, it } from 'vitest'
import { jobHandle, jobRecordId, jobState } from '@/lib/agent/jobs'
import { AGENT_TOOLS } from '@/lib/accounting/agent-tools'

/** A job handle names the status tool that reads it back, and that tool exists. */
describe('agent jobs', () => {
  it('reads every table\'s statuses as four states', () => {
    expect(['pending', 'queued'].map(jobState)).toEqual(['queued', 'queued'])
    expect(['running', 'processing', 'generating'].map(jobState)).toEqual(['running', 'running', 'running'])
    expect(['failed', 'error', 'cancelled'].map(jobState)).toEqual(['failed', 'failed', 'failed'])
    expect(['success', 'complete', 'needs_review'].map(jobState)).toEqual(['done', 'done', 'done'])
  })

  it('carries its kind in the id, and refuses a job of another kind', () => {
    const h = jobHandle('deal_research', 'd1', 'pending')
    expect(h).toMatchObject({ id: 'deal_research:d1', status: 'queued', check_with: 'deals_research_status' })
    expect(h.next).toMatch(/Don't poll/)
    expect(jobRecordId('deal_research', h.id)).toBe('d1')
    expect(jobRecordId('deal_research', 'd1')).toBe('d1')
    expect(() => jobRecordId('diligence', h.id)).toThrow(/deals_research_status/)
    expect(() => jobRecordId('diligence', '')).toThrow(/required/)
  })

  it('points at status tools that are registered', () => {
    const names = new Set(AGENT_TOOLS.map(t => t.name))
    for (const tool of ['diligence_job_status', 'deals_research_status', 'company_update_status']) expect(names.has(tool)).toBe(true)
  })
})
