import type { SupabaseClient } from '@supabase/supabase-js'
import {
  documentStoragePath, ENTITY_DOCUMENT_BUCKET, ingestDocument, isDocumentKind, listDocuments,
  MAX_ENTITY_DOCUMENT_BYTES, pathBelongsTo, type EntityDocument,
} from './index'

// The agent (MCP / REST) side of an entity's governing documents: the same signed-URL upload and
// ingest the Documents page uses (app/api/entities/[id]/documents), so a file stored by an agent is
// scanned, read and indexed exactly like one dropped in the browser.
//
// A file reaches storage one of two ways:
//   * small files inline, as base64 in the call (MAX_INLINE_BYTES), or
//   * any size up to 25 MB through `entity_document_upload_url`: the agent PUTs the bytes to the
//     signed URL and then passes the returned storage path here. That keeps a PDF out of the
//     JSON-RPC body (and out of the model's context).

/** Inline uploads stay well under the serverless request-body limit once base64-encoded. */
export const MAX_INLINE_BYTES = 3 * 1024 * 1024

interface Scope { admin: SupabaseClient; fundId: string; vehicleId: string; userId: string | null }

export async function entityDocumentUploadUrl(
  { admin, fundId, vehicleId }: Scope,
  input: { fileName?: unknown; sizeBytes?: unknown },
): Promise<{ storagePath: string; signedUrl: string; method: 'PUT'; next: string }> {
  const fileName = cleanFileName(input.fileName)
  if (Number(input.sizeBytes) > MAX_ENTITY_DOCUMENT_BYTES) throw new Error('Files can be up to 25 MB.')
  const storagePath = documentStoragePath(fundId, vehicleId, fileName)
  const { data, error } = await (admin as any).storage.from(ENTITY_DOCUMENT_BUCKET).createSignedUploadUrl(storagePath)
  if (error || !data) throw new Error('Could not start the upload.')
  return {
    storagePath,
    signedUrl: data.signedUrl,
    method: 'PUT',
    next: 'PUT the file bytes to signedUrl (Content-Type set to the file type), then call add_entity_document with this storagePath.',
  }
}

export async function addEntityDocument(
  { admin, fundId, vehicleId, userId }: Scope,
  input: {
    storagePath?: unknown; contentBase64?: unknown; fileName?: unknown; contentType?: unknown
    kind?: unknown; title?: unknown; effectiveDate?: unknown
  },
): Promise<EntityDocument> {
  const fileName = cleanFileName(input.fileName)
  const contentType = typeof input.contentType === 'string' && input.contentType ? input.contentType : null
  let storagePath: string
  if (typeof input.storagePath === 'string' && input.storagePath) {
    if (input.contentBase64) throw new Error('Pass storagePath or contentBase64, not both.')
    if (!pathBelongsTo(input.storagePath, fundId, vehicleId)) throw new Error('That upload does not belong to this entity.')
    storagePath = input.storagePath
  } else if (typeof input.contentBase64 === 'string' && input.contentBase64) {
    const buffer = Buffer.from(input.contentBase64, 'base64')
    if (buffer.length === 0) throw new Error('contentBase64 is empty or not base64.')
    if (buffer.length > MAX_INLINE_BYTES) {
      throw new Error('Files over 3 MB go through entity_document_upload_url instead of contentBase64.')
    }
    storagePath = documentStoragePath(fundId, vehicleId, fileName)
    const { error } = await (admin as any).storage.from(ENTITY_DOCUMENT_BUCKET)
      .upload(storagePath, buffer, { contentType: contentType ?? 'application/octet-stream', upsert: false })
    if (error) throw new Error('Could not store the file.')
  } else {
    throw new Error('Pass the file as storagePath (from entity_document_upload_url) or contentBase64.')
  }

  const kind = isDocumentKind(input.kind) ? input.kind : 'other'
  const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim().slice(0, 200) : fileName
  const effectiveDate = typeof input.effectiveDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.effectiveDate)
    ? input.effectiveDate : null
  const result = await ingestDocument(admin, {
    fundId, vehicleId, storagePath, fileName, contentType, kind, title, effectiveDate,
    uploadedBy: userId,
  })
  if ('error' in result) throw new Error(result.error)
  return result.document
}

export async function listEntityDocuments({ admin, fundId, vehicleId }: Scope): Promise<EntityDocument[]> {
  return listDocuments(admin, fundId, [vehicleId])
}

function cleanFileName(v: unknown): string {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, 255) : 'document'
}
