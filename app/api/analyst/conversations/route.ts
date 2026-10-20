import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { dbError } from '@/lib/api-error'
import { loadEntityScopeForUser } from '@/lib/access/entity-scope'
import { fleetCompanyDenied, hiddenFleetCompanyIds } from '@/lib/access/fleet-company'

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()

  const { data: membership } = await admin
    .from('fund_members')
    .select('fund_id')
    .eq('user_id', user.id)
    .maybeSingle()
  if (!membership) return NextResponse.json({ error: 'No fund' }, { status: 404 })

  const { searchParams } = new URL(req.url)
  const companyId = searchParams.get('companyId')
  const dealId = searchParams.get('dealId')
  const portfolio = searchParams.get('portfolio') === 'true'
  // A domain thread ('accounting:<vehicle>', 'lps', 'diligence'); absent = the portfolio thread.
  const scope = searchParams.get('scope')

  let query = admin
    .from('analyst_conversations')
    .select('id, title, company_id, deal_id, scope, message_count, created_at, updated_at')
    .eq('fund_id', membership.fund_id)
    .eq('user_id', user.id)
    .order('updated_at', { ascending: false })
    .limit(20)

  if (dealId) {
    query = query.eq('deal_id', dealId)
  } else if (companyId) {
    query = query.eq('company_id', companyId).is('deal_id', null)
  } else if (portfolio || scope) {
    // Both are the "not company, not deal" case; `scope` then picks the domain thread apart from
    // the portfolio one. Listing is by ownership — the scope only sorts threads, it grants nothing.
    query = query.is('company_id', null).is('deal_id', null)
    query = scope ? query.eq('scope', scope) : query.is('scope', null)
  }

  const { data, error } = await query
  if (error) return dbError(error, 'analyst-conversations')

  // ── GPU fleet (P3) ── A thread about a fleet company is listed only while the caller can read the
  // fleet (#91): a grant revoked, or gpu_fleet switched off, hides the saved transcript too.
  const rows = (data ?? []) as { company_id: string | null }[]
  const hidden = await hiddenFleetCompanyIds(admin, membership.fund_id, user.id, rows.map(r => r.company_id).filter((v): v is string => !!v))
  return NextResponse.json({ conversations: hidden.size ? rows.filter(r => !r.company_id || !hidden.has(r.company_id)) : data })
}

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
  if (!membership) return NextResponse.json({ error: 'No fund' }, { status: 404 })

  let body: { companyId?: string }
  try {
    body = await req.json()
  } catch {
    body = {}
  }

  // Verify company belongs to fund if provided
  if (body.companyId) {
    const { data: companyCheck } = await (admin as any)
      .from('companies')
      .select('fund_id, holding_type')
      .eq('id', body.companyId)
      .maybeSingle()
    const scope = await loadEntityScopeForUser(admin, user.id)
    const visible = scope ? scope.companyIds : []
    if (!companyCheck || companyCheck.fund_id !== membership.fund_id
      || (visible !== null && !visible.includes(body.companyId))
      // ── GPU fleet (P3) ── a fleet company needs fleet read too (#91).
      || !scope || fleetCompanyDenied(scope.access, companyCheck.holding_type)) {
      return NextResponse.json({ error: 'Invalid company' }, { status: 403 })
    }
  }

  const { data, error } = await admin
    .from('analyst_conversations')
    .insert({
      fund_id: membership.fund_id,
      user_id: user.id,
      company_id: body.companyId ?? null,
    })
    .select('id, title, company_id, message_count, created_at, updated_at')
    .single()

  if (error) return dbError(error, 'analyst-conversations')

  return NextResponse.json({ conversation: data })
}
