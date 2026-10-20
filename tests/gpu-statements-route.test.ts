import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureVisibilityMap } from '@/lib/types/features'
import type { AccessContext } from '@/lib/access/effective'

/**
 * GET /api/accounting/statements asks the package for the accrued profit-share memo only for a
 * caller with gp_economics; the statements export (workbook, PDF) never asks.
 */

const FEATURES: FeatureVisibilityMap = { ...DEFAULT_FEATURE_VISIBILITY, accounting: 'everyone', gp_economics: 'everyone' }
const access = (grants: AccessContext['grants']): AccessContext => ({
  fundId: 'f1', userId: 'u1', role: 'member', vehicles: { all: true, ids: [] }, features: FEATURES, grants, defaults: {},
})
const mocks = vi.hoisted(() => ({ access: null as any, build: vi.fn() }))

vi.mock('@/lib/supabase/server', () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/api-helpers', () => ({ assertReadAccess: async () => ({ fundId: 'f1', userId: 'u1', role: 'member', need: 'read' }) }))
vi.mock('@/lib/accounting/http-vehicle', () => ({ resolveGroupOr400: async (_a: unknown, _g: unknown, name: string | null) => name }))
vi.mock('@/lib/access/effective', async orig => ({ ...(await orig<typeof import('@/lib/access/effective')>()), loadAccessContext: async () => mocks.access }))
vi.mock('@/lib/accounting/statement-package', async orig => ({
  ...(await orig<typeof import('@/lib/accounting/statement-package')>()),
  buildStatementPackage: (...args: unknown[]) => { mocks.build(...args); return Promise.resolve({ payload: { ok: true } }) },
}))

import { GET } from '@/app/api/accounting/statements/route'

const get = () => GET(new NextRequest('http://x/api/accounting/statements?group=GPU%20SPV%20I&preset=ytd'))
beforeEach(() => vi.clearAllMocks())

describe('the statements route and the accrued profit-share memo', () => {
  it('asks for it for a caller with gp_economics', async () => {
    mocks.access = access({ accounting: 'read', gp_economics: 'read' })
    expect((await get()).status).toBe(200)
    expect(mocks.build.mock.calls[0][4]).toEqual({ accruedMemo: true })
  })

  it('does not for a caller without it', async () => {
    mocks.access = access({ accounting: 'write' })
    await get()
    expect(mocks.build.mock.calls[0][4]).toEqual({ accruedMemo: false })
  })

  it('the export route never asks (an export or PDF can go to investors)', async () => {
    const src = (await import('node:fs')).readFileSync('app/api/accounting/statements/export/route.ts', 'utf8')
    expect(src).not.toMatch(/accruedMemo/)
  })
})

describe('the memo never reaches the K-1 data or any booked figure', () => {
  const files = (dir: string): string[] => {
    const fs = require('node:fs') as typeof import('node:fs')
    const path = require('node:path') as typeof import('node:path')
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => d.isDirectory() ? files(path.join(dir, d.name)) : /\.tsx?$/.test(d.name) && !/\.test\./.test(d.name) ? [path.join(dir, d.name)] : [])
  }
  it('no tax, K-1, report or close loader asks for it', () => {
    const fs = require('node:fs') as typeof import('node:fs')
    for (const f of [...files('lib/tax'), ...files('lib/reports'), 'lib/accounting/close.ts', 'lib/accounting/book-tax.ts']) {
      expect(fs.readFileSync(f, 'utf8'), f).not.toMatch(/accruedMemo|accruedProfitShare/)
    }
  })

  it('the memo modules write nothing: no journal, no insert', () => {
    const fs = require('node:fs') as typeof import('node:fs')
    for (const f of ['lib/gpu/accrued.ts', 'lib/gpu/book-nav.ts', 'lib/gpu/letter.ts', 'lib/gpu/fleet-schedule.ts', 'app/api/accounting/accrued-profit-share/route.ts']) {
      expect(fs.readFileSync(f, 'utf8'), f).not.toMatch(/journal_|\.insert\(|\.update\(|\.upsert\(|persistEntry/)
    }
  })
})
