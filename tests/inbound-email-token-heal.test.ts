import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { readFileSync } from 'node:fs'
import { encrypt, decrypt } from '@/lib/crypto'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

// A fund whose data key was replaced (saving a Claude key used to do that) has both a working
// plaintext Postmark token and an encrypted copy that no longer decrypts. The route falls back to the
// plaintext and heals the row on a proven delivery; the migration must not erase that fallback
// first (Codex on #137).

const KEK = 'a'.repeat(64)
const OLD_DEK = 'b'.repeat(64)
const NEW_DEK = 'c'.repeat(64)
const s = vi.hoisted(() => ({ m: null as any, runPipeline: vi.fn(async () => {}) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => s.m.admin }))
vi.mock('@/lib/rate-limit', () => ({ rateLimit: async () => null, getClientIp: () => '203.0.113.9' }))
vi.mock('@/lib/pipeline/processEmail', () => ({ runPipeline: s.runPipeline }))
vi.mock('@/lib/pipeline/checkFundMember', () => ({ checkFundMember: async () => null }))
vi.mock('@/lib/pipeline/isAuthorizedSender', () => ({ isAuthorizedSender: async () => true }))
vi.mock('@/lib/security/scan-file', () => ({ scanFileAsync: async () => ({ safe: true }) }))
import { POST } from '@/app/api/inbound-email/route'

beforeEach(() => {
  process.env.ENCRYPTION_KEY = KEK
  s.runPipeline.mockClear()
  s.m = memoryAdmin({
    fund_settings: [{
      fund_id: 'fund-1', postmark_inbound_address: 'inbox@fund.example',
      postmark_webhook_token: 'tok', postmark_webhook_token_encrypted: encrypt('tok', OLD_DEK),
      encryption_key_encrypted: encrypt(NEW_DEK, KEK),
    }],
    app_settings: [],
    inbound_emails: [],
  })
})

const post = (token: string) => POST(new NextRequest('https://app.example/api/inbound-email', {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ From: 'ceo@startup.example', OriginalRecipient: 'inbox@fund.example', Subject: 'Q3 update' }),
}))

describe('a fund whose encrypted Postmark token predates its current data key', () => {
  it('still accepts its token, and heals the row: re-encrypted under the current key, plaintext retired', async () => {
    const res = await post('tok')
    expect(res.status).toBe(200)
    expect(s.runPipeline).toHaveBeenCalledTimes(1)
    const row = s.m.tables.fund_settings[0]
    expect(row.postmark_webhook_token).toBeNull()
    expect(decrypt(row.postmark_webhook_token_encrypted, NEW_DEK)).toBe('tok')
  })

  it('the migration leaves the plaintext token alone', () => {
    const sql = readFileSync('supabase/migrations/20261104150200_unique_inbound_addresses.sql', 'utf8')
    expect(sql).not.toMatch(/set\s+postmark_webhook_token\s*=\s*null/i)
  })
})
