import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { dbError } from '@/lib/api-error'
import { loadAccessContext } from '@/lib/access/effective'
import { outcomeResponse } from '@/lib/service-outcome'
import { REVIEW_COLUMNS, REVIEW_RESOLUTIONS, resolveReview, type ResolveReviewInput, type ReviewRow } from '@/lib/review/resolve'

// Resolve one review-queue item. The rules live in lib/review/resolve.ts, shared with the agent's
// resolve_review tool.
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const writeCheck = await assertWriteAccess(createAdminClient(), user.id)
  if (writeCheck instanceof NextResponse) return writeCheck

  const body = await req.json() as ResolveReviewInput

  // Refuse a malformed request before reading anything, as this route always has.
  if (!(REVIEW_RESOLUTIONS as readonly string[]).includes(body.resolution)) {
    return NextResponse.json({ error: 'Invalid resolution' }, { status: 400 })
  }
  if (body.resolution === 'manually_corrected' && !body.resolved_value?.trim()) {
    return NextResponse.json(
      { error: 'resolved_value is required for manually_corrected' },
      { status: 400 }
    )
  }

  // RLS ensures the review belongs to the user's fund; say the same with the gate's fund.
  const { data: reviewData, error: reviewError } = await supabase
    .from('parsing_reviews')
    .select(REVIEW_COLUMNS)
    .eq('id', params.id)
    .eq('fund_id', writeCheck.fundId)
    .maybeSingle()

  if (reviewError) return dbError(reviewError, 'review-id-resolve')
  if (!reviewData) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const admin = createAdminClient()
  const outcome = await resolveReview(admin, {
    fundId: writeCheck.fundId,
    userId: user.id,
    loadAccess: () => loadAccessContext(admin, writeCheck.fundId, writeCheck.userId, writeCheck.role),
  }, reviewData as unknown as ReviewRow, body)
  return outcomeResponse(outcome)
}
