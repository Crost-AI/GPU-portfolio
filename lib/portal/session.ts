/**
 * The web portal's way in: the signed-in LP from their Supabase session, as the same
 * `LpPrincipal` the investor connector builds from its token (lib/portal/principal.ts).
 */
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveLpAccess } from '@/lib/api-helpers'
import { PortalError, type LpPrincipal } from './service'

export async function sessionPrincipal(): Promise<{ admin: any; principal: LpPrincipal } | NextResponse> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const admin = createAdminClient() as any
  const access = await resolveLpAccess(admin, user.id)
  if (access instanceof NextResponse) return access
  return { admin, principal: { userId: user.id, email: user.email ?? null, lpAccountId: access.lpAccountId, investorIds: access.investorIds } }
}

/** A service refusal as the route's response; anything else is a 500. */
export function portalErrorResponse(e: unknown, label: string): NextResponse {
  if (e instanceof PortalError) return NextResponse.json({ error: e.message }, { status: e.status })
  console.error(`[${label}]`, e)
  return NextResponse.json({ error: 'Internal error' }, { status: 500 })
}
