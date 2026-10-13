import { describe, it, expect } from 'vitest'
import { callId, callText, runUntilBlocked } from './assistant-runner'
import { getStageProvider } from './stage-provider'
import { getTool } from '@/lib/accounting/agent-tools'
import { isDraftOnlyCall } from '@/lib/agent/dispatch'

// fund_settings as getStageProvider reads it: web search opted in.
const admin = {
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { memo_agent_web_search_enabled: true } }) }) }) }),
} as any

/** A stand-in stage: three research calls at once, then one that depends on them. */
async function stage() {
  const { provider, model, webSearchAvailable } = await getStageProvider(admin, 'f', 'research')
  const ask = (text: string) => provider.createMessage({ model, maxTokens: 100, system: 'S', content: text, enableWebSearch: webSearchAvailable })
  const parts = await Promise.all(['claims', 'competitors', 'founders'].map(ask))
  const final = await ask(`combine ${parts.map(p => p.text).join(',')}`)
  return { final: final.text, citations: parts[0].webSearchCitations }
}

const id = (text: string) => callId('S', [{ type: 'text', text }])

describe('running a stage on the assistant', () => {
  it('hands over parallel calls together, through the stage\'s own provider', async () => {
    const out = await runUntilBlocked({}, stage, 100)
    expect(out.done).toBe(false)
    if (out.done) return
    expect(out.calls.map(c => callText(c))).toEqual(['claims', 'competitors', 'founders'])
    expect(out.calls.every(c => c.webSearch)).toBe(true)
  })

  it('replays answers, then asks what follows from them', async () => {
    const answers = {
      [id('claims')]: { text: '{"a":1}', sources: [{ url: 'https://x.com', title: 'X' }] },
      [id('competitors')]: { text: '{"b":2}' },
      [id('founders')]: { text: '{"c":3}' },
    }
    const out = await runUntilBlocked(answers, stage, 100)
    expect(out.done).toBe(false)
    if (out.done) return
    expect(out.calls.map(c => callText(c))).toEqual(['combine {"a":1},{"b":2},{"c":3}'])
  })

  it('finishes once every call is answered, with the sources as citations', async () => {
    const answers = {
      [id('claims')]: { text: '{"a":1}', sources: [{ url: 'https://x.com', title: 'X' }] },
      [id('competitors')]: { text: '{"b":2}' },
      [id('founders')]: { text: '{"c":3}' },
      [id('combine {"a":1},{"b":2},{"c":3}')]: { text: '{"done":true}' },
    }
    const out = await runUntilBlocked(answers, stage, 100)
    expect(out).toMatchObject({ done: true, result: { final: '{"done":true}', citations: [{ url: 'https://x.com', title: 'X' }] } })
  })

  it('passes a stage\'s failure through', async () => {
    await expect(runUntilBlocked({}, async () => { throw new Error('no draft') })).rejects.toThrow('no draft')
  })

  it('marks an attachment where it sits in the text', () => {
    const text = callText({ content: [{ type: 'text', text: 'Read this' }, { type: 'document', mediaType: 'application/pdf', data: 'x' }] })
    expect(text).toMatch(/Attachment 1: a PDF/)
  })

  it('leaves the server provider alone outside a run', async () => {
    await expect(getStageProvider(admin, 'f', 'research')).rejects.toThrow()
  })
})

describe('the memo stage tools', () => {
  it('are registered, and running a stage is not staged twice', () => {
    expect(getTool('diligence_stage_next')).toMatchObject({ scope: 'write', domain: 'diligence' })
    expect(getTool('diligence_stage_read')).toMatchObject({ scope: 'read', domain: 'diligence' })
    expect(getTool('diligence_stage_submit')).toMatchObject({ scope: 'write', domain: 'diligence' })
    expect(isDraftOnlyCall({ name: 'diligence_stage_submit' }, {})).toBe(true)
    expect(isDraftOnlyCall({ name: 'diligence_run_agent' }, {})).toBe(false)
  })
})
