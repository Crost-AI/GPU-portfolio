import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logActivity } from '@/lib/activity'
import { publicOrigin } from '@/lib/public-origin'

export async function POST(req: Request) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (user) {
    const admin = createAdminClient()
    const { data: membership } = await admin
      .from('fund_members')
      .select('fund_id')
      .eq('user_id', user.id)
      .maybeSingle()
    if (membership) {
      logActivity(admin, membership.fund_id, user.id, 'logout')
    }
  }

  await supabase.auth.signOut()

  const origin = publicOrigin(req)
  return NextResponse.redirect(new URL('/auth', origin))
}
