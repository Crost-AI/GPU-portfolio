import { describe, it, expect } from 'vitest'
import { runUntilBlocked, type AssistantAnswer } from './assistant-runner'
import { runJobHandler, type MemoJob } from './jobs/dispatch'
import { memoryAdmin } from '../../tests/helpers/memory-admin'

// Every model-backed memo-agent job, run for the assistant on an in-memory database. What this
// pins is the property the runner depends on: run twice with the same answers, a stage asks the
// same calls again (same ids). If a stage built its prompt from something unordered or time-based,
// its calls would get new ids on every rerun and the assistant could never answer them.

const ingestion = {
  documents: [
    { document_id: 'doc-1', file_name: 'deck.pdf', detected_type: 'pitch_deck', summary: 'Seed deck', claims: [
      { id: 'c1', text: 'ARR is $1.2M', category: 'traction', checklist_item_id: 'item-1' },
      { id: 'c2', text: 'Net retention 120%', category: 'traction' },
    ] },
  ],
  gap_analysis: { missing: [], present: [] },
  cross_doc_flags: [],
}

function seed() {
  return memoryAdmin({
    fund_settings: [{ fund_id: 'f1', memo_agent_web_search_enabled: false }],
    diligence_deals: [{ id: 'dd-1', fund_id: 'f1', name: 'Acme', stage_at_consideration: 'seed', current_memo_stage: 'draft' }],
    diligence_memo_drafts: [{
      id: 'md-1', fund_id: 'f1', deal_id: 'dd-1', is_draft: true, created_at: '2026-10-01', draft_version: 1,
      ingestion_output: ingestion,
      research_output: { findings: [], contradictions: [], competitive_map: { named_by_company: [], named_by_research: [] }, founder_dossiers: [], research_gaps: [], research_mode: 'no_web_search' },
      qa_answers: [],
      memo_draft_output: null,
    }],
    diligence_checklist_items: [
      { id: 'sec-1', fund_id: 'f1', deal_id: 'dd-1', kind: 'section', parent_id: null, label: 'Traction', order_index: 0, status: 'unknown' },
      { id: 'item-1', fund_id: 'f1', deal_id: 'dd-1', kind: 'item', parent_id: 'sec-1', label: 'Revenue', order_index: 1, status: 'unknown' },
    ],
    diligence_documents: [],
    memo_agent_jobs: [],
  })
}

// One answer every stage's parser accepts in shape, so a multi-call stage (the draft's outline, then
// its section fills) gets past its first round.
const ANSWER = JSON.stringify({
  header: { company: 'Acme' },
  sections: [{ section_id: 'thesis', paragraphs: [{ topic: 'Why now' }] }, { section_id: 'team', paragraphs: [{ topic: 'Founders' }] }],
  paragraphs: [{ section_id: 'thesis', order: 1, prose: 'Strong pull.', sources: [{ source_type: 'claim', source_id: 'c1' }] }],
  edits: [],
  findings: [], contradictions: [], research_gaps: [], founder_dossiers: [],
  competitive_map: { named_by_company: [], named_by_research: [] },
  gap_analysis: { missing: [], present: [] }, cross_doc_flags: [],
})

const KINDS: MemoJob['kind'][] = ['ingest_synthesis', 'checklist_assessment', 'research', 'draft', 'draft_review', 'score']

// Ingest of a single document is not here: it downloads the file from storage, which the in-memory
// database does not have. Its prompt is built from the file's extracted text and the checklist,
// both read in a fixed order.
describe.each(KINDS)('the %s job on the assistant', kind => {
  it('asks the same calls on every rerun, round after round', async () => {
    const { admin } = seed() as any
    const job: MemoJob = { id: `job-${kind}`, fund_id: 'f1', deal_id: 'dd-1', draft_id: 'md-1', kind, payload: {}, enqueued_by: 'u1' }
    const answers: Record<string, AssistantAnswer> = {}
    let rounds = 0
    for (; rounds < 8; rounds++) {
      const first = await runUntilBlocked(answers, () => runJobHandler(admin, job), 150).catch(e => ({ error: e as Error }))
      if ('error' in first || first.done) break
      const again = await runUntilBlocked(answers, () => runJobHandler(admin, job), 150)
      expect(again.done).toBe(false)
      if (again.done) break
      expect(again.calls.map(c => c.id).sort()).toEqual(first.calls.map(c => c.id).sort())
      for (const c of first.calls) answers[c.id] = { text: ANSWER }
    }
    expect(rounds, 'the stage asked a model at least once').toBeGreaterThan(0)
  }, 30_000)
})
