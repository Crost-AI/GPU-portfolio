import { afterEach, describe, expect, it, vi } from 'vitest'
import { publicOrigin } from '@/lib/public-origin'

/**
 * Under `next start` behind a proxy, request.url is Next's own bind origin (https://localhost:3000),
 * so redirects take the configured public origin instead, and fall back to request.url only where
 * none is configured (plain `next dev`, Vercel previews).
 */
const req = new Request('https://localhost:3000/auth/callback?code=x')

describe('publicOrigin', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('is NEXT_PUBLIC_SITE_URL when set, path and trailing slash dropped', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://cap.example.com/')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://old.example.com')
    expect(publicOrigin(req)).toBe('https://cap.example.com')
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://cap.example.com/some/path')
    expect(publicOrigin(req)).toBe('https://cap.example.com')
  })

  it('falls back to NEXT_PUBLIC_APP_URL, the older name', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://old.example.com')
    expect(publicOrigin(req)).toBe('https://old.example.com')
  })

  it("is the request's own origin when neither is set", () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '')
    expect(publicOrigin(new Request('http://localhost:3000/auth/callback'))).toBe('http://localhost:3000')
    expect(publicOrigin(new Request('https://preview-abc.vercel.app/x'))).toBe('https://preview-abc.vercel.app')
  })

  it("is the request's own origin when the configured value is not a URL", () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'cap.example.com')
    expect(publicOrigin(new Request('http://localhost:3000/x'))).toBe('http://localhost:3000')
  })
})
