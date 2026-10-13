import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// lp_capital domain (lib/access/route-domains.ts), same as the capital-calls route it drafts for.
// Approving is admin-only (lib/access/admin-only.ts): it issues the call and publishes notices.
import { assertWriteAccess, assertReadAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { outcomeResponse } from '@/lib/service-outcome'
import {
  approveCallNoticeDraft, createCallNoticeDraft, discardCallNoticeDraft, getCallNoticeDraft, listCallNoticeDrafts,
  reviseCallNoticeDraft, type DraftStatus,
} from '@/lib/accounting/call-notice-drafts'
import { callNoticeRequestFrom } from '@/lib/accounting/call-notice-input'
import { publishCallNotices } from '@/lib/accounting/call-notice-publish'

export const runtime = 'nodejs'
// Approving publishes one notice PDF per partner through headless Chrome.
export const maxDuration = 300

// GET ?group=&id=   — one draft, re-checked against today's records
// GET ?group=&status= — the vehicle's drafts, newest first
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const group = await resolveGroupOr400(admin, gate, req.nextUrl.searchParams.get('group'))
  if (group instanceof NextResponse) return group
  const ctx = { fundId: gate.fundId, group, userId: user.id }

  const id = req.nextUrl.searchParams.get('id')
  if (id) return outcomeResponse(await getCallNoticeDraft(admin, ctx, id))
  const vehicleId = await vehicleIdByName(admin, gate.fundId, group)
  if (!vehicleId) return NextResponse.json({ drafts: [] })
  const status = req.nextUrl.searchParams.get('status') as DraftStatus | null
  return outcomeResponse(
    await listCallNoticeDrafts(admin, gate.fundId, [{ id: vehicleId, name: group }], status && ['draft', 'approved', 'discarded'].includes(status) ? status : undefined),
    drafts => ({ drafts }),
  )
}

// POST — { action, group?, ... }
//   draft:   { total, purposes: [{ category, amount, description?, basis?, date? }], noticeDate?, dueDate?,
//              noticePeriodDays?, noticePeriodBasis?, description? }
//   revise:  { id, ...any of the draft fields }
//   discard: { id }
//   approve: { id, acknowledge? }   — admin only; issues the call, then publishes each LP's notice
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const body = await req.json().catch(() => ({}))
  const group = await resolveGroupOr400(admin, gate, body?.group ?? req.nextUrl.searchParams.get('group'))
  if (group instanceof NextResponse) return group
  const ctx = { fundId: gate.fundId, group, userId: user.id }
  const id = typeof body?.id === 'string' ? body.id : ''

  switch (body?.action) {
    case 'draft': {
      const parsed = callNoticeRequestFrom(body)
      if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })
      return outcomeResponse(await createCallNoticeDraft(admin, ctx, parsed.request))
    }
    case 'revise': {
      const parsed = callNoticeRequestFrom(body, { partial: true })
      if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })
      return outcomeResponse(await reviseCallNoticeDraft(admin, ctx, id, parsed.request))
    }
    case 'discard':
      return outcomeResponse(await discardCallNoticeDraft(admin, ctx, id))
    case 'approve': {
      const approved = await approveCallNoticeDraft(admin, ctx, id, { role: gate.role, acknowledge: body?.acknowledge === true })
      if (!approved.ok) return outcomeResponse(approved)
      // The call is issued; now each LP's own notice goes to their portal (and again on a retry,
      // which reuses what is already there).
      const notices = await publishCallNotices(admin, { ...ctx, userId: user.id }, approved.value.capitalCallId)
      return NextResponse.json({ ...approved.value, noticesPublished: notices.published, publishErrors: notices.errors })
    }
    default:
      return NextResponse.json({ error: "action must be 'draft', 'revise', 'discard' or 'approve'" }, { status: 400 })
  }
}
