import { describe, expect, it } from 'vitest'
import { signReportLink, verifyReportLink } from '@/lib/agent/report-links'
import { resourcePathFor, PORTAL_MCP_PATH, FUND_MCP_PATH } from '@/lib/oauth/metadata'
import { lpGrantableScope } from '@/lib/portal/principal'

process.env.ENCRYPTION_KEY ??= 'test-key-for-report-links-0123456789'

describe('investor connector plumbing', () => {
  it("signs and verifies the investor's own statement link", () => {
    const { token } = signReportLink({ fundId: 'f1', userId: 'u1', kind: 'portal_statement', args: {} })
    expect(verifyReportLink(token)?.kind).toBe('portal_statement')
  })

  it('describes the investor endpoint only when it is the probed path', () => {
    expect(resourcePathFor('api/portal/mcp')).toBe(PORTAL_MCP_PATH)
    expect(resourcePathFor('/api/portal/mcp')).toBe(PORTAL_MCP_PATH)
    expect(resourcePathFor('api/mcp')).toBe(FUND_MCP_PATH)
    expect(resourcePathFor(null)).toBe(FUND_MCP_PATH)
    expect(resourcePathFor('api/portal/mcpx')).toBe(FUND_MCP_PATH)
  })

  it('grants an investor read, or read and act, never more', () => {
    expect(lpGrantableScope('read write admin')).toBe('read write')
    expect(lpGrantableScope('read')).toBe('read')
    expect(lpGrantableScope(null)).toBe('read')
  })
})
