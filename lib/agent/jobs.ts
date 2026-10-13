// Long-running work started from a chat or a script, and how to follow it.
//
// Some things outlast a tool call: the memo agent, external deal research, a company update whose
// files take a while to read. The tool that starts one returns a job handle, and a status tool in
// the same area (so with the same access) reports on it. The id carries its kind, so a handle can
// be read back without the assistant having to remember which tool made it.

export const JOB_KINDS = {
  diligence: 'diligence_job_status',
  deal_research: 'deals_research_status',
  company_update: 'company_update_status',
} as const
export type JobKind = keyof typeof JOB_KINDS

export type JobState = 'queued' | 'running' | 'done' | 'failed'

export interface JobHandle {
  id: string
  kind: JobKind
  status: JobState
  check_with: string
  next: string
}

/** The four states every job reads as, whatever its own table calls them. */
export function jobState(raw: string | null | undefined): JobState {
  switch (raw) {
    case 'pending': case 'queued': return 'queued'
    case 'running': case 'processing': case 'generating': return 'running'
    case 'failed': case 'error': case 'cancelled': return 'failed'
    default: return 'done'
  }
}

export function jobHandle(kind: JobKind, id: string, rawStatus: string | null | undefined): JobHandle {
  const status = jobState(rawStatus)
  const tool = JOB_KINDS[kind]
  return {
    id: `${kind}:${id}`, kind, status, check_with: tool,
    next: status === 'queued' || status === 'running'
      ? `It runs in the background. Tell the user it has started; call ${tool} with this job_id when they ask, or once after a minute. Don't poll in a loop.`
      : `Finished. ${tool} with this job_id shows the result.`,
  }
}

/** The record id inside a job id, refusing one of another kind. Bare ids are taken as this kind. */
export function jobRecordId(kind: JobKind, jobId: unknown): string {
  const s = String(jobId ?? '').trim()
  if (!s) throw new Error('job_id is required.')
  const i = s.indexOf(':')
  if (i === -1) return s
  const k = s.slice(0, i)
  if (k !== kind) throw new Error(`That is a ${k} job; check it with ${(JOB_KINDS as Record<string, string>)[k] ?? 'its own status tool'}.`)
  return s.slice(i + 1)
}
