import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { createVisionOcrEngine } from '@/lib/company-updates/ocr'
import { runEntityDocumentOcr } from '@/lib/entity-documents'
import { cronAuthDenial } from '@/lib/security/cron-auth'

export const maxDuration = 300

/**
 * Entity-documents OCR worker: transcribes scanned pages of governing documents with each fund's
 * vision model, a batch at a time, resuming long documents across runs. Same fail-closed
 * CRON_SECRET pattern as the other workers.
 */
export async function GET(req: NextRequest) {
  const denied = cronAuthDenial(req)
  if (denied) return denied
  const admin = createAdminClient()
  try {
    const result = await runEntityDocumentOcr(admin as any, {
      engineFor: fundId => createVisionOcrEngine(fundId, { admin }),
    })
    return NextResponse.json(result)
  } catch (err) {
    console.error('[cron/entity-documents-ocr] failed:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
