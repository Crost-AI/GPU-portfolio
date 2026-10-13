// Starting a memo-agent stage on a deal: analyzing the data room, researching, drafting the memo,
// scoring. Each is a job the worker picks up (lib/memo-agent/kick.ts starts it now rather than at
// the next cron). Shared by the web routes (app/api/diligence/[id]/agent/*) and `run_diligence_agent`
// from chat, so both refuse the same things: a second job while one runs, a stage whose input does
// not exist yet, and a run over the fund's cost caps.

import type { SupabaseClient } from '@supabase/supabase-js'
import { kickWorker } from './kick'
import { enforceCapsForStage } from './cost'
import { ASSISTANT_RUNNER } from './assistant-runner'
import { fundHasAIKey } from '@/lib/ai/keyless'
import { AUDIO_VIDEO_FORMATS } from './ingestion/sources'
import { done, fail, type Outcome } from '@/lib/service-outcome'

export const MEMO_AGENT_STAGES = ['analyze', 'research', 'draft', 'score'] as const
export type MemoAgentStage = typeof MEMO_AGENT_STAGES[number]

// Checklist statuses that still warrant (re)assessment. 'found' and 'not_applicable' are settled.
const ASSESSABLE_STATUSES = ['unknown', 'partial', 'missing']

type Ctx = { fundId: string; userId: string }
type Body = Record<string, unknown>

async function activeJob(admin: SupabaseClient, fundId: string, dealId: string): Promise<Outcome<never> | null> {
  const { data: existing } = await (admin as any)
    .from('memo_agent_jobs')
    .select('id, status, kind, external_job_id')
    .eq('deal_id', dealId)
    .eq('fund_id', fundId)
    .in('status', ['pending', 'running'])
    .limit(1)
    .maybeSingle()
  if (!existing) return null
  if (existing.external_job_id === ASSISTANT_RUNNER) {
    return fail(409, `A ${existing.kind} job is waiting for your assistant. Carry it on with diligence_stage_next.`, { job_id: existing.id })
  }
  return fail(409, `A ${existing.kind} job is already ${existing.status}.`, { job_id: existing.id })
}

async function enqueue(admin: SupabaseClient, row: Record<string, unknown>): Promise<Outcome<{ id: string; status: string }>> {
  const { data, error } = await (admin as any).from('memo_agent_jobs').insert(row).select('id, kind, status').single()
  if (error || !data) return fail(500, error?.message ?? 'enqueue failed')
  await kickWorker()
  return done({ id: data.id as string, status: data.status as string })
}

/**
 * The fund's cost caps, which meter the server's model. With no server key the person's own
 * assistant answers (assistant-jobs.ts), at no cost to the fund, so there is nothing to cap.
 */
async function capsFor(admin: SupabaseClient, fundId: string, dealId: string, stage: 'ingest' | 'research' | 'draft' | 'score') {
  if (!(await fundHasAIKey(admin, fundId))) return { ok: true as const, estimate: null, caps: null, reason: undefined }
  return enforceCapsForStage({ admin: admin as any, fundId, dealId, stage })
}

async function setStage(admin: SupabaseClient, fundId: string, dealId: string, stage: string) {
  await (admin as any).from('diligence_deals').update({ current_memo_stage: stage }).eq('id', dealId).eq('fund_id', fundId)
}

/** The latest open draft, when the data room has been analyzed into it. */
async function analyzedDraft(admin: SupabaseClient, fundId: string, dealId: string): Promise<{ id: string } | null> {
  const { data } = await (admin as any)
    .from('diligence_memo_drafts')
    .select('id, ingestion_output')
    .eq('deal_id', dealId)
    .eq('fund_id', fundId)
    .eq('is_draft', true)
    .not('ingestion_output', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return data ? { id: data.id as string } : null
}

/**
 * Analyze the data room. Incremental by default: only documents not yet parsed are ingested, and
 * with nothing new it re-checks the open checklist items against the existing analysis. `full`
 * re-ingests everything and re-checks every item; `documentIds` names exactly what to ingest.
 */
export async function enqueueAnalysis(
  admin: SupabaseClient, ctx: Ctx, dealId: string, opts: { documentIds?: string[]; full?: boolean } = {},
): Promise<Outcome<Body>> {
  const { fundId } = ctx
  const db = admin as any
  const busy = await activeJob(admin, fundId, dealId)
  if (busy) return busy
  const explicitIds = opts.documentIds?.filter(x => typeof x === 'string')

  const docs = async () => {
    const { data } = await db
      .from('diligence_documents')
      .select('id, parse_status, file_format, detected_type')
      .eq('deal_id', dealId)
      .eq('fund_id', fundId)
      .neq('parse_status', 'skipped')
      .neq('detected_type', 'call_recording')
    return ((data ?? []) as Array<{ id: string; parse_status: string; file_format: string | null }>)
      .filter(r => !AUDIO_VIDEO_FORMATS.has((r.file_format ?? '').toLowerCase()))
  }
  const checkChecklist = async (payload: Body, extra: Body) => {
    const job = await enqueue(admin, { fund_id: fundId, deal_id: dealId, kind: 'checklist_assessment', payload, enqueued_by: ctx.userId })
    if (!job.ok) return job
    return done({ job_id: job.value.id, kind: 'checklist_assessment', status: job.value.status, ...extra })
  }
  const ingest = async (payload: Body, extra: (caps: { estimate: unknown; caps: unknown }) => Body) => {
    const enforced = await capsFor(admin, fundId, dealId, 'ingest')
    if (!enforced.ok) return fail(422, enforced.reason ?? 'This would go over the fund\'s cost caps.', { estimate: enforced.estimate, caps: enforced.caps })
    const job = await enqueue(admin, { fund_id: fundId, deal_id: dealId, kind: 'ingest', payload, enqueued_by: ctx.userId })
    if (!job.ok) return job
    await setStage(admin, fundId, dealId, 'ingest')
    return done({ job_id: job.value.id, kind: 'ingest', status: job.value.status, ...extra({ estimate: enforced.estimate, caps: enforced.caps }) })
  }

  if (opts.full && (!explicitIds || explicitIds.length === 0)) {
    if ((await docs()).length > 0) {
      return ingest({ full: true }, c => ({
        full: true, ...c, message: 'Re-analyzing everything, re-ingesting all files and re-checking every checklist item.',
      }))
    }
    const { count } = await db.from('diligence_checklist_items').select('id', { count: 'exact', head: true })
      .eq('deal_id', dealId).eq('fund_id', fundId).eq('kind', 'item')
    if (count && count > 0) return checkChecklist({ all: true }, { full: true })
    return done({ skipped: true, message: 'No documents or checklist to analyze.' })
  }

  const toIngest = explicitIds && explicitIds.length > 0
    ? explicitIds
    : (await docs()).filter(r => r.parse_status !== 'parsed').map(r => r.id)

  if (toIngest.length === 0) {
    const { count } = await db.from('diligence_checklist_items').select('id', { count: 'exact', head: true })
      .eq('deal_id', dealId).eq('fund_id', fundId).eq('kind', 'item').in('status', ASSESSABLE_STATUSES)
    if (!count) {
      return done({ skipped: true, up_to_date: true, message: 'Data room and checklist are already up to date, nothing new to analyze.' })
    }
    return checkChecklist({}, {
      skipped_ingestion: true, message: 'Data room unchanged, re-checking the checklist against the existing analysis.',
    })
  }
  return ingest({ document_ids: toIngest }, c => ({ analyzing_documents: toIngest.length, ...c }))
}

/** Research, draft or score: each needs an analyzed data room first. */
export async function enqueueDraftStage(
  admin: SupabaseClient, ctx: Ctx, dealId: string, stage: 'research' | 'draft' | 'score',
): Promise<Outcome<Body>> {
  const { fundId } = ctx
  const draft = await analyzedDraft(admin, fundId, dealId)
  if (!draft) {
    return fail(409, {
      research: 'Run Stage 1 ingest first, research depends on the ingestion output.',
      draft: 'Run Stage 1 ingest before drafting.',
      score: 'Nothing to score yet. Analyze the data room first.',
    }[stage])
  }
  const busy = await activeJob(admin, fundId, dealId)
  if (busy) return busy

  const enforced = await capsFor(admin, fundId, dealId, stage)
  if (!enforced.ok) return fail(422, enforced.reason ?? 'This would go over the fund\'s cost caps.', { estimate: enforced.estimate, caps: enforced.caps })

  const job = await enqueue(admin, { fund_id: fundId, deal_id: dealId, draft_id: draft.id, kind: stage, enqueued_by: ctx.userId })
  if (!job.ok) return job
  // Scoring judges the evidence, not the memo, so it does not move the memo's stage.
  if (stage !== 'score') await setStage(admin, fundId, dealId, stage)
  return done({ job_id: job.value.id, kind: stage, status: job.value.status, estimate: enforced.estimate, caps: enforced.caps })
}

export function enqueueMemoStage(
  admin: SupabaseClient, ctx: Ctx, dealId: string, stage: MemoAgentStage, opts: { full?: boolean } = {},
): Promise<Outcome<Body>> {
  return stage === 'analyze' ? enqueueAnalysis(admin, ctx, dealId, opts) : enqueueDraftStage(admin, ctx, dealId, stage)
}
