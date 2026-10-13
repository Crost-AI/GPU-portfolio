// Handlers for the inbox tools (./inbox-tools-manifest.ts). Fund-scoped by the caller's fund, and
// company-scoped like company_update_status: a member who sees only some entities sees only the
// updates filed under their companies, and an unfiled one only if they see every company.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { AgentToolContext, AgentToolHandler } from '@/lib/accounting/agent-tools'
import type { AccessContext } from '@/lib/access/effective'
import { visibleCompanyIds } from '@/lib/access/scope'
import { AWAITING_ASSISTANT, isAwaitingAssistant } from '@/lib/ai/keyless'
import { extractAttachmentText, hydrateAttachments, type PostmarkPayload } from '@/lib/parsing/extractAttachmentText'
import { captureCompanyUpdate } from '@/lib/company-updates/capture'

const clamp = (v: unknown, min: number, max: number, fallback: number) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback
}

async function waitingEmail(admin: SupabaseClient, fundId: string, access: AccessContext, id: string) {
  const { data: email } = await (admin as any)
    .from('inbound_emails')
    .select('id, from_address, subject, received_at, company_id, processing_status, processing_error, raw_payload')
    .eq('id', id)
    .eq('fund_id', fundId)
    .maybeSingle()
  const visible = await visibleCompanyIds(admin, access)
  const seen = !!email && (visible === null || (!!email.company_id && visible.includes(email.company_id)))
  if (!seen || email.processing_status !== 'pending' || !isAwaitingAssistant(email.processing_error)) {
    throw new Error('No waiting update with that id. inbox_waiting lists them.')
  }
  return email
}

export const INBOX_HANDLERS: Record<string, AgentToolHandler> = {
  inbox_waiting: async ({ admin, fundId, access }: AgentToolContext, input: any) => {
    const visible = await visibleCompanyIds(admin, access)
    let q = (admin as any)
      .from('inbound_emails')
      .select('id, from_address, subject, received_at, company_id, attachments_count, companies(name)')
      .eq('fund_id', fundId)
      .eq('processing_status', 'pending')
      .eq('processing_error', AWAITING_ASSISTANT)
      .order('received_at', { ascending: true })
      .limit(clamp(input?.limit, 1, 50, 20))
    if (visible !== null) q = q.in('company_id', visible.length ? visible : ['00000000-0000-0000-0000-000000000000'])
    const { data, error } = await q
    if (error) throw new Error('Could not read the inbox.')
    return {
      waiting: ((data ?? []) as any[]).map(e => ({
        email: e.id,
        from: e.from_address,
        subject: e.subject,
        received_at: e.received_at,
        company: (Array.isArray(e.companies) ? e.companies[0]?.name : e.companies?.name) ?? null,
        attachments: e.attachments_count ?? 0,
      })),
    }
  },

  inbox_read: async ({ admin, fundId, access }: AgentToolContext, input: any) => {
    const email = await waitingEmail(admin, fundId, access, String(input?.email ?? ''))
    const budget = clamp(input?.max_chars, 2000, 60_000, 30_000)
    const payload = await hydrateAttachments(email.raw_payload as PostmarkPayload) as PostmarkPayload
    const extracted = await extractAttachmentText(payload)
    let left = budget
    const take = (text: string) => {
      const out = text.slice(0, Math.max(0, left))
      left -= out.length
      return out.length < text.length ? `${out}\n[cut: ${text.length - out.length} more characters]` : out
    }
    return {
      email: email.id,
      from: email.from_address,
      subject: email.subject,
      received_at: email.received_at,
      company_id: email.company_id,
      body: take(extracted.emailBody),
      attachments: extracted.attachments.map(a => ({
        name: a.filename,
        type: a.contentType,
        ...(a.extractedText
          ? { text: take(a.extractedText) }
          : { text: null, note: a.skipped ? (a.skipReason ?? 'Not readable.') : 'A PDF or image: no text was extracted here. Do not guess at its contents.' }),
      })),
    }
  },

  inbox_done: async ({ admin, fundId, access }: AgentToolContext, input: any) => {
    const email = await waitingEmail(admin, fundId, access, String(input?.email ?? ''))
    // Imported here, not at the top: portfolio-tools spreads these handlers into its own map.
    const { resolveCompany } = await import('./portfolio-tools')
    const company = await resolveCompany(admin, fundId, String(input?.company ?? ''), access)
    const recorded = clamp(input?.recorded, 0, 10_000, 0)
    const { error } = await (admin as any)
      .from('inbound_emails')
      .update({
        company_id: company.id,
        routed_to: 'reporting',
        processing_status: recorded > 0 ? 'success' : 'not_processed',
        processing_error: null,
        metrics_extracted: recorded,
      })
      .eq('id', email.id)
      .eq('fund_id', fundId)
    if (error) throw new Error('Could not mark the update as done.')
    // Onto the company's Updates, as the pipeline would have filed it (searchable by get_updates).
    const warnings: string[] = []
    try {
      const payload = await hydrateAttachments(email.raw_payload as PostmarkPayload) as PostmarkPayload
      await captureCompanyUpdate(admin as any, { emailId: email.id, fundId, companyId: company.id, payload: payload as any })
    } catch {
      warnings.push('Marked as done, but it could not be added to the company\'s Updates; reprocess it from the Emails page.')
    }
    return { email: email.id, company: company.name, status: recorded > 0 ? 'success' : 'not_processed', ...(warnings.length ? { warnings } : {}) }
  },
}
