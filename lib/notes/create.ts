/**
 * Writing a note on a company: the notes route (POST /api/companies/[id]/notes) and the agent's
 * `add_company_note` tool both come through here, so a note from chat is filed to the same entity,
 * resolves the same @mentions and notifies the same people as one typed in the app.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { EntityScope } from '@/lib/access/entity-scope'
import { filterByCompany } from '@/lib/access/scope'
import { parseMentions, parseCompanyMentions } from './mentions'
import { resolveNoteEntity } from './entity'

export type CreateNoteResult =
  | { ok: true; note: { id: string; content: string; user_id: string; created_at: string }; vehicleId: string; mentionedUserIds: string[]; authorName: string | null }
  | { ok: false; status: number; error: string; code?: string; dbError?: unknown }

export async function createCompanyNote(
  admin: SupabaseClient,
  opts: {
    scope: EntityScope
    userId: string
    userEmail?: string | null
    company: { id: string; fund_id: string; name: string }
    content: string
    vehicleId?: string | null
    /** The client the row is inserted with: the route's user-session client, so RLS applies too. */
    insertWith?: SupabaseClient
  },
): Promise<CreateNoteResult> {
  const content = opts.content.trim()
  if (!content) return { ok: false, status: 400, error: 'Content is required' }
  const { company, scope, userId } = opts

  // Every note is for one of the writer's entities that holds this company.
  const entity = await resolveNoteEntity(admin, scope, company.id, opts.vehicleId)
  if ('error' in entity) return { ok: false, status: entity.status, error: entity.error, code: 'ENTITY_REQUIRED' }

  const { data: members } = await (admin as any)
    .from('fund_members').select('user_id, display_name').eq('fund_id', company.fund_id) as { data: { user_id: string; display_name: string | null }[] | null }
  // Resolve emails for members without display names
  const membersWithFallback = await Promise.all(
    (members ?? []).map(async m => {
      if (m.display_name?.trim()) return m
      const { data: { user: u } } = await admin.auth.admin.getUserById(m.user_id)
      return { ...m, email: u?.email }
    }),
  )
  const mentionedUserIds = parseMentions(content, membersWithFallback)

  // Only the writer's companies can be tagged.
  const { data: allCompanies } = await filterByCompany((admin as any)
    .from('companies').select('id, name').eq('fund_id', company.fund_id), scope.companyIds, { column: 'id' }) as { data: { id: string; name: string }[] | null }
  const mentionedCompanyIds = parseCompanyMentions(content, allCompanies ?? [])

  const { data: note, error } = await ((opts.insertWith ?? admin) as any)
    .from('company_notes')
    .insert({
      company_id: company.id,
      vehicle_id: entity.vehicleId,
      fund_id: company.fund_id,
      user_id: userId,
      content,
      mentioned_user_ids: mentionedUserIds,
      mentioned_company_ids: mentionedCompanyIds,
    })
    .select('id, content, user_id, created_at')
    .single()
  if (error || !note) return { ok: false, status: 500, error: 'Failed to create note', dbError: error ?? { message: 'Failed to create note' } }

  const author = (members ?? []).find(m => m.user_id === userId)
  const authorName = author?.display_name || null

  // Fire-and-forget: a notification failure must not fail the note.
  void (async () => {
    try {
      const { sendNoteNotifications } = await import('./notify')
      await sendNoteNotifications(admin as any, company.fund_id, {
        id: note.id,
        content: note.content,
        companyId: company.id,
        companyName: company.name,
        vehicleId: entity.vehicleId,
        authorName: authorName || opts.userEmail?.split('@')[0] || 'Someone',
        authorUserId: userId,
        mentionedUserIds,
      })
    } catch (err) {
      console.error('[notes] Failed to send notifications:', err)
    }
  })()

  return { ok: true, note, vehicleId: entity.vehicleId, mentionedUserIds, authorName }
}
