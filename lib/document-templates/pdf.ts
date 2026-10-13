// Print a generated document (document_renders) to PDF. Only the report-link route imports this:
// it reaches headless Chromium, which must ship with that route alone (lib/pdf-routes.mjs).

import type { SupabaseClient } from '@supabase/supabase-js'
import { renderHtmlToPdf } from '@/lib/lp-report-pdf'

/** A stored render, printed. Null when it isn't this fund's. */
export async function renderPdf(admin: SupabaseClient, fundId: string, renderId: string): Promise<{ pdf: Buffer; fileName: string } | null> {
  const { data } = await (admin.from('document_renders' as any) as any)
    .select('title, html')
    .eq('fund_id', fundId)
    .eq('id', renderId)
    .maybeSingle()
  if (!data) return null
  const { title, html } = data as { title: string; html: string }
  const pdf = await renderHtmlToPdf(html, { cssPageSize: true, pageNumbers: true, offline: true })
  const safe = title.replace(/[^a-zA-Z0-9 _.-]/g, '').trim() || 'Document'
  return { pdf, fileName: `${safe}.pdf` }
}

