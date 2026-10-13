// Stored document templates: save one, read one back, generate a document from one.
// Printing a generated document is lib/document-templates/pdf.ts, kept apart so the agent tools
// don't pull headless Chromium into every MCP route (lib/pdf-routes.mjs).
//
// The CALLER is the security boundary (the agent dispatcher and the report-link route check
// lp_relations / lp_letters); every query here is still scoped to the fund it is given.

import type { SupabaseClient } from '@supabase/supabase-js'
import { parseTemplate, renderTemplate, HELPER_NAMES, TemplateError } from './engine'

const MAX_DATA_BYTES = 1_000_000

export interface TemplateRow {
  id: string
  name: string
  vehicle: string | null
  instructions: string | null
  body_html: string
  sample_data: unknown
  updated_at: string
}

const db = (admin: SupabaseClient, table: 'document_templates' | 'document_renders') => admin.from(table as any) as any

function requireObject(data: unknown, label: string): Record<string, unknown> {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${label} must be a JSON object`)
  const bytes = Buffer.byteLength(JSON.stringify(data))
  if (bytes > MAX_DATA_BYTES) throw new Error(`${label} is ${Math.round(bytes / 1000)} KB; the limit is ${MAX_DATA_BYTES / 1000} KB`)
  return data as Record<string, unknown>
}

/** A template's syntax, checked before it is stored — and, given sample data, a trial render. */
export function validateTemplate(body: string, sample?: unknown): { warnings: string[] } {
  try {
    const nodes = parseTemplate(body)
    return sample === undefined || sample === null ? { warnings: [] } : { warnings: renderTemplate(nodes, sample).warnings }
  } catch (e) {
    if (e instanceof TemplateError) throw new Error(`Template error: ${e.message}`)
    throw e
  }
}

export async function findTemplate(admin: SupabaseClient, fundId: string, name: string): Promise<TemplateRow | null> {
  const { data, error } = await db(admin, 'document_templates')
    .select('id, name, vehicle, instructions, body_html, sample_data, updated_at')
    .eq('fund_id', fundId)
    .ilike('name', name.replace(/[\\%_]/g, c => `\\${c}`))
    .maybeSingle()
  if (error) throw new Error(error.message)
  return (data as TemplateRow) ?? null
}

export async function listTemplates(admin: SupabaseClient, fundId: string) {
  const { data, error } = await db(admin, 'document_templates')
    .select('id, name, vehicle, instructions, updated_at')
    .eq('fund_id', fundId)
    .order('name')
  if (error) throw new Error(error.message)
  return (data ?? []) as Omit<TemplateRow, 'body_html' | 'sample_data'>[]
}

export async function latestRender(admin: SupabaseClient, fundId: string, templateId: string) {
  const { data } = await db(admin, 'document_renders')
    .select('id, title, data, warnings, created_at')
    .eq('fund_id', fundId)
    .eq('template_id', templateId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return (data as { id: string; title: string; data: unknown; warnings: string[]; created_at: string } | null) ?? null
}

export async function saveTemplate(
  admin: SupabaseClient,
  fundId: string,
  userId: string | null,
  input: { name: string; html: string; instructions?: string | null; sample_data?: unknown; vehicle?: string | null },
) {
  const name = String(input.name ?? '').trim()
  if (!name || name.length > 120) throw new Error('name is required (at most 120 characters)')
  const html = String(input.html ?? '')
  if (!html.trim()) throw new Error('html is required')
  const sample = input.sample_data === undefined || input.sample_data === null ? null : requireObject(input.sample_data, 'sample_data')
  const { warnings } = validateTemplate(html, sample)

  const existing = await findTemplate(admin, fundId, name)
  const row = {
    fund_id: fundId,
    name,
    vehicle: input.vehicle ? String(input.vehicle).slice(0, 200) : null,
    instructions: input.instructions ? String(input.instructions).slice(0, 20_000) : null,
    body_html: html,
    sample_data: sample,
    updated_by: userId,
    updated_at: new Date().toISOString(),
  }
  const q = existing
    ? db(admin, 'document_templates').update(row).eq('id', existing.id).eq('fund_id', fundId)
    : db(admin, 'document_templates').insert({ ...row, created_by: userId })
  const { data, error } = await q.select('id, name, updated_at').single()
  if (error) throw new Error(error.message)
  return { ...(data as { id: string; name: string; updated_at: string }), created: !existing, sample_warnings: warnings }
}

/** Fill a template from data and keep the result, so a link prints exactly this. */
export async function generateDocument(
  admin: SupabaseClient,
  fundId: string,
  userId: string | null,
  input: { template: string; data: unknown; title?: string | null },
) {
  const template = await findTemplate(admin, fundId, String(input.template ?? ''))
  if (!template) throw new Error(`No document template named "${input.template}". Call document_template_get with no name to list them.`)
  const data = requireObject(input.data, 'data')
  let result
  try {
    result = renderTemplate(template.body_html, data)
  } catch (e) {
    if (e instanceof TemplateError) throw new Error(`Template error: ${e.message}`)
    throw e
  }
  const title = String(input.title ?? '').trim().slice(0, 200) || template.name
  const { data: row, error } = await db(admin, 'document_renders')
    .insert({ fund_id: fundId, template_id: template.id, title, data, html: result.html, warnings: result.warnings, created_by: userId })
    .select('id, created_at')
    .single()
  if (error) throw new Error(error.message)
  return { renderId: (row as { id: string }).id, title, template: template.name, warnings: result.warnings }
}

export const TEMPLATE_HELPERS = HELPER_NAMES
