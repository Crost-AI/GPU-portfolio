import { describe, it, expect } from 'vitest'
import { AWAITING_ASSISTANT, isAwaitingAssistant, noKeyMessage } from './keyless'
import { updateInboundDeal } from '@/lib/deals/service'
import { getTool } from '@/lib/accounting/agent-tools'
import { PROMPT_TEMPLATES } from '@/lib/agent/getting-started'

describe('keyless helpers', () => {
  it('recognise an email left for the assistant, and nothing else', () => {
    expect(isAwaitingAssistant(AWAITING_ASSISTANT)).toBe(true)
    expect(isAwaitingAssistant('Claude API error')).toBe(false)
    expect(isAwaitingAssistant(null)).toBe(false)
  })

  it('say what to do instead, naming the tools from the capabilities list', () => {
    const m = noKeyMessage('bank_categorize', 'categorise transactions')
    expect(m).toMatch(/no server AI key/)
    expect(m).toMatch(/set_bank_transaction_account/)
    expect(m).toMatch(/Settings → AI providers/)
  })
})

describe('the inbox an assistant clears', () => {
  it('is three portfolio tools and a prompt that walks them', () => {
    expect(getTool('inbox_waiting')).toMatchObject({ scope: 'read' })
    expect(getTool('inbox_read')).toMatchObject({ scope: 'read' })
    expect(getTool('inbox_done')).toMatchObject({ scope: 'write' })
    const prompt = PROMPT_TEMPLATES.find(p => p.name === 'process_inbox')!
    const text = prompt.text({})
    for (const tool of ['inbox_waiting', 'inbox_read', 'record_metric_value', 'inbox_done']) expect(text).toContain(tool)
  })
})

describe('writing a deal\'s analysis back', () => {
  it('refuses a thesis fit the table does not allow, before touching the database', async () => {
    const admin = new Proxy({}, { get: () => { throw new Error('no database expected') } }) as any
    const out = await updateInboundDeal(admin, { fundId: 'f' } as any, 'd', { analysis: { thesisFitScore: 'great' } })
    expect(out).toMatchObject({ ok: false })
  })
})
