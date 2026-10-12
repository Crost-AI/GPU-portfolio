import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A company update handed over from chat runs the emailed-update pipeline: recorded as an inbound
 * email routed to reporting, files scanned before they are stored, an unsafe file never reaching
 * extraction, and the result read back from what the pipeline wrote.
 */

const runPipeline = vi.fn(async (..._a: unknown[]) => {})
const scanFileAsync = vi.fn(async (_b: Buffer, name: string) => (name.startsWith('bad') ? { safe: false, reason: 'executable content' } : { safe: true }))
vi.mock('@/lib/pipeline/processEmail', () => ({ runPipeline: (...a: unknown[]) => runPipeline(...a) }))
vi.mock('@/lib/security/scan-file', () => ({ scanFileAsync: (b: Buffer, n: string) => scanFileAsync(b, n) }))

import { parseUpdateFiles, submitCompanyUpdate } from '@/lib/company-updates/submit'

const inserts: any[] = []
const updates: any[] = []
const uploads: string[] = []
function admin(): any {
  return {
    auth: { admin: { getUserById: async () => ({ data: { user: { email: 'gp@firm.com' } } }) } },
    storage: { from: () => ({ upload: async (path: string) => { uploads.push(path); return { error: null } } }) },
    from(table: string) {
      const q: any = {
        insert: (row: any) => { inserts.push({ table, row }); return q },
        update: (row: any) => { updates.push({ table, row }); return q },
        select: () => q,
        eq: () => q,
        single: async () => ({ data: { id: 'email-1' }, error: null }),
        maybeSingle: async () => ({ data: table === 'inbound_emails' ? { processing_status: 'success', companies: { id: 'co-1', name: 'Acme' }, processing_error: null } : null }),
        then: (res: any) => res({ data: table === 'metric_values' ? [{ period_label: 'Q3 2026', value_number: 120000, metrics: { name: 'MRR' } }] : [] }),
      }
      return q
    },
  }
}

const deps = (over: Record<string, unknown> = {}) => ({
  admin: admin(), fundId: 'fund-1', userId: 'u1', access: {} as any, origin: 'https://fund.example.com',
  resolveCompany: async (ref: string) => ({ id: 'co-1', name: ref }),
  ...over,
})
const b64 = (s: string) => Buffer.from(s).toString('base64')

beforeEach(() => { vi.clearAllMocks(); inserts.length = 0; updates.length = 0; uploads.length = 0 })

describe('submitCompanyUpdate', () => {
  it('records it as a reporting email for the named company and runs the pipeline on it', async () => {
    const r = await submitCompanyUpdate(deps(), { company: 'Acme', text: 'MRR was $120k in Q3.' })
    const row = inserts.find(i => i.table === 'inbound_emails').row
    expect(row).toMatchObject({ fund_id: 'fund-1', routed_to: 'reporting', company_id: 'co-1', from_address: 'gp@firm.com' })
    const [, emailId, fundId, payload, member, options] = runPipeline.mock.calls[0] as any[]
    expect([emailId, fundId, member, options]).toEqual(['email-1', 'fund-1', { userId: 'u1' }, { forcedRoute: 'reporting' }])
    expect(payload.TextBody).toBe('MRR was $120k in Q3.')
    expect(r.metricsRecorded).toEqual([{ metric: 'MRR', period: 'Q3 2026', value: 120000 }])
    expect(r.url).toBe('https://fund.example.com/emails/email-1')
  })

  it('scans files before storing them, and keeps an unsafe one away from extraction', async () => {
    const r = await submitCompanyUpdate(deps(), {
      company: 'Acme',
      files: [{ filename: 'deck.pdf', content_base64: b64('%PDF-1.4 ok') }, { filename: 'bad.pdf', content_base64: b64('MZ...') }],
    })
    expect(uploads).toEqual(['email-1/0_deck.pdf'])
    const payload = (runPipeline.mock.calls[0] as any[])[3]
    expect(payload.Attachments[0].Content).toBeTruthy()
    expect(payload.Attachments[1].Content).toBeUndefined()
    expect(payload.Attachments[1].ContentError).toMatch(/Safety scan failed/)
    expect(r.warnings.join(' ')).toMatch(/bad\.pdf was refused/)
  })

  it('needs something to process', async () => {
    await expect(submitCompanyUpdate(deps(), { company: 'Acme' })).rejects.toThrow(/text, as files, or both/)
    expect(inserts).toHaveLength(0)
  })

  it('lets the pipeline identify the company when none is named', async () => {
    await submitCompanyUpdate(deps(), { text: 'Q3 update' })
    expect(inserts[0].row.company_id).toBeNull()
  })
})

describe('parseUpdateFiles', () => {
  it('refuses unsupported types, oversized files and too many files, before anything is written', () => {
    expect(() => parseUpdateFiles([{ filename: 'run.exe', content_base64: b64('x') }])).toThrow(/send a PDF/)
    expect(() => parseUpdateFiles([{ filename: 'big.pdf', content_base64: Buffer.alloc(3 * 1024 * 1024 + 1).toString('base64') }])).toThrow(/over 3 MB/)
    expect(() => parseUpdateFiles(Array.from({ length: 6 }, (_, i) => ({ filename: `f${i}.pdf`, content_base64: b64('x') })))).toThrow(/At most 5/)
  })

  it('accepts a data URL prefix and cleans the file name', () => {
    const [f] = parseUpdateFiles([{ filename: '../q3/kpis.xlsx', content_base64: `data:application/octet-stream;base64,${b64('sheet')}` }])
    expect(f.name).not.toContain('..')
    expect(f.type).toMatch(/spreadsheetml/)
    expect(f.bytes.toString()).toBe('sheet')
  })
})
