// Which handler runs a memo-agent job. Shared by the worker (app/api/cron/memo-agent-worker) and by
// the assistant runner (lib/memo-agent/assistant-jobs.ts), so a job does the same thing whichever
// model answers it.

import { createAdminClient } from '@/lib/supabase/admin'
import { runIngestJob } from './ingest-job'
import { runIngestSynthesisJob } from './ingest-synthesis-job'
import { runResearchJob } from './research-job'
import { runDraftJob } from './draft-job'
import { runDraftReviewJob } from './draft-review-job'
import { runScoreJob } from './score-job'
import { runRenderJob } from './render-job'
import { runTranscribeJob } from './transcribe-job'
import { runChecklistAssessmentJob } from './checklist-assessment-job'
import { runAffinitySyncJob } from './affinity-sync-job'

type Admin = ReturnType<typeof createAdminClient>

export interface MemoJob {
  id: string
  fund_id: string
  deal_id: string
  draft_id: string | null
  kind: 'ingest' | 'ingest_synthesis' | 'research' | 'qa' | 'draft' | 'draft_review' | 'score' | 'render' | 'transcribe' | 'checklist_assessment' | 'affinity_sync'
  payload: Record<string, unknown>
  enqueued_by: string | null
}

/** Kinds that ask a language model, so without a server key they wait for the person's assistant. */
export const MODEL_JOB_KINDS: ReadonlySet<string> = new Set([
  'ingest', 'ingest_synthesis', 'research', 'draft', 'draft_review', 'score', 'checklist_assessment',
])

/** What a job waiting for the person's assistant says, on the deal page and to diligence_job_status. */
export const AWAITING_ASSISTANT_JOB = 'Waiting for your assistant: this fund has no server AI key. Ask your assistant to run the memo agent (diligence_stage_next).'

/** Run the job's handler. Throws on failure, and for a kind no worker runs. */
export async function runJobHandler(admin: Admin, job: MemoJob): Promise<unknown> {
  switch (job.kind) {
    case 'ingest': return runIngestJob(admin, job)
    case 'ingest_synthesis': return runIngestSynthesisJob(admin, job)
    case 'research': return runResearchJob(admin, job)
    case 'draft': return runDraftJob(admin, job)
    case 'draft_review': return runDraftReviewJob(admin, job)
    case 'score': return runScoreJob(admin, job)
    case 'render': return runRenderJob(admin, job)
    case 'transcribe': return runTranscribeJob(admin, job as any)
    case 'checklist_assessment': return runChecklistAssessmentJob(admin, job)
    case 'affinity_sync': return runAffinitySyncJob(admin, job)
    // Q&A is a synchronous interactive flow, not a worker job.
    case 'qa': throw new Error('Q&A is run interactively; no worker job needed.')
    default: throw new Error(`Unknown job kind: ${(job as { kind: string }).kind}`)
  }
}
