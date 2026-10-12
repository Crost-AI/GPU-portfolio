import { describe, expect, it } from 'vitest'
import { getTool, accessDomainFor, accessFeatureFor } from '@/lib/accounting/agent-tools'
import { shouldStage } from '@/lib/agent/dispatch'
import { previewToolCall } from '@/lib/agent/tool-call-action'

/** The chat ingest tools: registered as writes, staged from a connected chat, gated like their web routes. */

const oauth = { keyId: 'oauth:abc' }
const key = { keyId: 'key-1' }

describe('chat ingest tools', () => {
  it.each(['submit_company_update', 'record_metric_value', 'create_company', 'add_company_note'])('%s is a write that a connected chat stages', name => {
    const tool = getTool(name)!
    expect(tool, name).toBeTruthy()
    expect(tool.scope).toBe('write')
    expect(shouldStage(tool, {}, oauth)).toBe(true)
    expect(shouldStage(tool, {}, key)).toBe(false)
  })

  it('gates each like its web route', () => {
    expect(accessDomainFor(getTool('submit_company_update')!)).toBe('portfolio')
    expect(accessDomainFor(getTool('record_metric_value')!)).toBe('portfolio')
    expect(accessDomainFor(getTool('create_company')!)).toBe('portfolio')
    expect(accessDomainFor(getTool('add_company_note')!)).toBe('relationships')
    expect(accessFeatureFor(getTool('add_company_note')!)).toBe('notes')
  })

  it("shows the approver an update's files by name and size, never the bytes", async () => {
    const content = Buffer.alloc(2048, 1).toString('base64')
    const preview = await previewToolCall(
      { admin: {} as any, fundId: 'f1', userId: 'u1', access: { vehicles: { all: true } } as any },
      { tool: 'submit_company_update', input: { company: 'Acme', text: 'hello', files: [{ filename: 'deck.pdf', content_base64: content }] } },
    )
    expect(preview.summary).toMatch(/Acme: 1 file \(deck\.pdf\) and 5 characters of text/)
    expect(JSON.stringify(preview.details)).not.toContain(content)
    expect((preview.details as any).input.files).toEqual([{ filename: 'deck.pdf', kb: 2 }])
  })
})
