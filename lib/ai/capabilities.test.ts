import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { AGENT_TOOLS } from '@/lib/accounting/agent-tools'
import { AI_CAPABILITIES, aiCapabilityTable, aiStatus, effectiveAIMode } from './capabilities'

describe('the AI capabilities list', () => {
  it('has unique keys, and every keyless feature says how and which tools', () => {
    const keys = AI_CAPABILITIES.map(c => c.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const c of AI_CAPABILITIES.filter(c => c.keyless === 'assistant' && c.key !== 'portal_analyst')) {
      expect(c.tools?.length, c.key).toBeGreaterThan(0)
      expect(c.prompt, c.key).toBeTruthy()
    }
  })

  it('names only tools the fund MCP server has', () => {
    // A tool named here that does not exist would tell an admin something works without a key
    // that their assistant cannot actually do.
    const names = new Set(AGENT_TOOLS.map(t => t.name))
    for (const c of AI_CAPABILITIES) for (const t of c.tools ?? []) expect(names.has(t), `${c.key}: ${t}`).toBe(true)
  })

  it('is printed verbatim in DOCS.md', () => {
    expect(readFileSync('DOCS.md', 'utf8')).toContain(aiCapabilityTable())
  })
})

describe('effectiveAIMode', () => {
  it('a saved key wins over the recorded choice', () => {
    expect(effectiveAIMode(true, 'assistant')).toBe('server_key')
    expect(effectiveAIMode(true, null)).toBe('server_key')
  })

  it('with no key, only the admin\'s choice counts', () => {
    expect(effectiveAIMode(false, 'assistant')).toBe('assistant')
    expect(effectiveAIMode(false, 'server_key')).toBeNull()
    expect(effectiveAIMode(false, undefined)).toBeNull()
  })

  it('setup_status splits the list into what works and what needs a key', () => {
    const s = aiStatus(false, 'assistant')
    expect(s.mode).toBe('assistant')
    expect(s.worksWithoutKey.length + s.needsKey.length).toBe(AI_CAPABILITIES.length)
  })
})
