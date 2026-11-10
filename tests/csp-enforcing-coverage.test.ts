import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { config } from '@/proxy'
import nextConfig from '../next.config.mjs'

/**
 * The enforcing CSP comes from two places, and every path must get it from exactly one.
 *
 * proxy.ts sets it on everything its matcher runs on; next.config.mjs sends it only on the paths
 * that matcher skips. Sending it from next.config.mjs everywhere is what broke the nonce: on Vercel
 * a config header reaches the render as a REQUEST header too, and Next read this nonce-less policy
 * ahead of the proxy's. So a path covered by both is that bug coming back, and a path covered by
 * neither has no enforcing policy at all.
 *
 * Both sides are compiled with Next's own compilers, so the test cannot drift from what runs.
 */
const require_ = createRequire(import.meta.url)
const { getMiddlewareMatchers } = require_('next/dist/build/analysis/get-page-static-info.js') as {
  getMiddlewareMatchers: (m: unknown, nextConfig: Record<string, unknown>) => { regexp: string }[]
}
const { buildCustomRoute } = require_('next/dist/lib/build-custom-route.js') as {
  buildCustomRoute: (type: 'header', route: { source: string }) => { regex: string }
}

const proxyMatchers = getMiddlewareMatchers(config.matcher, {}).map(m => new RegExp(m.regexp))
const runsProxy = (path: string) => proxyMatchers.some(re => re.test(path))

type HeaderRoute = { source: string; headers: { key: string; value: string }[] }
const routes = (await nextConfig.headers!()) as HeaderRoute[]
const cspRoutes = routes
  .filter(r => r.headers.some(h => h.key.toLowerCase() === 'content-security-policy'))
  .map(r => new RegExp(buildCustomRoute('header', r).regex))
const configSendsCsp = (path: string) => cspRoutes.some(re => re.test(path))

const PATHS = [
  '/', '/auth', '/auth/mfa-verify', '/start', '/dashboard', '/portal/overview', '/sw.js',
  '/manifest.webmanifest', '/.well-known/oauth-authorization-server',
  '/api', '/api/x', '/api/v1/meta', '/api/emails/abc/attachment/0.png', '/api/inbound-emailfoo',
  '/api/inbound-email', '/api/inbound-email/resend',
  '/logo.png', '/icons/a.svg', '/img/x.webp', '/favicon.ico',
  '/_next/image', '/149e9513-01fa-4fb0-aad4-566afd725d1b/a/c.js',
]

describe('the enforcing CSP has exactly one source per path', () => {
  for (const path of PATHS) {
    it(path, () => {
      expect(runsProxy(path) !== configSendsCsp(path), `proxy ${runsProxy(path)}, config ${configSendsCsp(path)}`).toBe(true)
    })
  }

  it('leaves _next/static to the CDN, with neither', () => {
    for (const path of ['/_next/static/chunks/a.js', '/_next/static/media/a.png']) {
      expect(runsProxy(path), path).toBe(false)
      expect(configSendsCsp(path), path).toBe(false)
    }
  })
})
