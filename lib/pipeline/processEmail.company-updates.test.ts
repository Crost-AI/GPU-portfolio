import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  hasKey: true as boolean | undefined,
  events: [] as string[],
  captureCompanyUpdate: vi.fn(async () => {
    mocks.events.push('capture')
    return 'update-1'
  }),
  removeCompanyUpdate: vi.fn(async () => {
    mocks.events.push('remove')
  }),
  updateCompanyUpdatePeriod: vi.fn(async () => undefined),
}))

vi.mock('@/lib/company-updates/capture', () => ({
  captureCompanyUpdate: mocks.captureCompanyUpdate,
  removeCompanyUpdate: mocks.removeCompanyUpdate,
  updateCompanyUpdatePeriod: mocks.updateCompanyUpdatePeriod,
}))

vi.mock('@/lib/parsing/extractAttachmentText', () => ({
  extractAttachmentText: vi.fn(async () => ({ emailBody: 'Reporting evidence', attachments: [] })),
}))

// A fund with a server key. With none, the pipeline saves the email for the person's assistant
// instead (lib/ai/keyless.ts), which the test below pins.
vi.mock('@/lib/ai/keyless', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/ai/keyless')>()),
  fundHasAIKey: vi.fn(async () => mocks.hasKey ?? true),
}))

vi.mock('@/lib/ai/feature-provider', () => ({
  getFeatureProvider: vi.fn(async () => ({ provider: {}, providerType: 'test', model: 'test-model' })),
}))

import { runPipeline, type PostmarkPayload } from './processEmail'
import { AWAITING_ASSISTANT } from '@/lib/ai/keyless'

describe('runPipeline Company Updates boundary', () => {
  beforeEach(() => {
    mocks.events.length = 0
    mocks.captureCompanyUpdate.mockClear()
    mocks.removeCompanyUpdate.mockClear()
    mocks.updateCompanyUpdatePeriod.mockClear()
  })

  it('captures an identified reporting email before checking configured metrics', async () => {
    const supabase = fakePipelineDatabase()
    const payload: PostmarkPayload = {
      From: 'founder@acme.test',
      To: 'updates@fund.test',
      Subject: 'August update',
      TextBody: 'Reporting evidence',
    }

    await runPipeline(supabase as any, 'email-1', 'fund-1', payload, null, { forcedRoute: 'reporting' })

    expect(mocks.events.slice(0, 2)).toEqual(['capture', 'metrics'])
    expect(mocks.captureCompanyUpdate).toHaveBeenCalledWith(supabase, {
      emailId: 'email-1',
      fundId: 'fund-1',
      companyId: 'company-1',
      payload,
    })
  })

  it('with no server AI key, saves a reporting email for the assistant instead of failing it', async () => {
    mocks.hasKey = false
    const updates: Record<string, unknown>[] = []
    const supabase = fakePipelineDatabase(updates)
    try {
      await runPipeline(supabase as any, 'email-3', 'fund-1', { From: 'f@acme.test', To: 'u@fund.test', TextBody: 'Q3' }, null, { forcedRoute: 'reporting' })
    } finally {
      mocks.hasKey = true
    }
    expect(updates.at(-1)).toMatchObject({ processing_status: 'pending', processing_error: AWAITING_ASSISTANT })
    expect(mocks.captureCompanyUpdate).not.toHaveBeenCalled()
  })

  it('removes the projection and does not capture an interactions email', async () => {
    const supabase = fakePipelineDatabase()
    await runPipeline(
      supabase as any,
      'email-2',
      'fund-1',
      { From: 'member@fund.test', To: 'updates@fund.test', TextBody: 'Meeting follow-up' },
      null,
      { forcedRoute: 'interactions' },
    )

    expect(mocks.removeCompanyUpdate).toHaveBeenCalledWith(supabase, { emailId: 'email-2', fundId: 'fund-1' })
    expect(mocks.captureCompanyUpdate).not.toHaveBeenCalled()
  })
})

function fakePipelineDatabase(updates: Record<string, unknown>[] = []) {
  return {
    from(table: string) {
      if (table === 'inbound_emails') {
        return {
          update: (row: Record<string, unknown>) => { updates.push(row); return chain({ data: null, error: null }) },
          select: () => chain({ data: { company_id: 'company-1' }, error: null }),
        }
      }
      if (table === 'companies') {
        return {
          select: () => chain({ data: [{ id: 'company-1', name: 'Acme', aliases: [] }], error: null }),
        }
      }
      if (table === 'metrics') {
        mocks.events.push('metrics')
        return {
          select: () => chain({ data: [], error: null }),
        }
      }
      if (table === 'fund_settings') {
        return {
          select: () => chain({ data: null, error: null }),
        }
      }
      throw new Error(`Unexpected table ${table}`)
    },
  }
}

function chain(result: any) {
  const query: any = {
    eq: () => query,
    order: () => query,
    single: async () => result,
    maybeSingle: async () => result,
    then: (resolve: (value: any) => unknown, reject: (error: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  }
  return query
}
