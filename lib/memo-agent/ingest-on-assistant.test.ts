import { describe, it, expect } from 'vitest'
import { advanceAssistantJobs, submitAssistantAnswers, readAssistantCall, assistantCallAttachment, type StageStep } from './assistant-jobs'
import { ASSISTANT_RUNNER } from './assistant-runner'
import { memoryAdmin } from '../../tests/helpers/memory-admin'

// The data room read end to end by the assistant: the ingest job (seven documents, five at a time,
// one of them an image), then the synthesis it queues, through diligence_stage_next/_submit's own
// functions on an in-memory database with file storage.

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

function seed() {
  const files: Record<string, Buffer> = {}
  const docs = Array.from({ length: 7 }, (_, i) => {
    const image = i === 6
    const path = `dd-1/doc-${i}.${image ? 'png' : 'txt'}`
    files[path] = image ? PNG : Buffer.from(`Document ${i}: ARR is $${i + 1}M and growing.`)
    return {
      id: `doc-${i}`, fund_id: 'f1', deal_id: 'dd-1', storage_path: path, file_name: `doc-${i}.${image ? 'png' : 'txt'}`,
      file_format: image ? 'png' : 'txt', file_size_bytes: files[path].length, detected_type: null,
      parse_status: 'pending', uploaded_at: `2026-10-0${i + 1}T00:00:00Z`,
    }
  })
  const db = memoryAdmin({
    fund_settings: [{ fund_id: 'f1' }],
    diligence_deals: [{ id: 'dd-1', fund_id: 'f1', name: 'Acme', stage_at_consideration: 'seed', current_memo_stage: 'ingest' }],
    diligence_documents: docs,
    diligence_memo_drafts: [],
    diligence_checklist_items: [],
    memo_agent_jobs: [{
      id: 'job-1', fund_id: 'f1', deal_id: 'dd-1', draft_id: null, kind: 'ingest', payload: {}, enqueued_by: 'u1',
      status: 'running', external_job_id: ASSISTANT_RUNNER, enqueued_at: '2026-10-13T00:00:00Z',
    }],
  }, {
    // The column defaults a real memo_agent_jobs row gets.
    before: (table, op, payload) => {
      if (table !== 'memo_agent_jobs' || op !== 'insert') return
      for (const row of Array.isArray(payload) ? payload : [payload]) {
        row.status ??= 'pending'
        row.enqueued_at ??= new Date().toISOString()
      }
    },
  }) as any
  const admin = {
    ...db.admin,
    from: db.admin.from,
    storage: { from: () => ({ download: async (p: string) => (files[p] ? { data: new Blob([new Uint8Array(files[p])]), error: null } : { data: null, error: { message: 'missing' } }) }) },
  }
  return { admin, tables: db.tables as Record<string, any[]> }
}

const answerFor = (text: string) => text.includes('Target document for this call')
  ? JSON.stringify({ document_id: (text.match(/doc_id=(doc-\d)/) ?? [])[1], detected_type: 'financials', type_confidence: 'high', summary: 'A document.', claims: [{ id: 'c1', text: 'ARR', category: 'traction' }] })
  : JSON.stringify({ gap_analysis: { missing: [], present: [] }, cross_doc_flags: [] })

describe('ingesting a data room on the assistant', () => {
  it('reads every document, then queues and runs synthesis', async () => {
    const { admin, tables } = seed()
    let step: StageStep = await advanceAssistantJobs(admin, 'f1', 'dd-1')
    const kinds: string[] = []
    const rounds: number[] = []
    for (let i = 0; i < 10 && step.state === 'waiting'; i++) {
      rounds.push(step.calls!.length)
      kinds.push(step.job!.kind)
      const answers = []
      for (const c of step.calls!) {
        const { text } = await readAssistantCall(admin, 'f1', { jobId: step.job!.id, callId: c.call_id, maxChars: 60_000 })
        if (c.attachments) {
          // The image document comes over as an attachment, rebuilt on demand.
          const a = await assistantCallAttachment(admin, 'f1', step.job!.id, c.call_id, 1)
          expect(a.mediaType).toBe('image/png')
        }
        answers.push({ call_id: c.call_id, text: answerFor(text) })
      }
      step = await submitAssistantAnswers(admin, 'f1', step.job!.id, answers)
    }
    expect(step.state).toBe('done')
    // Five documents at once, then the last two, then the synthesis call.
    expect(rounds).toEqual([5, 2, 1])
    expect(kinds).toEqual(['ingest', 'ingest', 'ingest_synthesis'])
    expect(tables.diligence_documents.every(d => d.parse_status === 'parsed')).toBe(true)
    expect(tables.memo_agent_jobs.filter(j => j.status === 'success').map(j => j.kind)).toEqual(['ingest', 'ingest_synthesis'])
    expect(tables.diligence_memo_drafts[0].ingestion_output.documents).toHaveLength(7)
  }, 60_000)
})
