import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { agentApiEnabled } from '@/lib/oauth/enabled'
import { hasAccess, loadAccessContext } from '@/lib/access/effective'
import { entityScopeFor } from '@/lib/access/entity-scope'
import { visibleLpEntityIds } from '@/lib/access/lp-scope'
import { resolveVehicle, VehicleResolutionError } from '@/lib/accounting/vehicle-resolver'
import { customPeriod } from '@/lib/accounting/statement-period'
import { generateLpStatementPdf } from '@/lib/accounting/lp-statement-pdf'
import { generateLiveInvestorReportPdf } from '@/lib/lp-report-pdf'
import { isExpiredReportLink, verifyReportLink } from '@/lib/agent/report-links'
import { carryRecipientIds, seesIndividualCarry } from '@/lib/access/carry-visibility'
import { listVehicles } from '@/lib/accounting/load'
import { rateLimit } from '@/lib/rate-limit'
import { withChangeSource } from '@/lib/audit/source'
import { logLpAccessEvent } from '@/lib/lp-access-log'
import { connectorPrincipal, lpConnectorEnabled } from '@/lib/portal/principal'
import { PortalError, portalStatementInvestors } from '@/lib/portal/service'
import { renderPdf as renderDocumentPdf } from '@/lib/document-templates/pdf'

export const runtime = 'nodejs'
export const maxDuration = 120

/**
 * GET /api/agent/reports/<token> — the PDF behind a link an assistant handed over
 * (`lp_statement_pdf`, `lp_report_card_pdf`; lib/agent/report-links.ts).
 *
 * The token only says WHO asked for WHAT, and that it was this deployment that issued it. Every
 * check is made again here, live, as if the member were asking now: still a member, agent access
 * still on, the LP capital grant, the vehicle and the LP within their entities. A link outlives
 * none of those. Every refusal is the same 404, so a link reveals nothing about why. The one exception
 * is expiry (410), which the token already states to anyone who reads it.
 */
export async function GET(req: NextRequest, props: { params: Promise<{ token: string }> }) {
  const { token } = await props.params
  const claims = verifyReportLink(token)
  if (!claims) return isExpiredReportLink(token) ? expired() : notFound()

  const limited = await rateLimit({ key: `agent-report:${claims.userId}`, limit: 30, windowSeconds: 60 })
  if (limited) return limited

  const admin = createAdminClient()
  // The investor connector's link: an LP's own statement. Re-checked as an investor, never as a
  // fund member, and recorded in the LP access log as a download through MCP.
  if (claims.kind === 'portal_statement') return withChangeSource('mcp', () => portalStatement(admin, claims.fundId, claims.userId))

  const { data: membership } = await admin
    .from('fund_members')
    .select('role')
    .eq('fund_id', claims.fundId)
    .eq('user_id', claims.userId)
    .maybeSingle()
  if (!membership) return notFound()
  if (!(await agentApiEnabled(admin, claims.fundId))) return notFound()

  const access = await loadAccessContext(admin, claims.fundId, claims.userId, (membership as { role: string }).role)
  // A document from the fund's own template (document_generate) is an LP letter, not a capital
  // account: it answers to the letters grant, and prints the render stored when it was generated.
  if (claims.kind === 'document') {
    if (!hasAccess(access, 'lp_relations', 'read', 'lp_letters')) return notFound()
    const renderId = claims.args.render
    if (typeof renderId !== 'string') return notFound()
    let doc: { pdf: Buffer; fileName: string } | null
    try {
      doc = await renderDocumentPdf(admin, claims.fundId, renderId)
    } catch (e) {
      console.error('[agent/reports] document', e)
      return NextResponse.json({ error: 'This document could not be generated. Try again, or ask for a new link.' }, { status: 500 })
    }
    return doc ? pdfResponse(doc) : notFound()
  }
  if (!hasAccess(access, 'lp_capital', 'read')) return notFound()
  const scope = await entityScopeFor(admin, access)

  let result: { pdf: Buffer; fileName: string } | null = null
  try {
    if (claims.kind === 'lp_statement') {
      const a = claims.args as Record<string, string | null>
      // Throws for a vehicle outside the member's entities.
      const group = await resolveVehicle(admin, claims.fundId, a.vehicle ?? undefined, { access })
      const visible = await visibleLpEntityIds(admin, scope)
      if (!a.lp || (visible !== null && !visible.includes(a.lp))) return notFound()
      // A carry recipient's statement is what they earn: GP economics.
      if (!seesIndividualCarry(access) && (await carryRecipientIds(admin, claims.fundId, group)).has(a.lp)) return notFound()
      // The dates and label as resolved when the link was made, so "last quarter" cannot become a
      // different quarter between the conversation and the click.
      const period = { ...customPeriod(a.start, a.end), ...(a.label ? { label: a.label } : {}) }
      result = await generateLpStatementPdf(admin, { fundId: claims.fundId, group, lpEntityId: a.lp, period })
    } else {
      const investor = claims.args.investor
      if (typeof investor !== 'string') return notFound()
      // A member who sees some entities gets those, never the investor's whole position; and,
      // without gp_economics, none of the positions on which the investor receives carry.
      let omit: Map<string, Set<string>> | undefined
      if (!seesIndividualCarry(access)) {
        // null = every vehicle (not none): the recipients of each one the fund has.
        const groups = scope.vehicleNames === null ? await listVehicles(admin, claims.fundId) : scope.vehicleNames
        omit = new Map(await Promise.all(groups.map(async g => [g, await carryRecipientIds(admin, claims.fundId, g)] as [string, Set<string>])))
      }
      result = await generateLiveInvestorReportPdf(admin, { fundId: claims.fundId, investorIds: [investor], groups: scope.vehicleNames, ...(omit ? { omit } : {}) })
    }
  } catch (e) {
    // NOT notFound(). Every check above has passed by now, so saying so reveals nothing — and
    // answering a render failure with "this link has expired" sent the last one hunting for an
    // expiry problem while Chromium was missing from the function (lib/pdf-routes.mjs).
    // The one throw that IS a refusal: resolveVehicle, for a vehicle outside the member's entities.
    if (e instanceof VehicleResolutionError) return notFound()
    console.error('[agent/reports]', claims.kind, e)
    return NextResponse.json({ error: 'This document could not be generated. Try again, or ask for a new link.' }, { status: 500 })
  }
  if (!result) return notFound()
  return pdfResponse(result)
}

function pdfResponse(result: { pdf: Buffer; fileName: string }) {
  return new NextResponse(new Uint8Array(result.pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${result.fileName.replace(/"/g, '')}"`,
      // A bearer URL: keep it out of shared caches and out of the Referer of anything it links to.
      'Cache-Control': 'private, no-store',
      'Referrer-Policy': 'no-referrer',
    },
  })
}

async function portalStatement(admin: ReturnType<typeof createAdminClient>, fundId: string, userId: string) {
  if (!(await lpConnectorEnabled(admin, fundId))) return notFound()
  const principal = await connectorPrincipal(admin, userId, fundId)
  if (!principal) return notFound()
  let investorIds: string[]
  try {
    investorIds = await portalStatementInvestors(admin, principal, fundId)
  } catch (e) {
    if (e instanceof PortalError) return notFound()
    throw e
  }
  let result: { pdf: Buffer; fileName: string } | null
  try {
    result = await generateLiveInvestorReportPdf(admin, { fundId, investorIds })
  } catch (e) {
    console.error('[agent/reports] portal_statement', e)
    return NextResponse.json({ error: 'This document could not be generated. Try again, or ask for a new link.' }, { status: 500 })
  }
  if (!result) return notFound()
  await logLpAccessEvent(admin, {
    fundId, lpAccountId: principal.lpAccountId, authUserId: userId, lpInvestorId: investorIds[0] ?? null,
    eventType: 'download', targetType: 'snapshot', targetTitle: result.fileName, metadata: { investor_ids: investorIds, format: 'pdf', live: true },
  })
  return new NextResponse(new Uint8Array(result.pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${result.fileName.replace(/"/g, '')}"`,
      'Cache-Control': 'private, no-store',
      'Referrer-Policy': 'no-referrer',
    },
  })
}

// Two messages, not one. They used to be the same — "expired or not available" — and a link reused
// after its hour (an assistant re-sharing one from earlier in the conversation) read exactly like a
// broken route.
function expired() {
  return NextResponse.json(
    { error: 'This link has expired — links last an hour. Ask the assistant for the document again to get a new one.' },
    { status: 410 },
  )
}

function notFound() {
  return NextResponse.json({ error: 'This link is not available to you.' }, { status: 404 })
}
