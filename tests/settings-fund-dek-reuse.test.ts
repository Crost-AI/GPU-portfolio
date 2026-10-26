import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { randomBytes } from 'crypto'
import { encrypt, decrypt } from '@/lib/crypto'

// Every secret in fund_settings is encrypted under the fund's ONE data key. Saving the Claude key
// used to mint a fresh key and store it, which left every other secret (the Postmark webhook token,
// Drive, the other providers' keys) encrypted under a key that no longer existed.

const KEK = randomBytes(32).toString('hex')

const m = vi.hoisted(() => ({
  storedDek: null as string | null,
  updates: [] as Record<string, unknown>[],
}))

function chain(table: string) {
  let op: 'select' | 'update' = 'select'
  let row: any = null
  const c: any = {
    select: () => c,
    eq: () => c,
    update: (r: any) => { op = 'update'; row = r; return c },
    maybeSingle: async () => ({ data: table === 'fund_members' ? { fund_id: 'f1', role: 'admin' } : null, error: null }),
    single: async () => ({ data: table === 'fund_settings' ? { encryption_key_encrypted: m.storedDek } : null, error: null }),
    then: (res: any) => {
      if (op === 'update' && table === 'fund_settings') m.updates.push(row)
      return res({ data: null, error: null })
    },
  }
  return c
}

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: (t: string) => chain(t) }) }))
vi.mock('@/lib/api-helpers', () => ({ assertWriteAccess: async () => null }))
vi.mock('@/lib/cache/tags', () => ({ expireTag: () => {} }))
vi.mock('@/lib/activity', () => ({ logActivity: () => {} }))
vi.mock('@/lib/cache/layout', () => ({ getUpdateAvailable: async () => false }))

import { PATCH } from '@/app/api/settings/route'

const patch = (body: unknown) => PATCH(new Request('http://x/api/settings', { method: 'PATCH', body: JSON.stringify(body) }) as any)
const saved = () => Object.assign({}, ...m.updates) as Record<string, string>

let prevKek: string | undefined
beforeEach(() => {
  prevKek = process.env.ENCRYPTION_KEY
  process.env.ENCRYPTION_KEY = KEK
  m.updates = []
  m.storedDek = null
})
afterEach(() => { process.env.ENCRYPTION_KEY = prevKek })

describe('PATCH /api/settings keeps the fund on one data key', () => {
  it('encrypts a new Claude key under the stored data key, and leaves that key in place', async () => {
    const dek = randomBytes(32).toString('hex')
    m.storedDek = encrypt(dek, KEK)

    const res = await patch({ claudeApiKey: 'claude-test-key' })
    expect(res.status).toBe(200)
    const row = saved()
    expect(row).not.toHaveProperty('encryption_key_encrypted')
    expect(decrypt(row.claude_api_key_encrypted, dek)).toBe('claude-test-key')
  })

  it('mints one data key for a fund that has none, and uses it for every secret in the save', async () => {
    const res = await patch({ claudeApiKey: 'claude-test-key', googleClientSecret: 'drive-test-secret', openaiApiKey: 'openai-test-key' })
    expect(res.status).toBe(200)
    const row = saved()
    const dek = decrypt(row.encryption_key_encrypted, KEK)
    expect(decrypt(row.claude_api_key_encrypted, dek)).toBe('claude-test-key')
    expect(decrypt(row.google_client_secret_encrypted, dek)).toBe('drive-test-secret')
    expect(decrypt(row.openai_api_key_encrypted, dek)).toBe('openai-test-key')
  })
})
