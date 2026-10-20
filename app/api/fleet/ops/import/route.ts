import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// fleet domain (lib/access/route-domains.ts). The middleware has already checked the grant.
import { fleetRequest } from '@/lib/gpu/ops/http'
import { importEarnings } from '@/lib/gpu/ops/import'

export const runtime = 'nodejs'

// POST — stage manual GPU operations entry for a GPU SPV: `{ group, rows }` from the form, or
// `{ group, csv, fileName? }` from a paste. Never posts. Returns the bank-import ImportResult plus
// `{ runId, staged }`.
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const ctx = await fleetRequest(admin, user.id, 'write', body?.group)
  if (ctx instanceof NextResponse) return ctx

  const fileName = typeof body?.fileName === 'string' ? body.fileName : undefined
  const input = typeof body?.csv === 'string'
    ? { csv: body.csv as string, fileName }
    : Array.isArray(body?.rows) ? { rows: body.rows, fileName } : null
  if (!input) return NextResponse.json({ error: 'Send rows (from the form) or csv (a paste)' }, { status: 400 })

  const result = await importEarnings(admin, ctx.gate.fundId, ctx.group, user.id, input)
  if ('error' in result) return NextResponse.json(result, { status: 400 })
  return NextResponse.json(result)
}
