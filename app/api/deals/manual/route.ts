import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { loadEntityScopeForUser } from '@/lib/access/entity-scope'
import { createManualDeal } from '@/lib/deals/service'
import { outcomeResponse } from '@/lib/service-outcome'

/**
 * Admin-authenticated in-app deal creation. Composes a synthetic email payload
 * from form fields + optional file attachments and runs it through the same
 * processDeal pipeline that handles Postmark webhooks and the public submit
 * form. The deal lands in /deals exactly like an emailed one.
 *
 * Accepts multipart/form-data so the client can upload files directly without
 * base64-encoding on the browser side. Fields:
 *   - company_name   (required)
 *   - founder_name   (required)
 *   - founder_email  (required)
 *   - company_url    (optional)
 *   - intro_source   (optional) — referral | cold | warm_intro | accelerator | demo_day | event | other
 *   - referrer_name  (optional)
 *   - referrer_email (optional)
 *   - pitch          (required) — free-form description
 *   - vehicle_id     (required of a member) — the entity the deal is for
 *   - files[]        (optional, repeated) — up to 10, each up to 10 MB
 *
 * The work is lib/deals/service.ts createManualDeal, which `deals_create_inbound` calls from chat.
 */
export async function POST(req: NextRequest) {
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
  const fundId = (membership as any).fund_id as string

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return NextResponse.json({ error: 'Expected multipart/form-data' }, { status: 400 })
  }

  const scope = await loadEntityScopeForUser(admin, user.id)
  if (!scope) return NextResponse.json({ error: 'No fund found' }, { status: 403 })

  const files = form.getAll('files').filter((v): v is File => v instanceof File && v.size > 0)
  const field = (k: string) => String(form.get(k) ?? '')
  const result = await createManualDeal(admin, { fundId, userId: user.id, userEmail: user.email, access: scope.access }, {
    companyName: field('company_name'),
    founderName: field('founder_name'),
    founderEmail: field('founder_email'),
    companyUrl: field('company_url'),
    introSource: field('intro_source'),
    referrerName: field('referrer_name'),
    referrerEmail: field('referrer_email'),
    pitch: field('pitch'),
    // Which entity the deal is for. Required of a member (an unassigned deal is admins-only, so
    // they would lose sight of their own submission); optional for an admin.
    vehicleId: field('vehicle_id').trim() || null,
    files: await Promise.all(files.map(async f => ({
      name: f.name, type: f.type || 'application/octet-stream', bytes: Buffer.from(await f.arrayBuffer()),
    }))),
  })
  return outcomeResponse(result, v => ({ ok: true, email_id: v.emailId, deal_id: v.dealId }))
}
