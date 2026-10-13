// Server-side helpers for a fund with no server AI key (lib/ai/capabilities.ts explains the model).
// Kept apart from capabilities.ts, which the browser also loads.

import type { SupabaseClient } from '@supabase/supabase-js'
import { AI_CAPABILITIES, hasAnyAIKey } from './capabilities'

/**
 * `processing_error` on an inbound email the pipeline left for the person's assistant: with no key
 * it is saved, not parsed, and stays `pending` (not `failed`) until `inbox_done` records it.
 */
export const AWAITING_ASSISTANT = 'Waiting for your assistant: this fund has no server AI key, so it was saved but not read.'

export function isAwaitingAssistant(processingError: unknown): boolean {
  return typeof processingError === 'string' && processingError.startsWith('Waiting for your assistant')
}

/** Whether the fund has any provider key saved. select('*') so it never depends on a column list. */
export async function fundHasAIKey(admin: SupabaseClient, fundId: string): Promise<boolean> {
  const { data } = await (admin as any).from('fund_settings').select('*').eq('fund_id', fundId).maybeSingle()
  return hasAnyAIKey(data)
}

/**
 * What a feature says when it needs the server's model and the fund has none: read by a person on
 * a web page and by an assistant over MCP alike, so it names both ways forward.
 */
export function noKeyMessage(capabilityKey: string, what: string): string {
  const cap = AI_CAPABILITIES.find(c => c.key === capabilityKey)
  const tools = cap?.tools?.length ? ` with ${cap.tools.join(', ')}` : ''
  return `This fund has no server AI key, so the app can't ${what} itself. ` +
    `Ask your own assistant (Claude or ChatGPT, connected over MCP) to do it${tools}, or add a key in Settings → AI providers.`
}
