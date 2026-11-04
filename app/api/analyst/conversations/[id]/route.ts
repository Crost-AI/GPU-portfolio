import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { dbError } from '@/lib/api-error'
import { refuseFleetCompany } from '@/lib/access/fleet-company'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()

  const { data: membership } = await admin
    .from('fund_members')
    .select('fund_id')
    .eq('user_id', user.id)
    .maybeSingle()

  if (!membership) return NextResponse.json({ error: 'No fund' }, { status: 403 })

  const { data, error } = await admin
    .from('analyst_conversations')
    .select('*')
    .eq('id', id)
    .eq('user_id', user.id)
    .eq('fund_id', membership.fund_id)
    .maybeSingle()

  if (error) return dbError(error, 'analyst-conversations-id')
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  // ── GPU fleet (P3) ── A thread about a fleet company needs fleet read now, not only when it was
  // started (#91): not found once the grant is revoked or gpu_fleet is off.
  const companyId = (data as { company_id?: string | null }).company_id
  if (companyId) {
    const fleetDenied = await refuseFleetCompany(admin, user.id, { companyId }, 'read')
    if (fleetDenied) return fleetDenied
  }

  return NextResponse.json({ conversation: data })
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()

  const { data: membership } = await admin
    .from('fund_members')
    .select('fund_id')
    .eq('user_id', user.id)
    .maybeSingle()

  if (!membership) return NextResponse.json({ error: 'No fund' }, { status: 403 })

  const { error } = await admin
    .from('analyst_conversations')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id)
    .eq('fund_id', membership.fund_id)

  if (error) return dbError(error, 'analyst-conversations-id')

  return NextResponse.json({ ok: true })
}
