// Resolving one item in the review queue (parsing_reviews): accept it, reject it, or correct it.
//
// Shared by the review page's route (app/api/review/[id]/resolve) and the agent's resolve_review
// tool, so a figure the pipeline was unsure of can be cleared from chat by the same rules that
// clear it in the app. Each door loads the review its own way: the route through the caller's
// RLS-scoped client, the tool with the service role and the caller's entity scope
// (loadReviewForAccess). What happens next is this function's alone.

import type { SupabaseClient } from '@supabase/supabase-js'
import { expireTag } from '@/lib/cache/tags'
import { parseValue } from '@/lib/pipeline/processEmail'
import type { ParsingReview, Metric } from '@/lib/types/database'
import type { ExtractMetricsResult } from '@/lib/claude/extractMetrics'
import { logActivity } from '@/lib/activity'
import { hasAccess, type AccessContext } from '@/lib/access/effective'
import { approveFundReview, type FundApproval } from '@/lib/portfolio/fof-reviews'
import { isFundReviewType, scopeFundReviews } from '@/lib/portfolio/fof-review-types'
import { visibleCompanyIds } from '@/lib/access/scope'
import { dbFail, done, fail, type Outcome } from '@/lib/service-outcome'

export type ReviewRow = Pick<
  ParsingReview,
  | 'id'
  | 'fund_id'
  | 'email_id'
  | 'metric_id'
  | 'company_id'
  | 'issue_type'
  | 'extracted_value'
  | 'resolution'
  | 'vehicle_id'
  | 'payload'
>

export const REVIEW_COLUMNS = 'id, fund_id, email_id, metric_id, company_id, issue_type, extracted_value, resolution, vehicle_id, payload'

export const REVIEW_RESOLUTIONS = ['accepted', 'rejected', 'manually_corrected'] as const

export interface ResolveReviewInput {
  resolution: string
  resolved_value?: string
  /** Fund reviews: the entity, when the review names none. */
  vehicleId?: string
  /** Fund reviews: the approver's corrections to the proposal (fof-review-types.ts applyEdits). */
  edits?: Record<string, unknown>
}

export interface ResolveReviewCaller {
  fundId: string
  userId: string
  /** Loaded only when the review is a fund-holding proposal; pass it if you already hold it. */
  loadAccess: () => Promise<AccessContext>
}

/**
 * A review as this caller may see it, read with the service role: in their fund, about a company
 * of their entities (or none), and a fund-holding proposal only for an entity of theirs and only
 * with the investments feature. The same rules the review page's RLS-scoped read applies.
 */
export async function loadReviewForAccess(
  admin: SupabaseClient,
  access: AccessContext,
  reviewId: string,
): Promise<ReviewRow | null> {
  const { data, error } = await (admin as any)
    .from('parsing_reviews')
    .select(REVIEW_COLUMNS)
    .eq('id', reviewId)
    .eq('fund_id', access.fundId)
    .maybeSingle()
  if (error) throw new Error(`parsing_reviews read failed: ${error.message}`)
  const review = data as ReviewRow | null
  if (!review) return null
  const visible = await visibleCompanyIds(admin, access)
  // A scoped caller sees only reviews about one of their companies (the page's filterByCompany).
  if (visible !== null && (!review.company_id || !visible.includes(review.company_id))) return null
  if (scopeFundReviews([review], access).length === 0) return null
  if (isFundReviewType(review.issue_type) && !hasAccess(access, 'portfolio', 'read', 'investments')) return null
  return review
}

export interface ResolveReviewResult {
  ok: true
  message?: string
  booking?: unknown
  eventId?: string | null
  later?: unknown
  warning?: string
}

export async function resolveReview(
  admin: SupabaseClient,
  caller: ResolveReviewCaller,
  review: ReviewRow,
  body: ResolveReviewInput,
): Promise<Outcome<ResolveReviewResult>> {
  const { resolution, resolved_value } = body

  if (!(REVIEW_RESOLUTIONS as readonly string[]).includes(resolution)) {
    return fail(400, 'Invalid resolution')
  }
  if (resolution === 'manually_corrected' && !resolved_value?.trim()) {
    return fail(400, 'resolved_value is required for manually_corrected')
  }
  if (review.resolution) return fail(409, 'Already resolved')

  // A FUND-HOLDING proposal (lib/portfolio/fof-email.ts) is one entity's: a member may resolve it —
  // approve or dismiss — only for an entity of theirs, and one naming no entity is for unscoped
  // callers to assign. The same rule RLS applies, said here because what follows uses the admin client.
  const isFund = isFundReviewType(review.issue_type)
  const access = isFund ? await caller.loadAccess() : null
  if (access && scopeFundReviews([review], access).length === 0) {
    return fail(404, 'Not found')
  }
  // The route is gated on portfolio alone; a fund review writes the fund register, which is the
  // investments feature's (the fund-holding routes' gate). Say that gate here.
  if (access && !hasAccess(access, 'portfolio', 'write', 'investments')) {
    return fail(403, 'You do not have access to fund holdings.')
  }
  // A fund proposal is corrected field by field on its review card (`edits`). The generic
  // "Edit & Accept" sends one free-text value, which would approve the UNCORRECTED proposal.
  if (isFund && resolution === 'manually_corrected') {
    return fail(400, 'Correct it on the review card.')
  }
  const corrected = isFund && resolution !== 'rejected' && !!body.edits && Object.keys(body.edits).length > 0
  const validResolution = (corrected ? 'manually_corrected' : resolution) as 'accepted' | 'rejected' | 'manually_corrected'

  // CLAIM the review before writing anything: only the request that moves it from open to resolved
  // goes on, so a double-click or a second tab cannot save the NAV or draft the notice twice.
  const { data: claimed, error: claimError } = await (admin as any)
    .from('parsing_reviews')
    .update({
      resolution: validResolution,
      resolved_value: corrected ? JSON.stringify(body.edits) : resolved_value ?? null,
      resolved_at: new Date().toISOString(),
    })
    .eq('id', review.id)
    .eq('fund_id', caller.fundId)
    .is('resolution', null)
    .select('id')
  if (claimError) return dbFail(claimError, 'review-id-resolve')
  if (!claimed || claimed.length === 0) return fail(409, 'Already resolved')

  // Approving a fund proposal writes the register row it proposes — a NAV statement, which books its
  // mark, or a draft notice. Dismissing writes nothing. A refusal reopens the review.
  let fund: Extract<FundApproval, { ok: true }> | null = null
  let vehicleWarning: string | null = null
  if (isFund && access && resolution !== 'rejected') {
    let approved: FundApproval
    try {
      approved = await approveFundReview(admin as any, { fundId: caller.fundId, userId: caller.userId, access }, review, {
        vehicleId: body.vehicleId, edits: body.edits,
      })
    } catch (e) {
      // A throw may follow a committed write (the NAV or notice saved, then something after it failed),
      // so the review stays resolved rather than inviting a second save.
      console.error('[review-id-resolve] fund approval failed:', e)
      return fail(500, 'Something went wrong while saving this proposal, and it may have been saved. '
        + 'Check the holding\'s statements and notices before entering it again.')
    }
    if (!approved.ok) {
      // A clean refusal wrote nothing: reopen the review so it can be corrected and approved.
      const { error: reopenError } = await (admin as any)
        .from('parsing_reviews')
        .update({ resolution: null, resolved_value: null, resolved_at: null })
        .eq('id', review.id)
        .eq('fund_id', caller.fundId)
      if (reopenError) {
        console.error('[review-id-resolve] could not reopen review:', reopenError.message)
        return fail(approved.status, `${approved.error} Nothing was saved, but the review could not be reopened — reload and try again.`)
      }
      return fail(approved.status, approved.error)
    }
    fund = approved
    const { error: vehicleError } = await (admin as any)
      .from('parsing_reviews')
      .update({ vehicle_id: fund.vehicleId })
      .eq('id', review.id)
      .eq('fund_id', caller.fundId)
    if (vehicleError) {
      // The register row is written; only the review's record of its entity is missing.
      console.error('[review-id-resolve] could not record the review\'s entity:', vehicleError.message)
      vehicleWarning = 'Saved, but the review could not record which entity it was approved for.'
    }
  }

  // Write to metric_values for issue types where the pipeline skipped writing.
  // low_confidence: value was already written → only write if manually_corrected.
  // duplicate_period, ambiguous_period: nothing was written → write on accept/manually_corrected.
  const writableOnAccept = ['duplicate_period', 'ambiguous_period']
  const shouldWrite =
    (resolution === 'accepted' && writableOnAccept.includes(review.issue_type)) ||
    (resolution === 'manually_corrected' && !!review.metric_id && !!review.company_id)

  const valueToWrite =
    resolution === 'manually_corrected' ? resolved_value! : review.extracted_value

  if (!isFund && shouldWrite && review.metric_id && review.company_id && valueToWrite) {
    // Get period info from the email's stored Claude response
    const { data: emailData } = await (admin as any)
      .from('inbound_emails')
      .select('claude_response')
      .eq('id', review.email_id)
      .single()

    const claudeResponse = (emailData as unknown as { claude_response: ExtractMetricsResult | null })?.claude_response
    const period = claudeResponse?.reporting_period

    if (period) {
      const { data: metricData } = await (admin as any)
        .from('metrics')
        .select('value_type')
        .eq('id', review.metric_id)
        .single()

      const valueType = (metricData as unknown as Pick<Metric, 'value_type'> | null)?.value_type ?? 'number'
      const valueFields = parseValue(valueToWrite, valueType)

      // Check for existing row (unique index uses coalesce, so we query manually)
      let existingQuery = (admin as any)
        .from('metric_values')
        .select('id')
        .eq('metric_id', review.metric_id)
        .eq('period_year', period.year)

      existingQuery =
        period.quarter != null
          ? existingQuery.eq('period_quarter', period.quarter)
          : existingQuery.is('period_quarter', null)

      existingQuery =
        period.month != null
          ? existingQuery.eq('period_month', period.month)
          : existingQuery.is('period_month', null)

      const { data: existing } = await existingQuery.maybeSingle()
      const existingRow = existing as unknown as { id: string } | null

      if (existingRow) {
        await (admin as any)
          .from('metric_values')
          .update({
            ...valueFields,
            confidence: 'high',
            is_manually_entered: resolution === 'manually_corrected',
            notes:
              resolution === 'manually_corrected'
                ? 'Manually corrected via review queue'
                : null,
          })
          .eq('id', existingRow.id)
      } else {
        await (admin as any).from('metric_values').insert({
          metric_id: review.metric_id,
          company_id: review.company_id,
          fund_id: review.fund_id,
          period_label: period.label,
          period_year: period.year,
          period_quarter: period.quarter ?? null,
          period_month: period.month ?? null,
          confidence: 'high',
          source_email_id: review.email_id,
          is_manually_entered: resolution === 'manually_corrected',
          notes:
            resolution === 'manually_corrected'
              ? 'Manually corrected via review queue'
              : null,
          ...valueFields,
        })
      }
    }
  }

  // If fund prefers not to retain resolved reviews, delete immediately
  const { data: settingsData } = await (admin as any)
    .from('fund_settings')
    .select('retain_resolved_reviews')
    .eq('fund_id', caller.fundId)
    .maybeSingle()

  const settings = settingsData as unknown as { retain_resolved_reviews: boolean } | null
  if (settings && !settings.retain_resolved_reviews) {
    await (admin as any).from('parsing_reviews').delete().eq('id', review.id)
  }

  // Check if all review items for this email are now resolved — if so, promote email to 'success'
  const { count: unresolvedCount } = await (admin as any)
    .from('parsing_reviews')
    .select('id', { count: 'exact', head: true })
    .eq('email_id', review.email_id)
    .is('resolution', null)

  if (unresolvedCount === 0) {
    await (admin as any)
      .from('inbound_emails')
      .update({ processing_status: 'success' })
      .eq('id', review.email_id)
      .eq('processing_status', 'needs_review')
  }

  logActivity(admin as any, review.fund_id, caller.userId, 'review.resolve', { reviewId: review.id, resolution })

  expireTag('review-badge')

  return done({
    ok: true,
    ...(fund ? {
      message: fund.message, booking: fund.booking ?? null, eventId: fund.eventId ?? null,
      ...(fund.later ? { later: fund.later } : {}),
      ...(vehicleWarning ? { warning: vehicleWarning } : {}),
    } : {}),
  })
}

/**
 * The open review queue as this caller may see it, for the agent: the same items the review page
 * lists, read with the service role and narrowed to the caller's companies and entities.
 */
export async function loadReviewQueue(admin: SupabaseClient, access: AccessContext, opts: { limit?: number } = {}) {
  const visible = await visibleCompanyIds(admin, access)
  if (visible !== null && visible.length === 0) return { total: 0, counts: {}, items: [], needsReviewEmails: [] }
  let q = (admin as any)
    .from('parsing_reviews')
    .select(`
      id, issue_type, extracted_value, context_snippet, created_at, payload, vehicle_id, company_id,
      companies ( id, name ),
      metrics ( id, name, unit, value_type ),
      inbound_emails ( id, subject, received_at, from_address ),
      fund_vehicles ( id, name )
    `)
    .eq('fund_id', access.fundId)
    .is('resolution', null)
  if (visible !== null) q = q.in('company_id', visible)
  const { data, error } = await q.order('created_at', { ascending: false }).limit(Math.min(Math.max(opts.limit ?? 100, 1), 500))
  if (error) throw new Error(`review queue read failed: ${error.message}`)

  const fundReadable = hasAccess(access, 'portfolio', 'read', 'investments')
  const rows = scopeFundReviews(((data as any[]) ?? []), access)
    .filter(r => fundReadable || !isFundReviewType(r.issue_type))

  const items = rows.map(r => ({
    id: r.id,
    issue_type: r.issue_type,
    extracted_value: r.extracted_value,
    context_snippet: r.context_snippet,
    created_at: r.created_at,
    company: r.companies ?? null,
    metric: r.metrics ?? null,
    email: r.inbound_emails ?? null,
    payload: r.payload ?? null,
    vehicle: r.fund_vehicles ?? null,
  }))
  const counts: Record<string, number> = {}
  for (const item of items) counts[item.issue_type] = (counts[item.issue_type] ?? 0) + 1

  let eq = (admin as any)
    .from('inbound_emails')
    .select('id, from_address, subject, received_at, company_id')
    .eq('fund_id', access.fundId)
    .eq('processing_status', 'needs_review')
  if (visible !== null) eq = eq.in('company_id', visible)
  const { data: emails, error: emailError } = await eq.order('received_at', { ascending: false }).limit(100)
  if (emailError) throw new Error(`inbound_emails read failed: ${emailError.message}`)
  const emailRows = (emails as any[]) ?? []
  const companyIds = Array.from(new Set(emailRows.map(e => e.company_id).filter(Boolean)))
  const { data: companies } = companyIds.length
    ? await (admin as any).from('companies').select('id, name').eq('fund_id', access.fundId).in('id', companyIds)
    : { data: [] }
  const names = new Map(((companies as any[]) ?? []).map(c => [c.id, c.name]))
  const needsReviewEmails = emailRows.map(e => ({
    id: e.id, from_address: e.from_address, subject: e.subject, received_at: e.received_at,
    company: e.company_id ? { id: e.company_id, name: names.get(e.company_id) ?? 'Unknown' } : null,
  }))

  return { total: items.length, counts, items, needsReviewEmails }
}
