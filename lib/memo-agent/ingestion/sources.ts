import { createAdminClient } from '@/lib/supabase/admin'

type Admin = ReturnType<typeof createAdminClient>

// Audio/video formats are transcribed (Deepgram), never parsed as documents.
// The document parser has no handler for them — excluding by file_format here
// is defence-in-depth so a recording with a stale/missing detected_type can't
// slip into ingest and fail with "Unsupported format".
export const AUDIO_VIDEO_FORMATS = new Set([
  'mp3', 'm4a', 'wav', 'aac', 'ogg', 'oga', 'flac', 'opus',
  'mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'wmv',
])

/**
 * A diligence_documents row enriched with the bytes from storage.
 * Whether it came from direct upload or a Drive folder import doesn't
 * matter at this point — both end up as rows in the same table with a
 * `storage_path` pointing into the diligence-documents bucket.
 */
export interface IngestionFileSource {
  document_id: string
  file_name: string
  file_format: string
  detected_type: string | null
  buffer: Buffer
  byte_size: number
}

/**
 * Resolve the ordered list of document ids that ingest should process for a
 * deal — applying the same filters as loadDealDocuments (skip `skipped`,
 * `call_recording`, and audio/video formats) but WITHOUT downloading any
 * bytes. Used by the ingest worker to batch a large data room across multiple
 * function invocations instead of loading + parsing every document in one run
 * (which blows past the Vercel function ceiling). Ordered oldest-first so
 * batching is deterministic across continuation ticks.
 */
export async function listIngestableDocumentIds(
  admin: Admin,
  dealId: string,
  fundId: string,
): Promise<string[]> {
  const { data, error } = await admin
    .from('diligence_documents')
    .select('id, file_format, uploaded_at')
    .eq('deal_id', dealId)
    .eq('fund_id', fundId)
    .neq('parse_status', 'skipped')
    .neq('detected_type', 'call_recording')
    .order('uploaded_at', { ascending: true })
  if (error) throw new Error(`Failed to list deal documents: ${error.message}`)
  return ((data ?? []) as Array<{ id: string; file_format: string | null }>)
    .filter(r => !AUDIO_VIDEO_FORMATS.has((r.file_format ?? '').toLowerCase()))
    .map(r => r.id)
}

/**
 * Load every non-skipped document for a deal, downloading the bytes from
 * Supabase storage. Skipped (`parse_status = 'skipped'`) files are excluded.
 *
 * If `documentIds` is provided, only those are loaded (used for partial
 * re-runs on a single newly-uploaded file).
 */
export async function loadDealDocuments(
  admin: Admin,
  dealId: string,
  fundId: string,
  documentIds?: string[],
): Promise<IngestionFileSource[]> {
  let query = admin
    .from('diligence_documents')
    .select('id, deal_id, fund_id, storage_path, file_name, file_format, file_size_bytes, detected_type, parse_status')
    .eq('deal_id', dealId)
    .eq('fund_id', fundId)
    .neq('parse_status', 'skipped')
    // Raw recordings have no parseable text — the transcribe job will create
    // a separate call_transcript document that this loader will pick up.
    .neq('detected_type', 'call_recording')

  if (documentIds && documentIds.length > 0) {
    query = query.in('id', documentIds)
  }

  // A fixed order, so the manifest in each document's prompt is the same on every run: the
  // assistant runner (lib/memo-agent/assistant-runner.ts) matches its answers to calls by content.
  const { data, error } = await query.order('uploaded_at', { ascending: true }).order('id', { ascending: true })
  if (error) throw new Error(`Failed to list deal documents: ${error.message}`)

  const allRows = (data ?? []) as Array<{
    id: string
    storage_path: string
    file_name: string
    file_format: string
    file_size_bytes: number | null
    detected_type: string | null
  }>

  // Drop audio/video files — they go through the transcribe pipeline, not the
  // document parser. The detected_type filter above catches correctly-
  // classified recordings; this format check also catches ones with a stale
  // or missing detected_type.
  const rows = allRows.filter(r => !AUDIO_VIDEO_FORMATS.has((r.file_format ?? '').toLowerCase()))

  // Parallel downloads — Supabase storage handles ~10+ concurrent downloads
  // comfortably, and the alternative (sequential) easily blew past the 120s
  // worker ceiling for multi-doc data rooms before the ingest even started.
  const results = await Promise.all(rows.map(async (row): Promise<IngestionFileSource | null> => {
    const { data: blob, error: dlErr } = await admin.storage
      .from('diligence-documents')
      .download(row.storage_path)
    if (dlErr || !blob) {
      console.warn(`[memo-agent.sources] download failed for ${row.storage_path}:`, dlErr?.message)
      return null
    }
    const arr = await blob.arrayBuffer()
    const buffer = Buffer.from(arr)
    return {
      document_id: row.id,
      file_name: row.file_name,
      file_format: row.file_format.toLowerCase(),
      detected_type: row.detected_type,
      buffer,
      byte_size: row.file_size_bytes ?? buffer.length,
    }
  }))
  return results.filter((s): s is IngestionFileSource => s !== null)
}
