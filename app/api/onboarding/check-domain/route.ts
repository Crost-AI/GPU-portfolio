import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { joinableFunds } from '@/lib/onboarding/joinable-funds'

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()

  // Check if user already belongs to a fund — if so, don't suggest joining
  const { data: existing } = await admin
    .from('fund_members')
    .select('fund_id')
    .eq('user_id', user.id)
    .maybeSingle()

  if (existing) return NextResponse.json({ fund: null })

  // The fund that listed this address, or its domain, or claims its domain. A consumer mailbox
  // domain (gmail.com …) only matches through an exact address — see joinableFunds.
  const [fund] = await joinableFunds(admin, user.email)
  return NextResponse.json({ fund: fund ?? null })
}
