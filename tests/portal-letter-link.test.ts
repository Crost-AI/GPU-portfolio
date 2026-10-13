import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * The investor connector's letter PDF link: checked at the click the way the portal's own letter
 * PDF route checks it, and only for the fund the connection is bound to.
 */

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-key-for-report-links'

let connectorOn = true
let principal: any = { userId: 'u1', lpAccountId: 'acct-1', investorIds: ['inv-1'] }
let share: any = { fundId: 'fund-1', sharedInvestorIds: ['inv-1'] }
const letterPdf = vi.fn(async () => ({ pdf: Buffer.from('%PDF-letter'), fileName: 'Q3 2026 Letter.pdf' }))
const logged = vi.fn()

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/rate-limit', () => ({ rateLimit: async () => null }))
vi.mock('@/lib/lp-access-log', () => ({ logLpAccessEvent: (...a: unknown[]) => logged(...a) }))
vi.mock('@/lib/portal/principal', () => ({
  lpConnectorEnabled: async () => connectorOn,
  connectorPrincipal: async () => principal,
}))
vi.mock('@/lib/portal/service', async importOriginal => {
  const real = await importOriginal<typeof import('@/lib/portal/service')>()
  return {
    ...real,
    portalLetterShare: async () => { if (!share) throw new real.PortalError(404, 'Not found'); return share },
  }
})
vi.mock('@/lib/lp-report-pdf', () => ({ generateLetterPdf: (...a: unknown[]) => (letterPdf as any)(...a) }))

import { GET } from '@/app/api/agent/reports/[token]/route'
import { signReportLink } from '@/lib/agent/report-links'

const link = () => signReportLink({ fundId: 'fund-1', userId: 'u1', kind: 'portal_letter', args: { letter: 'l1' } }).token
const open = (token: string) => GET(new NextRequest(`https://fund.test/api/agent/reports/${token}`), { params: Promise.resolve({ token }) })

beforeEach(() => {
  connectorOn = true
  principal = { userId: 'u1', lpAccountId: 'acct-1', investorIds: ['inv-1'] }
  share = { fundId: 'fund-1', sharedInvestorIds: ['inv-1'] }
  vi.clearAllMocks()
})

describe('a letter link', () => {
  it('opens the shared letter and logs the download', async () => {
    const res = await open(link())
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(letterPdf).toHaveBeenCalledWith(expect.anything(), { fundId: 'fund-1', letterId: 'l1' })
    expect(logged).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'download', targetType: 'letter', targetId: 'l1' }))
  })

  it('opens nothing once the letter is unshared, the connector is off, or the investor has left', async () => {
    share = null
    expect((await open(link())).status).toBe(404)
    share = { fundId: 'fund-1', sharedInvestorIds: ['inv-1'] }
    connectorOn = false
    expect((await open(link())).status).toBe(404)
    connectorOn = true
    principal = null
    expect((await open(link())).status).toBe(404)
    expect(letterPdf).not.toHaveBeenCalled()
  })

  it("will not open another fund's letter through this connection", async () => {
    share = { fundId: 'fund-2', sharedInvestorIds: ['inv-1'] }
    expect((await open(link())).status).toBe(404)
    expect(letterPdf).not.toHaveBeenCalled()
  })
})
