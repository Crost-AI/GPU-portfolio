// Running a memo-agent stage on the person's own assistant instead of the server's model.
//
// Every stage reaches a model through one door, getStageProvider (stage-provider.ts). Inside
// runUntilBlocked that door hands out a ReplayProvider: a model call it already has an answer for
// returns that answer, and one it doesn't is recorded and never returns. Once the stage has gone
// quiet with calls outstanding, those calls are the questions for the assistant. When the answers
// come back, the stage runs again from the start and replays them, so the stage code (its prompts,
// its parsing, where it stores the result) is the same code the worker runs with a key.
//
// That relies on a stage asking the same thing twice when nothing changed, which it does: a call is
// identified by a hash of its system prompt and content. If the data room changes between runs,
// the changed calls simply get new ids and are asked again.

import { AsyncLocalStorage } from 'node:async_hooks'
import crypto from 'crypto'
import type { AIProvider, AIResult, ContentBlock, CreateMessageParams } from '@/lib/ai/types'

/** The provider type usage logging skips, and the external_job_id marking a job the assistant runs. */
export const ASSISTANT_RUNNER = 'assistant'

/** An answer the assistant gave to one call. `sources` are the pages it read, for the research stage. */
export interface AssistantAnswer {
  text: string
  sources?: { url: string; title: string }[]
}

/** One model call the stage is waiting on. */
export interface AssistantCall {
  id: string
  system: string
  content: ContentBlock[]
  maxTokens: number
  webSearch: boolean
}

export function callId(system: string, content: ContentBlock[]): string {
  return crypto.createHash('sha256').update(JSON.stringify([system, content])).digest('hex').slice(0, 16)
}

export class ReplayProvider implements AIProvider {
  readonly pending = new Map<string, AssistantCall>()
  readonly used = new Set<string>()
  lastCallAt = Date.now()

  constructor(private readonly answers: Record<string, AssistantAnswer>) {}

  createMessage(p: CreateMessageParams): Promise<AIResult> {
    const content: ContentBlock[] = typeof p.content === 'string' ? [{ type: 'text', text: p.content }] : p.content
    const system = p.system ?? ''
    const id = callId(system, content)
    this.lastCallAt = Date.now()
    const answer = this.answers[id]
    if (answer) {
      this.used.add(id)
      const sources = answer.sources ?? []
      return Promise.resolve({
        text: answer.text,
        usage: { inputTokens: 0, outputTokens: 0 },
        truncated: false,
        ...(p.enableWebSearch ? { webSearchCount: sources.length, webSearchCitations: sources } : {}),
      })
    }
    this.pending.set(id, { id, system, content, maxTokens: p.maxTokens, webSearch: !!p.enableWebSearch })
    // Never settles: the stage waits here until its answer exists, on a later run.
    return new Promise<AIResult>(() => {})
  }

  createChat(): Promise<AIResult> {
    return Promise.reject(new Error('The memo agent does not use chat calls.'))
  }
  async testConnection(): Promise<void> {}
  async listModels() { return [] }
}

const current = new AsyncLocalStorage<ReplayProvider>()

/** The replay provider when a stage is running for the assistant, otherwise null. */
export function assistantProvider(): ReplayProvider | null {
  return current.getStore() ?? null
}

export type RunOutcome<T> =
  | { done: true; result: T; provider: ReplayProvider }
  | { done: false; calls: AssistantCall[]; provider: ReplayProvider }

/**
 * Run `fn` until it finishes or is waiting on calls nobody has answered. "Waiting" is a quiet
 * period with calls outstanding: parallel calls (research's three, ingest's five at a time) are all
 * made within moments of each other, so they are handed over together.
 */
export async function runUntilBlocked<T>(
  answers: Record<string, AssistantAnswer>, fn: () => Promise<T>, quietMs = 400,
): Promise<RunOutcome<T>> {
  const provider = new ReplayProvider(answers)
  let timer: ReturnType<typeof setTimeout> | undefined
  const blocked = new Promise<'blocked'>(resolve => {
    const tick = () => {
      if (provider.pending.size > 0 && Date.now() - provider.lastCallAt >= quietMs) return resolve('blocked')
      timer = setTimeout(tick, 50)
    }
    timer = setTimeout(tick, 50)
  })
  try {
    const run = current.run(provider, fn).then(result => ({ result }))
    const first = await Promise.race([run, blocked])
    if (first === 'blocked') return { done: false, calls: [...provider.pending.values()], provider }
    return { done: true, result: first.result, provider }
  } finally {
    clearTimeout(timer)
  }
}

/** The text a call carries, with each attachment marked where it sits. */
export function callText(call: Pick<AssistantCall, 'content'>): string {
  return call.content.map((b, i) => b.type === 'text'
    ? b.text
    : `[Attachment ${i}: ${b.type === 'document' ? 'a PDF' : 'an image'} (${b.mediaType}). View it with diligence_stage_read, passing this call_id and attachment: ${i}.]`,
  ).join('\n\n')
}

/** Attachments in a call: index into its content and type. */
export function callAttachments(call: Pick<AssistantCall, 'content'>): { index: number; mediaType: string }[] {
  return call.content.flatMap((b, index) => (b.type === 'text' ? [] : [{ index, mediaType: b.mediaType }]))
}
