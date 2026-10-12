import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { dbError } from '@/lib/api-error'
// lp_capital domain (lib/access/route-domains.ts). The middleware has already checked the caller's
// grant for this route + method; this resolves identity and keeps the demo out of writes.
import { assertWriteAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { addPartner, applyPartnerClassTerms, parseAddPartnerInput } from '@/lib/accounting/add-partner'

// POST — the "strict" accounting-side add of a partner (LP or GP) to the vehicle being viewed.
// The work is in lib/accounting/add-partner.ts, shared with the agent's add_partner tool.
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

  const input = parseAddPartnerInput(body)
  if ('error' in input) return NextResponse.json({ error: input.error }, { status: input.status })
  const result = await addPartner(admin, gate.fundId, group, user.id, input)
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json(result)
}

// PATCH — switch an existing partner's class between GP and LP without touching commitment or
// lp_investments. The old way to do this was to re-run the "Add LP" form with the exact name,
// which zeroed out commitment (the create path's upsert on lp_investments) and only ever
// disabled fee/carry (never re-enabled it on an lp->gp->lp round trip). This is the clean,
// side-effect-free switch: it flips lp_entities.partner_class and re-applies fee/carry
// participation symmetrically, and nothing else.
export async function PATCH(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const body = await req.json().catch(() => ({}))
  const group = await resolveGroupOr400(admin, gate, body?.group ?? req.nextUrl.searchParams.get('group'))
  if (group instanceof NextResponse) return group

  const entityId = String(body?.entityId ?? '').trim()
  if (!entityId) return NextResponse.json({ error: 'entityId is required' }, { status: 400 })
  const partnerClass = body?.partnerClass
  if (partnerClass !== 'gp' && partnerClass !== 'lp') {
    return NextResponse.json({ error: "partnerClass must be 'gp' or 'lp'" }, { status: 400 })
  }

  const { data: entity } = await admin.from('lp_entities' as any)
    .select('id').eq('id', entityId).eq('fund_id', gate.fundId).maybeSingle()
  if (!entity) return NextResponse.json({ error: 'LP entity not found' }, { status: 404 })

  const { error } = await admin.from('lp_entities' as any)
    .update({ partner_class: partnerClass }).eq('id', entityId).eq('fund_id', gate.fundId)
  if (error) return dbError(error, 'accounting-lps')

  await applyPartnerClassTerms(admin, gate.fundId, group, entityId, partnerClass)

  return NextResponse.json({ ok: true, partnerClass })
}
