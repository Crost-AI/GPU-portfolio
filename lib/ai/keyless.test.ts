import { describe, it, expect } from 'vitest'
import { AWAITING_ASSISTANT, isAwaitingAssistant, noKeyMessage } from './keyless'
import { parseResearch, updateInboundDeal } from '@/lib/deals/service'
import { suppliedTextEngine } from '@/lib/company-updates/ocr'
import { toolResult } from '@/lib/mcp-apps/server'
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
    for (const tool of ['inbox_waiting', 'inbox_read', 'record_metric_value', 'inbox_done', 'stage_run', 'ocr_waiting', 'ocr_page', 'ocr_save_text']) {
      expect(text).toContain(tool)
    }
  })
})

describe('writing a deal\'s analysis back', () => {
  it('refuses a thesis fit the table does not allow, before touching the database', async () => {
    const admin = new Proxy({}, { get: () => { throw new Error('no database expected') } }) as any
    const out = await updateInboundDeal(admin, { fundId: 'f' } as any, 'd', { analysis: { thesisFitScore: 'great' } })
    expect(out).toMatchObject({ ok: false })
  })
})

describe('the gap tools', () => {
  it('are registered with the scope their work needs', () => {
    expect(getTool('ocr_waiting')).toMatchObject({ scope: 'read' })
    expect(getTool('ocr_page')).toMatchObject({ scope: 'read' })
    expect(getTool('ocr_save_text')).toMatchObject({ scope: 'write' })
    expect(getTool('company_save_summary')).toMatchObject({ scope: 'write' })
    expect(getTool('diligence_document_text')).toMatchObject({ scope: 'read' })
  })

  it('pass an assistant\'s transcription through the OCR engine, page by page', async () => {
    const pdf = suppliedTextEngine({ pages: { 1: 'Revenue $1.2M', 3: 'Churn 2%' } })
    expect(await pdf.transcribePdfPages(Buffer.alloc(0), [1, 2, 3])).toEqual({ 1: 'Revenue $1.2M', 3: 'Churn 2%' })
    expect(await suppliedTextEngine({ text: 'KPI sheet' }).transcribeImage(Buffer.alloc(0), 'image/png')).toBe('KPI sheet')
  })

  it('send an image to the model as an image, not as JSON', () => {
    const image = { type: 'image' as const, data: 'aGk=', mimeType: 'image/png' }
    expect(toolResult({ name: 'ocr_page' } as any, { mcpContent: [{ type: 'text', text: 'Page 1 of 3' }, image] }))
      .toEqual({ content: [{ type: 'text', text: 'Page 1 of 3' }, image] })
  })
})

describe('research an assistant ran', () => {
  it('is stored in the research job\'s shape, with its sources', () => {
    const out = parseResearch({
      summary: ' Founders check out. ',
      findings: { founder_background: 'Ex-Stripe', red_flags: ['', 'Cap table messy'], extra: 'dropped' },
      sources: [{ url: 'https://example.com/a', title: 'A' }, 'https://example.com/b', { url: 'javascript:alert(1)' }],
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.value).toMatchObject({
      research_status: 'done',
      research_summary: 'Founders check out.',
      research_error: null,
      research_sources: [{ url: 'https://example.com/a', title: 'A' }, { url: 'https://example.com/b', title: '' }],
    })
    expect(out.value.research_findings).toEqual({
      founder_background: 'Ex-Stripe', traction_corroboration: '', market_context: '',
      prior_companies: [], red_flags: ['Cap table messy'], open_questions: [],
    })
  })

  it('is refused without a summary or a source', () => {
    expect(parseResearch({ summary: '', sources: ['https://x.com'] })).toMatchObject({ ok: false })
    expect(parseResearch({ summary: 'Looks fine', sources: [] })).toMatchObject({ ok: false, error: expect.stringMatching(/sources/) })
  })
})
