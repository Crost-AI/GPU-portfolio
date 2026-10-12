/**
 * A portfolio company's update handed to the app from chat (the `submit_company_update` tool): the
 * text of a quarterly letter, a board deck, a KPI sheet. It goes through exactly the pipeline an
 * emailed update does (lib/pipeline/processEmail.ts), so it is matched to a company, kept on the
 * company's Updates, its KPIs extracted into metric values, and anything uncertain (a low-confidence
 * figure, an ambiguous period, an unknown company) parked in the review queue for a person.
 *
 * The pipeline is keyed to an `inbound_emails` row, so this writes one, the way the manual deal form
 * does (app/api/deals/manual): routed to reporting, from the person who submitted it, with the files
 * scanned and stored as attachments. It then shows on the Emails page beside mailed updates, where it
 * can be reprocessed or rerouted like any other.
 *
 * From a connected chat the call is staged, and runs when someone approves it (lib/agent/dispatch.ts).
 */
import crypto from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AccessContext } from '@/lib/access/effective'
import { scanFileAsync } from '@/lib/security/scan-file'
import { runPipeline, type PostmarkPayload } from '@/lib/pipeline/processEmail'
import { sanitizeFilename, fileExt } from '@/lib/deals/submission-validation'

/** Inline files stay well under the serverless request-body limit once base64-encoded. */
export const MAX_UPDATE_FILE_BYTES = 3 * 1024 * 1024
export const MAX_UPDATE_FILES = 5
export const MAX_UPDATE_TEXT = 100_000

const TYPE_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv',
  txt: 'text/plain',
  md: 'text/markdown',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
}

export interface UpdateFileInput { filename?: unknown; content_base64?: unknown }

export interface SubmitUpdateInput {
  /** Company id or name. Omitted: the pipeline identifies it, as it does for an email. */
  company?: unknown
  subject?: unknown
  /** The update's text, as the assistant has it. */
  text?: unknown
  files?: unknown
}

export interface SubmitUpdateResult {
  emailId: string
  status: string
  company: { id: string; name: string } | null
  metricsRecorded: { metric: string; period: string; value: number | string | null }[]
  needsReview: { issue: string; detail: string | null }[]
  warnings: string[]
  url: string
}

interface Deps {
  admin: SupabaseClient
  fundId: string
  userId: string | null
  access: AccessContext
  origin?: string
  /** Resolves a company the caller may see (lib/agent/portfolio-tools.ts resolveCompany). */
  resolveCompany: (ref: string) => Promise<{ id: string; name: string }>
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

/** Validates the files before anything is written: names, types, sizes. Throws a user-worded error. */
export function parseUpdateFiles(files: unknown): { name: string; type: string; bytes: Buffer }[] {
  if (files == null) return []
  if (!Array.isArray(files)) throw new Error('files must be a list of { filename, content_base64 }.')
  if (files.length > MAX_UPDATE_FILES) throw new Error(`At most ${MAX_UPDATE_FILES} files per update.`)
  return files.map((f: UpdateFileInput, i) => {
    const name = sanitizeFilename(str(f?.filename, 200) || `file-${i + 1}`)
    const type = TYPE_BY_EXT[fileExt(name)]
    if (!type) throw new Error(`${name}: send a PDF, Word, Excel, PowerPoint, CSV, text or image file.`)
    const b64 = typeof f?.content_base64 === 'string' ? f.content_base64.replace(/^data:[^,]*,/, '').replace(/\s+/g, '') : ''
    if (!b64) throw new Error(`${name}: content_base64 is empty.`)
    const bytes = Buffer.from(b64, 'base64')
    if (bytes.length === 0) throw new Error(`${name}: content_base64 is not valid base64.`)
    if (bytes.length > MAX_UPDATE_FILE_BYTES) {
      throw new Error(`${name} is over ${MAX_UPDATE_FILE_BYTES / (1024 * 1024)} MB. Send the text instead, or email the file to the fund's inbound address.`)
    }
    return { name, type, bytes }
  })
}

export async function submitCompanyUpdate(deps: Deps, input: SubmitUpdateInput): Promise<SubmitUpdateResult> {
  const { admin, fundId, userId } = deps
  const text = str(input.text, MAX_UPDATE_TEXT)
  const files = parseUpdateFiles(input.files)
  if (!text && files.length === 0) throw new Error('Send the update as text, as files, or both.')

  const companyRef = str(input.company, 200)
  const company = companyRef ? await deps.resolveCompany(companyRef) : null
  const subject = str(input.subject, 300) || (company ? `Update: ${company.name}` : 'Company update')

  let fromAddress = 'chat@hemrock.local'
  if (userId) {
    const { data } = await (admin as any).auth.admin.getUserById(userId)
    if (data?.user?.email) fromAddress = data.user.email
  }

  const db = admin as any
  const { data: row, error } = await db.from('inbound_emails').insert({
    fund_id: fundId,
    from_address: fromAddress,
    subject,
    received_at: new Date().toISOString(),
    raw_payload: { From: fromAddress, Subject: subject, TextBody: text, Attachments: [] },
    processing_status: 'processing',
    attachments_count: files.length,
    routing_label: 'reporting',
    routing_confidence: 1.0,
    routing_reasoning: 'Submitted from a connected chat',
    routed_to: 'reporting',
    company_id: company?.id ?? null,
  }).select('id').single()
  if (error || !row) throw new Error('Could not record the update.')
  const emailId = row.id as string

  // Scanned before stored, like every inbound file. An unsafe file is recorded as a failed
  // attachment and never reaches the pipeline, so the update shows what was refused and why.
  const stored: NonNullable<PostmarkPayload['Attachments']> = []
  const forPipeline: NonNullable<PostmarkPayload['Attachments']> = []
  const warnings: string[] = []
  for (let i = 0; i < files.length; i++) {
    const f = files[i]
    const scan = await scanFileAsync(f.bytes, f.name, f.type)
    if (!scan.safe) {
      const failed = { Name: f.name, ContentType: f.type, ContentLength: f.bytes.length, ContentError: `Safety scan failed: ${scan.reason ?? 'unknown reason'}` }
      stored.push(failed)
      forPipeline.push(failed)
      warnings.push(`${f.name} was refused: ${scan.reason ?? 'failed the safety scan'}.`)
      continue
    }
    const storagePath = `${emailId}/${i}_${f.name}`
    const { error: upErr } = await db.storage.from('email-attachments').upload(storagePath, f.bytes, { contentType: f.type, upsert: true })
    const content = f.bytes.toString('base64')
    stored.push(upErr
      ? { Name: f.name, ContentType: f.type, ContentLength: f.bytes.length, Content: content }
      : { Name: f.name, ContentType: f.type, ContentLength: f.bytes.length, StoragePath: storagePath })
    forPipeline.push({ Name: f.name, ContentType: f.type, ContentLength: f.bytes.length, Content: content })
  }

  const messageId = `<chat-${crypto.randomUUID()}@hemrock.local>`
  const base = { From: fromAddress, To: 'chat@hemrock.local', Subject: subject, TextBody: text, HtmlBody: '', MessageID: messageId }
  await db.from('inbound_emails').update({ raw_payload: { ...base, Attachments: stored } }).eq('id', emailId)

  try {
    await runPipeline(admin as any, emailId, fundId, { ...base, Attachments: forPipeline } as PostmarkPayload, userId ? { userId } : null, { forcedRoute: 'reporting' })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.error('[submit_company_update] pipeline failed:', e)
    await db.from('inbound_emails').update({ processing_status: 'failed', processing_error: message.slice(0, 500) }).eq('id', emailId)
    warnings.push('Processing failed. It is saved on the Emails page, where it can be reprocessed.')
  }

  return { ...(await outcome(admin, emailId)), warnings: [...warnings, ...(await pipelineWarnings(admin, emailId))], url: `${(deps.origin ?? '').replace(/\/$/, '')}/emails/${emailId}` }
}

/** What the pipeline did with it, read back from what it wrote. */
async function outcome(admin: SupabaseClient, emailId: string) {
  const db = admin as any
  const [{ data: email }, { data: values }, { data: reviews }] = await Promise.all([
    db.from('inbound_emails').select('processing_status, company_id, companies(id, name)').eq('id', emailId).maybeSingle(),
    db.from('metric_values').select('period_label, value_number, value_text, metrics(name)').eq('source_email_id', emailId),
    db.from('parsing_reviews').select('issue_type, context_snippet').eq('email_id', emailId),
  ])
  const c = Array.isArray(email?.companies) ? email.companies[0] : email?.companies
  return {
    emailId,
    status: (email?.processing_status as string) ?? 'unknown',
    company: c ? { id: c.id as string, name: c.name as string } : null,
    metricsRecorded: ((values ?? []) as any[]).map(v => ({
      metric: (Array.isArray(v.metrics) ? v.metrics[0]?.name : v.metrics?.name) ?? 'Metric',
      period: v.period_label as string,
      value: v.value_number ?? v.value_text ?? null,
    })),
    needsReview: ((reviews ?? []) as any[]).map(r => ({ issue: String(r.issue_type).replace(/_/g, ' '), detail: (r.context_snippet as string | null)?.slice(0, 300) ?? null })),
  }
}

async function pipelineWarnings(admin: SupabaseClient, emailId: string): Promise<string[]> {
  const { data } = await (admin as any).from('inbound_emails').select('processing_error').eq('id', emailId).maybeSingle()
  return data?.processing_error ? [String(data.processing_error)] : []
}
