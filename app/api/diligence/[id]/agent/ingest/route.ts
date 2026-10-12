import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { enqueueAnalysis } from '@/lib/memo-agent/enqueue'
import { outcomeResponse } from '@/lib/service-outcome'

/**
 * Enqueue a data-room analysis. Re-analyze is incremental: it only ingests
 * documents that haven't been parsed yet (new + previously-failed) and, when
 * there's nothing new to ingest, runs just the checklist checks against the
 * existing ingest output. The cron worker picks the job up within ~1 minute. The work is
 * lib/memo-agent/enqueue.ts, which `run_diligence_agent` calls from chat.
 */
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
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
  const fundId = (membership as any).fund_id as string

  // Verify deal.
  const { data: deal } = await admin
    .from('diligence_deals')
    .select('id')
    .eq('id', params.id)
    .eq('fund_id', fundId)
    .maybeSingle()
  if (!deal) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const body = await req.json().catch(() => ({}))
  return outcomeResponse(await enqueueAnalysis(admin, { fundId, userId: user.id }, params.id, {
    documentIds: Array.isArray(body.document_ids) ? body.document_ids : undefined,
    full: body.full === true,
  }))
}
