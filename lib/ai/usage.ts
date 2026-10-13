import type { TokenUsage } from './types'

type SupabaseAdmin = { from: (table: string) => any }

export async function logAIUsage(admin: SupabaseAdmin, params: {
  fundId: string
  userId?: string
  /** Diligence deal this spend belongs to, when applicable — enables per-deal
   *  token/cost reporting. Left null for non-deal usage. */
  dealId?: string
  provider: string
  model: string
  feature: string
  /** Token usage; omit for non-token usage like audio transcription. */
  usage?: TokenUsage
  /** Audio duration for per-minute-billed usage (Deepgram transcription). */
  audioSeconds?: number
  /** Anthropic web_search tool invocations (~$10 / 1,000), billed on top of tokens. */
  webSearches?: number
}) {
  // The person's own assistant answered (lib/memo-agent/assistant-runner.ts): no server spend.
  if (params.provider === 'assistant') return
  try {
    await admin.from('ai_usage_logs').insert({
      fund_id: params.fundId,
      user_id: params.userId ?? null,
      deal_id: params.dealId ?? null,
      provider: params.provider,
      model: params.model,
      feature: params.feature,
      input_tokens: params.usage?.inputTokens ?? 0,
      output_tokens: params.usage?.outputTokens ?? 0,
      cache_read_tokens: params.usage?.cacheReadTokens ?? 0,
      cache_creation_tokens: params.usage?.cacheCreationTokens ?? 0,
      audio_seconds: params.audioSeconds ?? 0,
      web_searches: params.webSearches ?? 0,
    })
  } catch (err) {
    console.error('[ai-usage] Failed to log usage:', err)
  }
}
