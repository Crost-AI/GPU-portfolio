import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { dbError } from '@/lib/api-error'
import { loadEntityScopeForUser } from '@/lib/access/entity-scope'
import { updateInboundDeal } from '@/lib/deals/service'
import { outcomeResponse } from '@/lib/service-outcome'

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const { data: membership } = await admin
    .from('fund_members')
    .select('fund_id')
    .eq('user_id', user.id)
    .maybeSingle()
  if (!membership) return NextResponse.json({ error: 'No fund found' }, { status: 403 })

  const { data: deal, error } = await admin
    .from('inbound_deals')
    .select('*')
    .eq('id', params.id)
    .eq('fund_id', membership.fund_id)
    .maybeSingle()

  if (error) return dbError(error, 'deals-id')
  if (!deal) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Hydrate the originating email for the detail panel. Project only the
  // raw_payload fields the UI actually consumes — TextBody and attachment
  // metadata — rather than returning the full Postmark blob (which can
  // include headers, HTML bodies, and references to attachment storage).
  const { data: emailRow } = await admin
    .from('inbound_emails')
    .select('id, from_address, subject, received_at, raw_payload, routing_label, routing_confidence, routing_reasoning')
    .eq('id', (deal as any).email_id)
    .maybeSingle()
  let email: typeof emailRow = emailRow
  if (emailRow) {
    const rp = (emailRow as any).raw_payload as { TextBody?: string; Attachments?: Array<{ Name?: string; ContentType?: string; ContentLength?: number }> } | null
    const safePayload = rp ? {
      TextBody: rp.TextBody ?? '',
      Attachments: (rp.Attachments ?? []).map(a => ({
        Name: a?.Name ?? '',
        ContentType: a?.ContentType ?? '',
        ContentLength: a?.ContentLength ?? 0,
      })),
    } : null
    email = { ...(emailRow as any), raw_payload: safePayload } as typeof emailRow
  }

  // Pull prior deal summary for the lineage card.
  let priorDeal: { id: string; company_name: string | null; created_at: string | null } | null = null
  if ((deal as any).prior_deal_id) {
    const { data } = await admin
      .from('inbound_deals')
      .select('id, company_name, created_at')
      .eq('id', (deal as any).prior_deal_id)
      .maybeSingle()
    priorDeal = data as typeof priorDeal
  }

  return NextResponse.json({ deal, email, priorDeal })
}

export async function PATCH(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const { data: membership } = await admin
    .from('fund_members')
    .select('fund_id')
    .eq('user_id', user.id)
    .maybeSingle()
  if (!membership) return NextResponse.json({ error: 'No fund found' }, { status: 403 })

  const scope = await loadEntityScopeForUser(admin, user.id)
  if (!scope) return NextResponse.json({ error: 'No fund found' }, { status: 403 })

  const body = await req.json().catch(() => ({}))
  // The owning entity: the gate already confirmed the caller can see this deal, and
  // lib/deals/service.ts checks the new entity is theirs too and belongs to this fund.
  const result = await updateInboundDeal(admin, scope.access, params.id, {
    status: body.status,
    vehicleId: typeof body.vehicle_id === 'string' || body.vehicle_id === null ? body.vehicle_id : undefined,
    assignedTo: typeof body.assigned_to === 'string' || body.assigned_to === null ? body.assigned_to : undefined,
  })
  return outcomeResponse(result, () => ({ ok: true }))
}
