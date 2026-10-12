import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { dbError } from '@/lib/api-error'
import { recordDiligenceDocument } from '@/lib/diligence/service'
import { outcomeResponse } from '@/lib/service-outcome'

const MAX_BYTES = 100 * 1024 * 1024  // 100 MB to match bucket cap

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const guard = await ensureMember()
  if ('error' in guard) return guard.error
  const { admin, fundId } = guard

  // Verify deal belongs to fund first.
  const { data: deal } = await admin
    .from('diligence_deals')
    .select('id')
    .eq('id', params.id)
    .eq('fund_id', fundId)
    .maybeSingle()
  if (!deal) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { data, error } = await admin
    .from('diligence_documents')
    .select('id, deal_id, fund_id, storage_path, file_name, file_format, file_size_bytes, detected_type, type_confidence, parse_status, parse_notes, drive_file_id, drive_source_url, uploaded_by, uploaded_at')
    .eq('deal_id', params.id)
    .eq('fund_id', fundId)
    .order('uploaded_at', { ascending: false })

  if (error) return dbError(error, 'diligence-documents-list')
  return NextResponse.json(data ?? [])
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const guard = await ensureMember()
  if ('error' in guard) return guard.error
  const { admin, fundId, userId } = guard

  // Verify deal.
  const { data: deal } = await admin
    .from('diligence_deals')
    .select('id')
    .eq('id', params.id)
    .eq('fund_id', fundId)
    .maybeSingle()
  if (!deal) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Two acceptance modes:
  //   1. multipart/form-data with `file` — legacy small-upload path (≤4.5 MB
  //      due to Vercel's serverless body limit). Kept for backwards compat.
  //   2. JSON with `storage_path` — the file was already uploaded directly to
  //      Supabase Storage via a signed URL minted by `/upload-url`. No file
  //      body transits Vercel, so this path works for the full 100 MB bucket.
  const contentType = req.headers.get('content-type') ?? ''

  let safeName: string
  let storagePath: string
  let fileSize: number
  let mime: string
  // Set only on the multipart path, where the bytes already transit the server; the JSON
  // (signed-URL) path leaves this null and the quarantine scan below downloads the object.
  let multipartBuffer: Buffer | null = null

  if (contentType.includes('application/json')) {
    const body = await req.json().catch(() => ({}))
    if (typeof body.storage_path !== 'string') {
      return NextResponse.json({ error: 'storage_path is required' }, { status: 400 })
    }
    storagePath = body.storage_path
    // Path must live under this deal's folder (server issued it with this
    // constraint via /upload-url, but re-check defensively).
    if (!storagePath.startsWith(`${params.id}/`)) {
      return NextResponse.json({ error: 'storage_path outside deal folder' }, { status: 400 })
    }
    safeName = (typeof body.file_name === 'string' ? body.file_name : storagePath.split('/').pop() ?? '')
      .replace(/[\/\\:*?"<>|]/g, '_').replace(/\.\./g, '_').slice(0, 200)
    mime = typeof body.content_type === 'string' ? body.content_type : 'application/octet-stream'

    // Verify the object actually exists in storage and read its size. This
    // closes the race where the client could call this endpoint without
    // having completed the storage upload.
    const folder = storagePath.split('/').slice(0, -1).join('/')
    const fileBase = storagePath.split('/').pop()
    const { data: listing, error: listErr } = await admin.storage
      .from('diligence-documents')
      .list(folder, { search: fileBase ?? undefined, limit: 1 })
    if (listErr || !listing || listing.length === 0) {
      return NextResponse.json({ error: 'Uploaded file not found in storage' }, { status: 400 })
    }
    fileSize = (listing[0] as any).metadata?.size ?? 0
    if (fileSize === 0) return NextResponse.json({ error: 'Empty file' }, { status: 400 })
    if (fileSize > MAX_BYTES) {
      // Defensive — bucket already enforces 100 MB but check here too.
      await admin.storage.from('diligence-documents').remove([storagePath]).catch(() => {})
      return NextResponse.json({ error: 'File exceeds 100 MB limit' }, { status: 400 })
    }
  } else {
    // Legacy multipart path for files under Vercel's body limit.
    let formData: FormData
    try {
      formData = await req.formData()
    } catch {
      return NextResponse.json({ error: 'Expected multipart/form-data or application/json' }, { status: 400 })
    }

    const file = formData.get('file')
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'file is required' }, { status: 400 })
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ error: 'File exceeds 100 MB limit' }, { status: 400 })
    }
    if (file.size === 0) {
      return NextResponse.json({ error: 'Empty file' }, { status: 400 })
    }

    safeName = file.name.replace(/[\/\\:*?"<>|]/g, '_').replace(/\.\./g, '_').slice(0, 200)
    storagePath = `${params.id}/${Date.now()}_${safeName}`
    fileSize = file.size
    mime = file.type || 'application/octet-stream'
    multipartBuffer = Buffer.from(await file.arrayBuffer())

    const { error: uploadErr } = await admin.storage
      .from('diligence-documents')
      .upload(storagePath, multipartBuffer, { contentType: mime, upsert: false })
    if (uploadErr) {
      console.error('[diligence-documents] upload', uploadErr.message)
      return NextResponse.json({ error: 'Upload failed.' }, { status: 500 })
    }
  }

  // Quarantine scan. The file is now in storage no matter which path we took — uploaded above
  // (multipart) or pushed straight to the bucket via a signed URL and registered through the
  // JSON branch. Scan it before recording the row, so an unsafe file (dangerous type, executable
  // signature, ZIP bomb) is never surfaced to the diligence pipeline. The multipart path already
  // holds the bytes; the signed-URL path must download them back to scan.
  let scanBuffer = multipartBuffer
  if (!scanBuffer) {
    const { data: blob, error: dlErr } = await admin.storage
      .from('diligence-documents')
      .download(storagePath)
    if (dlErr || !blob) {
      await admin.storage.from('diligence-documents').remove([storagePath]).catch(() => {})
      return NextResponse.json({ error: 'Uploaded file could not be read for scanning.' }, { status: 400 })
    }
    scanBuffer = Buffer.from(await blob.arrayBuffer())
  }
  // Scan, classify, record, and queue a recording for transcription: lib/diligence/service.ts,
  // the same step a document added from chat goes through.
  return outcomeResponse(await recordDiligenceDocument(admin, { fundId, userId }, params.id, {
    storagePath, name: safeName, mime, size: fileSize, bytes: scanBuffer,
  }))
}

// ---------------------------------------------------------------------------

async function ensureMember() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const admin = createAdminClient()
  const { data: membership } = await admin
    .from('fund_members')
    .select('fund_id, role')
    .eq('user_id', user.id)
    .maybeSingle()
  if (!membership) return { error: NextResponse.json({ error: 'No fund found' }, { status: 403 }) }
  return {
    admin,
    fundId: (membership as any).fund_id as string,
    userId: user.id,
    role: (membership as any).role as string,
  }
}
