import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { runOcrBatch } from '@/lib/company-updates/ocr'
import { cronAuthDenial } from '@/lib/security/cron-auth'

export const maxDuration = 300

/**
 * Company Updates OCR worker. Claims pending artifacts (images, scanned PDF pages) across funds
 * and transcribes them with each fund's configured vision model, merging text back atomically.
 * Same fail-closed CRON_SECRET pattern as the other workers.
 */
export async function GET(req: NextRequest) {
  const denied = cronAuthDenial(req)
  if (denied) return denied

  const admin = createAdminClient()
  try {
    const result = await runOcrBatch(admin as any, { limit: 8 })
    return NextResponse.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[cron/company-updates-ocr] failed:', err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
