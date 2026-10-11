import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { safeNextPath } from '@/lib/safe-redirect'
import { encrypt } from '@/lib/crypto'
import { consumeGoogleOAuthTransaction, createGoogleOAuthTransaction } from '@/lib/google/oauth-state'

/**
 * The Google Drive connect flow and the OTP post-login hop both redirect to a caller-chosen path
 * right after authentication. They used `startsWith('/') && !startsWith('//')`, which
 * `/\evil.example/x` passes — and new URL('/\\evil.example/x', base) is https://evil.example/x.
 */

describe('safeNextPath — encoded and whitespace escapes', () => {
  it.each([
    '/\\evil.example/x',
    '/%2f%2fevil.example',
    '/%2F%2Fevil.example',
    '/%2fevil.example',
    '/%5cevil.example',
    '/%5Cevil.example',
    '/%252f%252fevil.example',
    '/%09/evil.example',
    '/\t/evil.example',
    '/\n/evil.example',
    '/\r/evil.example',
    '/%0a/evil.example',
    '/%',
  ])('rejects %s', raw => {
    expect(safeNextPath(raw)).toBeNull()
  })

  it.each([
    '/settings',
    '/settings?tab=integrations',
    '/deals/a%2fb',
    '/oauth/authorize?redirect_uri=https%3A%2F%2Fclaude.ai%2Fcb',
  ])('keeps %s', raw => {
    expect(safeNextPath(raw)).toBe(raw)
  })
})

describe('Google OAuth transaction returnTo', () => {
  const key = '22'.repeat(32)

  it('create() never stores an escaping returnTo', () => {
    const created = createGoogleOAuthTransaction({
      encryptionKey: key, fundId: 'f', returnTo: '/\\evil.example/x', userId: 'u', now: 1,
    })
    const consumed = consumeGoogleOAuthTransaction({ cookie: created.cookie, encryptionKey: key, state: created.state, userId: 'u', now: 2 })
    expect(consumed?.returnTo).toBe('/settings')
  })

  it('consume() rejects a cookie whose returnTo escapes the origin', () => {
    const cookie = encrypt(JSON.stringify({
      nonce: 'n', verifier: 'v', userId: 'u', fundId: 'f', returnTo: '/\\evil.example/x', expiresAt: 10_000,
    }), key)
    expect(consumeGoogleOAuthTransaction({ cookie, encryptionKey: key, state: 'n', userId: 'u', now: 1 })).toBeNull()
  })
})

describe('every post-auth redirect goes through safeNextPath', () => {
  const read = (p: string) => readFileSync(path.join(__dirname, '..', p), 'utf8')
  it.each([
    'app/api/auth/google/route.ts',
    'app/api/auth/google/callback/route.ts',
    'lib/google/oauth-state.ts',
    'app/auth/post-login/route.ts',
  ])('%s', file => {
    const src = read(file)
    expect(src).toContain('safeNextPath(')
    expect(src).not.toMatch(/startsWith\('\/'\)\s*&&\s*!\w+\.startsWith\('\/\/'\)/)
    expect(src).not.toMatch(/!\w+(\.\w+)?\.startsWith\('\/'\)\s*\|\|\s*\w+(\.\w+)?\.startsWith\('\/\/'\)/)
  })
})
