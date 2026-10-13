// The memo agent's jobs, run by the person's own assistant over MCP when the fund has no server key
// (diligence_stage_next / diligence_stage_read / diligence_stage_submit in lib/agent/diligence-tools.ts).
//
// The worker hands such a job over by leaving it `running` with external_job_id = 'assistant'
// (app/api/cron/memo-agent-worker). Here each job's own handler runs under the replay provider
// (assistant-runner.ts) until it either finishes, exactly as it would in the worker, or waits on
// model calls. The calls it waits on, and the answers given so far, live in the job's payload:
//
//   assistant_answers  { [call id]: { text, sources? } }
//   assistant_pending  { [call id]: { system_id, text, max_tokens, web_search, attachments } }
//   assistant_systems  { [system id]: system prompt }   (one stage sends the same one many times)

import crypto from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { extractJsonObject } from './parse-ai-json'
import {
  ASSISTANT_RUNNER, callAttachments, callText, runUntilBlocked,
  type AssistantAnswer, type AssistantCall,
} from './assistant-runner'
import { AWAITING_ASSISTANT_JOB, MODEL_JOB_KINDS, runJobHandler, type MemoJob } from './jobs/dispatch'

const JOB_COLUMNS = 'id, fund_id, deal_id, draft_id, kind, payload, enqueued_by, status, external_job_id'
/** Stop starting jobs after this long, so one tool call stays inside the function's time limit. */
const BUDGET_MS = 45_000

interface PendingCall {
  system_id: string
  text: string
  max_tokens: number
  web_search: boolean
  attachments: { index: number; mediaType: string }[]
}

type Payload = Record<string, unknown> & {
  assistant_answers?: Record<string, AssistantAnswer>
  assistant_pending?: Record<string, PendingCall>
  assistant_systems?: Record<string, string>
}

/** One call as the assistant first sees it: enough to plan, with the text read separately. */
export interface CallSummary {
  call_id: string
  system_id: string
  chars: number
  max_tokens: number
  web_search: boolean
  attachments: number
  begins: string
}

export interface StageStep {
  state: 'waiting' | 'done' | 'idle' | 'failed' | 'more'
  job?: { id: string; kind: string }
  calls?: CallSummary[]
  completed: { job_id: string; kind: string; result: unknown }[]
  error?: string
  next: string
}

const RUNNER_KEYS = ['assistant_answers', 'assistant_pending', 'assistant_systems']

/** The job as its handler expects it: the runner's bookkeeping is not part of its payload. */
function forHandler(job: MemoJob): MemoJob {
  const payload = Object.fromEntries(Object.entries(job.payload ?? {}).filter(([k]) => !RUNNER_KEYS.includes(k)))
  return { ...job, payload }
}

const systemId = (system: string) => crypto.createHash('sha256').update(system).digest('hex').slice(0, 12)

/** The job on this deal the assistant is running, claiming the next queued one if there is none. */
async function nextJob(admin: SupabaseClient, fundId: string, dealId: string): Promise<MemoJob | null> {
  const db = admin as any
  const mine = async () => {
    const { data } = await db.from('memo_agent_jobs').select(JOB_COLUMNS)
      .eq('fund_id', fundId).eq('deal_id', dealId).eq('status', 'running').eq('external_job_id', ASSISTANT_RUNNER)
      .order('enqueued_at', { ascending: true }).limit(1).maybeSingle()
    return (data as MemoJob | null) ?? null
  }
  const held = await mine()
  if (held) return held

  const { data: queued } = await db.from('memo_agent_jobs').select('id')
    .eq('fund_id', fundId).eq('deal_id', dealId).eq('status', 'pending').in('kind', [...MODEL_JOB_KINDS])
    .order('enqueued_at', { ascending: true }).limit(1).maybeSingle()
  if (!queued) return null
  const { data: claimed } = await db.from('memo_agent_jobs')
    .update({ status: 'running', external_job_id: ASSISTANT_RUNNER, started_at: new Date().toISOString(), progress_message: AWAITING_ASSISTANT_JOB })
    .eq('id', (queued as { id: string }).id).eq('status', 'pending')
    .select(JOB_COLUMNS).maybeSingle()
  // Lost the claim to the worker, which hands it straight back as ours.
  return (claimed as MemoJob | null) ?? (await mine())
}

function summarise(call: AssistantCall): CallSummary {
  const text = callText(call)
  return {
    call_id: call.id,
    system_id: systemId(call.system),
    chars: text.length,
    max_tokens: call.maxTokens,
    web_search: call.webSearch,
    attachments: callAttachments(call).length,
    begins: text.slice(0, 160).replace(/\s+/g, ' '),
  }
}

/** Run this deal's waiting memo-agent jobs as far as the answers so far allow. */
export async function advanceAssistantJobs(admin: SupabaseClient, fundId: string, dealId: string): Promise<StageStep> {
  const db = admin as any
  const started = Date.now()
  const completed: StageStep['completed'] = []

  while (Date.now() - started < BUDGET_MS) {
    const job = await nextJob(admin, fundId, dealId)
    if (!job) {
      return {
        state: completed.length ? 'done' : 'idle', completed,
        next: completed.length
          ? 'Nothing more is waiting on this deal. Tell the user what finished; diligence_deal_detail shows where the memo stands.'
          : 'Nothing is waiting on this deal. Start a stage with diligence_run_agent, then call diligence_stage_next.',
      }
    }
    const payload = (job.payload ?? {}) as Payload

    let out: Awaited<ReturnType<typeof runUntilBlocked<unknown>>>
    try {
      out = await runUntilBlocked(payload.assistant_answers ?? {}, () => runJobHandler(admin as any, forHandler(job)))
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      await db.from('memo_agent_jobs')
        .update({ status: 'failed', error, finished_at: new Date().toISOString(), progress_message: 'failed' }).eq('id', job.id)
      return { state: 'failed', job: { id: job.id, kind: job.kind }, error, completed, next: 'Tell the user this stage failed and why.' }
    }

    if (out.done) {
      await db.from('memo_agent_jobs').update({
        status: 'success', result: out.result as any, finished_at: new Date().toISOString(), progress_message: 'completed',
        // The answers have done their work; the bookkeeping would only weigh down the row.
        payload: forHandler(job).payload,
      }).eq('id', job.id)
      completed.push({ job_id: job.id, kind: job.kind, result: out.result })
      continue // a finished stage often queues the next (ingest → synthesis, draft → review and score)
    }

    const systems: Record<string, string> = {}
    const pending: Record<string, PendingCall> = {}
    for (const call of out.calls) {
      const sid = systemId(call.system)
      systems[sid] = call.system
      pending[call.id] = { system_id: sid, text: callText(call), max_tokens: call.maxTokens, web_search: call.webSearch, attachments: callAttachments(call) }
    }
    const n = out.calls.length
    await db.from('memo_agent_jobs').update({
      payload: { ...payload, assistant_pending: pending, assistant_systems: systems },
      progress_message: `Waiting for your assistant: ${n} ${n === 1 ? 'question' : 'questions'} in the ${job.kind.replace(/_/g, ' ')} stage.`,
    }).eq('id', job.id)
    return {
      state: 'waiting', job: { id: job.id, kind: job.kind }, calls: out.calls.map(summarise), completed,
      next: 'Each call is one request the memo agent would have sent to a model. For each: read its system prompt once ' +
        '(diligence_stage_read with part "system" and the system_id) and its content (diligence_stage_read with the call_id, paging with ' +
        'offset), do exactly what it asks, and answer with the JSON object it asks for and nothing else. Where web_search is ' +
        'true, search the web and pass the pages you used as sources. Send the answers with diligence_stage_submit; it carries the ' +
        'stage on and returns the next calls, until the stage is done.',
    }
  }
  return { state: 'more', completed, next: 'Out of time for this call; call diligence_stage_next again to carry on.' }
}

/** The job on this deal waiting on the assistant's answers. */
export async function waitingJobId(admin: SupabaseClient, fundId: string, dealId: string): Promise<string> {
  const { data } = await (admin as any).from('memo_agent_jobs').select('id')
    .eq('fund_id', fundId).eq('deal_id', dealId).eq('status', 'running').eq('external_job_id', ASSISTANT_RUNNER)
    .order('enqueued_at', { ascending: true }).limit(1).maybeSingle()
  if (!data) throw new Error('Nothing on this deal is waiting for your answers. Call diligence_stage_next.')
  return (data as { id: string }).id
}

async function heldJob(admin: SupabaseClient, fundId: string, jobId: string): Promise<MemoJob> {
  const { data } = await (admin as any).from('memo_agent_jobs').select(JOB_COLUMNS)
    .eq('id', jobId).eq('fund_id', fundId).maybeSingle()
  const job = data as (MemoJob & { status: string; external_job_id: string | null }) | null
  if (!job) throw new Error('No memo-agent job with that id.')
  if (job.status !== 'running' || job.external_job_id !== ASSISTANT_RUNNER) {
    throw new Error(`That job is ${job.status}, not waiting for your assistant. Call diligence_stage_next for what is.`)
  }
  return job
}

function pendingCall(job: MemoJob, callId: string): PendingCall {
  const pending = ((job.payload ?? {}) as Payload).assistant_pending ?? {}
  const call = pending[callId]
  if (!call) {
    const ids = Object.keys(pending)
    throw new Error(ids.length ? `No waiting call ${callId}. Waiting: ${ids.join(', ')}.` : 'No calls are waiting on this job; call diligence_stage_next.')
  }
  return call
}

/** A page of a waiting call's content, or of a system prompt. */
export async function readAssistantCall(
  admin: SupabaseClient, fundId: string,
  input: { jobId: string; callId?: string; systemId?: string; offset?: number; maxChars?: number },
): Promise<{ text: string; offset: number; total: number; next_offset: number | null }> {
  const job = await heldJob(admin, fundId, input.jobId)
  let text: string
  if (input.systemId) {
    const s = ((job.payload ?? {}) as Payload).assistant_systems?.[input.systemId]
    if (s === undefined) throw new Error(`No system prompt ${input.systemId} on this job.`)
    text = s
  } else {
    text = pendingCall(job, input.callId ?? '').text
  }
  const max = Math.min(60_000, Math.max(2_000, Math.floor(input.maxChars ?? 40_000)))
  const offset = Math.max(0, Math.floor(input.offset ?? 0))
  const end = Math.min(text.length, offset + max)
  return { text: text.slice(offset, end), offset, total: text.length, next_offset: end < text.length ? end : null }
}

/**
 * An attachment of a waiting call (a scanned PDF or an image the stage would have sent the model).
 * Not stored with the call, so the stage runs again to rebuild it.
 */
export async function assistantCallAttachment(
  admin: SupabaseClient, fundId: string, jobId: string, callId: string, index: number,
): Promise<{ mediaType: string; data: string }> {
  const job = await heldJob(admin, fundId, jobId)
  const call = pendingCall(job, callId)
  if (!call.attachments.some(a => a.index === index)) throw new Error(`Call ${callId} has no attachment ${index}.`)
  const out = await runUntilBlocked(((job.payload ?? {}) as Payload).assistant_answers ?? {}, () => runJobHandler(admin as any, forHandler(job)))
  const rebuilt = out.done ? null : out.calls.find(c => c.id === callId)
  const block = rebuilt?.content[index]
  if (!block || block.type === 'text') throw new Error('That call has changed since it was listed; call diligence_stage_next again.')
  return { mediaType: block.mediaType, data: block.data }
}

/** Check and store answers, then carry the deal's stages on. */
export async function submitAssistantAnswers(
  admin: SupabaseClient, fundId: string, jobId: string, answers: unknown,
): Promise<StageStep & { accepted: number }> {
  const job = await heldJob(admin, fundId, jobId)
  const payload = (job.payload ?? {}) as Payload
  const list = Array.isArray(answers) ? answers : []
  if (list.length === 0) throw new Error('answers is required: [{ call_id, text, sources? }].')

  const stored: Record<string, AssistantAnswer> = {}
  for (const a of list as Record<string, unknown>[]) {
    const id = String(a?.call_id ?? '')
    pendingCall(job, id)
    const text = typeof a?.text === 'string' ? a.text.trim() : ''
    try {
      if (!text) throw new Error('empty')
      extractJsonObject(text)
    } catch {
      throw new Error(`The answer to ${id} is not a JSON object. Answer with exactly the JSON the call asks for, nothing around it.`)
    }
    const sources = (Array.isArray(a?.sources) ? a.sources : [])
      .map(s => (typeof s === 'string' ? { url: s, title: '' } : s as { url?: unknown; title?: unknown }))
      .filter(s => typeof s?.url === 'string' && /^https?:\/\//i.test(s.url))
      .map(s => ({ url: String(s.url), title: typeof s.title === 'string' ? s.title : '' }))
    stored[id] = sources.length ? { text, sources } : { text }
  }

  const pending = { ...(payload.assistant_pending ?? {}) }
  for (const id of Object.keys(stored)) delete pending[id]
  await (admin as any).from('memo_agent_jobs').update({
    payload: { ...payload, assistant_answers: { ...(payload.assistant_answers ?? {}), ...stored }, assistant_pending: pending },
  }).eq('id', job.id)

  // Answers to only some of the calls: the rest are still listed, and the stage cannot move yet.
  if (Object.keys(pending).length > 0) {
    return {
      accepted: Object.keys(stored).length, state: 'waiting', job: { id: job.id, kind: job.kind }, completed: [],
      calls: [], next: `Saved. Still waiting on ${Object.keys(pending).join(', ')}; answer those, then submit them.`,
    }
  }
  return { accepted: Object.keys(stored).length, ...(await advanceAssistantJobs(admin, fundId, job.deal_id)) }
}
