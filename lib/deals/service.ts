// Inbound deal writes, shared by the web routes (app/api/deals/**) and the agent tools
// (lib/agent/deals-tools.ts), so a deal created or moved from chat goes through exactly the checks
// and steps one made on the Deals page does.
//
// The caller has already decided the person may write deal flow (the route gate, or the tool's
// domain). What is checked here is which DEAL and which ENTITY: a member may only put a deal on one
// of their own entities, and an entity must belong to the fund.

import crypto from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AccessContext } from '@/lib/access/effective'
import { dealEntityProblem } from '@/lib/access/scope'
import { getFeatureProvider } from '@/lib/ai/feature-provider'
import { extractAttachmentText, type PostmarkPayload } from '@/lib/parsing/extractAttachmentText'
import { processDeal } from '@/lib/pipeline/processDeal'
import type { PostmarkPayload as PipelinePayload } from '@/lib/pipeline/processEmail'
import { scanFileAsync } from '@/lib/security/scan-file'
import { STATUS_OPTIONS, type DealStatus } from './statuses'
import {
  MAX_NAME_LEN, MAX_EMAIL_LEN, MAX_URL_LEN, MAX_PITCH_LEN,
  EMAIL_RE, safeWebUrl, sanitizeFilename, validateAttachmentType,
} from './submission-validation'
import { dbFail, done, fail, type Outcome } from '@/lib/service-outcome'

export const MAX_DEAL_FILE_BYTES = 10 * 1024 * 1024
export const MAX_DEAL_FILES = 10

/**
 * Whether this caller may put a deal on this entity: a member must name one of theirs (an
 * unassigned deal is admins-only, so they would lose sight of it), and it must be the fund's.
 */
export async function checkDealEntity(
  admin: SupabaseClient, access: AccessContext, vehicleId: string | null,
): Promise<Outcome<null>> {
  const problem = dealEntityProblem(access, vehicleId)
  if (problem) return fail(403, problem)
  if (vehicleId) {
    const { data: v } = await (admin as any).from('fund_vehicles').select('id').eq('fund_id', access.fundId).eq('id', vehicleId).maybeSingle()
    if (!v) return fail(404, 'Entity not found')
  }
  return done(null)
}

export interface ManualDealInput {
  companyName: string
  founderName: string
  founderEmail: string
  companyUrl?: string
  introSource?: string
  referrerName?: string
  referrerEmail?: string
  pitch: string
  vehicleId: string | null
  files: { name: string; type: string; bytes: Buffer }[]
}

/**
 * A deal someone enters by hand (the New deal form, or `deals_create_inbound` from chat). It is
 * composed into a synthetic email and run through the same analyzer as an emailed pitch, so it
 * lands on the Deals page scored against the thesis exactly like one.
 */
export async function createManualDeal(
  admin: SupabaseClient,
  ctx: { fundId: string; userId: string; userEmail?: string | null; access: AccessContext },
  input: ManualDealInput,
): Promise<Outcome<{ emailId: string; dealId: string | null }>> {
  const { fundId } = ctx
  const entity = await checkDealEntity(admin, ctx.access, input.vehicleId)
  if (!entity.ok) return entity

  const companyName = input.companyName.trim().slice(0, MAX_NAME_LEN)
  const founderName = input.founderName.trim().slice(0, MAX_NAME_LEN)
  const founderEmail = input.founderEmail.trim().toLowerCase().slice(0, MAX_EMAIL_LEN)
  const rawCompanyUrl = (input.companyUrl ?? '').trim().slice(0, MAX_URL_LEN)
  const introSource = (input.introSource ?? '').trim().slice(0, MAX_NAME_LEN)
  const referrerName = (input.referrerName ?? '').trim().slice(0, MAX_NAME_LEN)
  const referrerEmail = (input.referrerEmail ?? '').trim().slice(0, MAX_EMAIL_LEN)
  const pitch = input.pitch.trim().slice(0, MAX_PITCH_LEN)

  if (!companyName || !founderName || !founderEmail || !pitch) {
    return fail(400, 'company_name, founder_name, founder_email, and pitch are required')
  }
  if (!EMAIL_RE.test(founderEmail)) return fail(400, 'Invalid founder email')
  if (referrerEmail && !EMAIL_RE.test(referrerEmail)) return fail(400, 'Invalid referrer email')

  // Only http(s), so a `javascript:` URL is never stored to render later as an <a href>.
  let companyUrl = ''
  if (rawCompanyUrl) {
    const normalized = safeWebUrl(rawCompanyUrl)
    if (!normalized) return fail(400, 'company_url must be a valid http(s) URL')
    companyUrl = normalized
  }

  if (input.files.length > MAX_DEAL_FILES) return fail(400, `At most ${MAX_DEAL_FILES} files per submission`)
  const files: { name: string; type: string; bytes: Buffer }[] = []
  for (const f of input.files) {
    if (f.bytes.length > MAX_DEAL_FILE_BYTES) return fail(400, `${f.name} exceeds ${MAX_DEAL_FILE_BYTES / (1024 * 1024)}MB`)
    const name = sanitizeFilename(f.name || 'untitled')
    const type = f.type || 'application/octet-stream'
    const typeErr = validateAttachmentType(name, type)
    if (typeErr) return fail(400, `${f.name}: ${typeErr.message}`)
    // Scanned before anything is stored, as every inbound file is.
    const scan = await scanFileAsync(f.bytes, name, type)
    if (!scan.safe) return fail(400, `${name} could not be accepted.`)
    files.push({ name, type, bytes: f.bytes })
  }

  // The analyzer sees the full context a partner would have put in an email.
  const subject = `Manual entry: ${companyName}`
  const composedBody = ([
    `Founder: ${founderName} <${founderEmail}>`,
    companyUrl ? `Website: ${companyUrl}` : null,
    introSource ? `Intro source: ${introSource.replace(/_/g, ' ')}` : null,
    referrerName ? `Referrer: ${referrerName}${referrerEmail ? ` <${referrerEmail}>` : ''}` : null,
    '',
    pitch,
  ].filter(v => v !== null) as string[]).join('\n')

  const attachments = files.map(f => ({ Name: f.name, ContentType: f.type, Content: f.bytes.toString('base64'), ContentLength: f.bytes.length }))
  const payload: PostmarkPayload & { From: string; To: string; FromFull: { Email: string; Name: string }; Subject: string; MessageID: string } = {
    From: founderEmail,
    To: 'manual-entry@hemrock.local',
    FromFull: { Email: founderEmail, Name: founderName },
    Subject: subject,
    TextBody: composedBody,
    HtmlBody: '',
    MessageID: `<manual-${crypto.randomUUID()}@hemrock.local>`,
    Attachments: attachments,
  }

  const db = admin as any
  const { data: emailInsert, error: emailErr } = await db
    .from('inbound_emails')
    .insert({
      fund_id: fundId,
      from_address: founderEmail,
      subject,
      received_at: new Date().toISOString(),
      raw_payload: stripAttachmentContent(payload),
      processing_status: 'processing',
      attachments_count: attachments.length,
      routing_label: 'deals',
      routing_confidence: 1.0,
      routing_reasoning: `Manual entry by ${ctx.userEmail ?? ctx.userId}`,
      routing_secondary_label: null,
      routed_to: 'deals',
    })
    .select('id')
    .single()
  if (emailErr || !emailInsert) {
    console.error('[deals/manual] inbound_emails insert failed:', emailErr)
    return fail(500, 'Failed to create deal')
  }
  const emailId = (emailInsert as { id: string }).id

  // Stored, and the row rewritten to point at storage rather than carry the bytes.
  if (attachments.length > 0) {
    const stored: Array<{ Name: string; ContentType: string; ContentLength: number; StoragePath: string }> = []
    for (let i = 0; i < files.length; i++) {
      const f = files[i]
      const storagePath = `${emailId}/${i}_${f.name}`
      const { error: uploadErr } = await db.storage.from('email-attachments').upload(storagePath, f.bytes, { contentType: f.type, upsert: true })
      if (!uploadErr) stored.push({ Name: f.name, ContentType: f.type, ContentLength: f.bytes.length, StoragePath: storagePath })
    }
    if (stored.length > 0) {
      await db.from('inbound_emails').update({ raw_payload: { ...stripAttachmentContent(payload), Attachments: stored } }).eq('id', emailId)
    }
  }

  // On failure the email row is marked failed, and its id still returned so it can be retried.
  let dealId: string | null = null
  try {
    const { provider, model, providerType } = await getFeatureProvider(admin, fundId, 'deal_analysis')
    const extracted = await extractAttachmentText(payload)
    const result = await processDeal({
      supabase: admin as any, emailId, fundId, payload: payload as PipelinePayload, extracted, provider, providerType, model,
    })
    dealId = (result as any)?.dealId ?? null
    // The owning entity the submitter chose; the analyzer does not know it.
    if (dealId && input.vehicleId) {
      await db.from('inbound_deals').update({ vehicle_id: input.vehicleId }).eq('id', dealId).eq('fund_id', fundId)
    }
    await db.from('inbound_emails').update({ processing_status: 'success' }).eq('id', emailId)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    console.error('[deals/manual] processDeal failed:', msg)
    await db.from('inbound_emails').update({ processing_status: 'failed', processing_error: msg }).eq('id', emailId)
    return fail(500, msg, { email_id: emailId })
  }

  if (!dealId) {
    const { data: deal } = await db.from('inbound_deals').select('id').eq('email_id', emailId).eq('fund_id', fundId).maybeSingle()
    dealId = (deal as any)?.id ?? null
  }
  return done({ emailId, dealId })
}

function stripAttachmentContent(payload: any) {
  if (!payload.Attachments) return payload
  return { ...payload, Attachments: payload.Attachments.map(({ Content: _c, ...rest }: any) => rest) }
}

export interface InboundDealChanges {
  status?: unknown
  /** undefined: unchanged. null: unassigned (admins only). */
  vehicleId?: string | null
  /** A member's user id; null clears it. */
  assignedTo?: string | null
}

/** Move an inbound deal: its pipeline status, its owning entity, who it is assigned to. */
export async function updateInboundDeal(
  admin: SupabaseClient, access: AccessContext, dealId: string, changes: InboundDealChanges,
): Promise<Outcome<{ updated: string[] }>> {
  const updates: Record<string, unknown> = {}
  if (typeof changes.status === 'string') {
    if (!STATUS_OPTIONS.includes(changes.status as DealStatus)) return fail(400, 'Invalid status')
    updates.status = changes.status
  }
  // The gate confirmed the caller can see this deal; the new entity must be theirs too.
  if (changes.vehicleId !== undefined) {
    const entity = await checkDealEntity(admin, access, changes.vehicleId)
    if (!entity.ok) return entity
    updates.vehicle_id = changes.vehicleId
  }
  if (changes.assignedTo !== undefined) updates.assigned_to = changes.assignedTo
  if (Object.keys(updates).length === 0) return fail(400, 'Nothing to update')

  const updated = Object.keys(updates)
  updates.updated_at = new Date().toISOString()
  const { error } = await (admin as any).from('inbound_deals').update(updates).eq('id', dealId).eq('fund_id', access.fundId)
  if (error) return dbFail(error, 'deals-id')
  return done({ updated })
}

/**
 * Queue external web research for one inbound deal. Automatic research only runs for deals over
 * the fund's interest bar; asking for it is a deliberate decision to spend, so it skips that bar,
 * but not the fund's switch.
 */
export async function queueDealResearch(
  admin: SupabaseClient, fundId: string, dealId: string,
): Promise<Outcome<{ queued: true; already?: true; research_status: string }>> {
  const db = admin as any
  const { data: settings } = await db.from('fund_settings').select('deal_research_enabled').eq('fund_id', fundId).maybeSingle()
  if (!(settings as any)?.deal_research_enabled) {
    return fail(400, 'External deal research is turned off for this fund. Enable it in Settings → Deals.')
  }
  const { data: deal } = await db.from('inbound_deals').select('id, research_status').eq('id', dealId).eq('fund_id', fundId).maybeSingle()
  if (!deal) return fail(404, 'Not found')
  const status = (deal as any).research_status as string | null
  if (status === 'pending' || status === 'running') return done({ queued: true, already: true, research_status: status })

  const { error } = await db.from('inbound_deals').update({ research_status: 'pending', research_error: null }).eq('id', dealId).eq('fund_id', fundId)
  if (error) return dbFail(error, 'deals-id-research')
  // The cron picks it up; research is not latency-sensitive the way an interactive stage is.
  return done({ queued: true, research_status: 'pending' })
}

/**
 * Promote an inbound deal into diligence: a deal room pre-filled from it, linked both ways, and the
 * inbound deal moved to `diligence`. A deal already promoted is refused with the existing room's id.
 */
export async function promoteInboundDeal(
  admin: SupabaseClient, ctx: { fundId: string; userId: string }, dealId: string,
): Promise<Outcome<{ diligenceId: string }>> {
  const { fundId } = ctx
  const db = admin as any
  const { data: deal } = await db
    .from('inbound_deals')
    .select('id, fund_id, vehicle_id, company_name, stage, industry, founder_name, intro_source, referrer_name, promoted_diligence_id')
    .eq('id', dealId)
    .eq('fund_id', fundId)
    .maybeSingle()
  if (!deal) return fail(404, 'Not found')
  const d = deal as any
  if (d.promoted_diligence_id) {
    return fail(409, 'This deal already has a Diligence record.', { diligence_id: d.promoted_diligence_id })
  }

  const { data: created, error: createErr } = await db
    .from('diligence_deals')
    .insert({
      fund_id: fundId,
      // The same entity as the deal it came from, so whoever could see the deal sees its room.
      vehicle_id: d.vehicle_id ?? null,
      name: d.company_name ?? 'Untitled deal',
      sector: d.industry ?? null,
      stage_at_consideration: d.stage ?? null,
      deal_status: 'active',
      current_memo_stage: 'not_started',
      created_by: ctx.userId,
      notes_summary: buildNotesSummary(d.intro_source, d.referrer_name, d.founder_name),
    })
    .select('id')
    .single()
  if (createErr || !created) return fail(500, createErr?.message ?? 'Failed to create diligence record')
  const diligenceId = (created as { id: string }).id

  await db
    .from('inbound_deals')
    .update({ promoted_diligence_id: diligenceId, status: 'diligence', updated_at: new Date().toISOString() })
    .eq('id', dealId)
    .eq('fund_id', fundId)
  return done({ diligenceId })
}

function buildNotesSummary(introSource: string | null, referrerName: string | null, founderName: string | null): string | null {
  const parts: string[] = []
  if (founderName) parts.push(`Founder: ${founderName}`)
  if (introSource) parts.push(`Intro: ${introSource.replace(/_/g, ' ')}${referrerName ? ` via ${referrerName}` : ''}`)
  parts.push('Promoted from inbound Deals.')
  return parts.join(' · ')
}
