/**
 * The strict Content-Security-Policy, shipped REPORT-ONLY.
 *
 * WHY REPORT-ONLY. The enforcing policy in next.config.mjs carries `'unsafe-inline'` on
 * `script-src`, which means an injected `<script>` runs and the policy contains nothing
 * XSS-shaped. The fix is a per-request nonce — but a policy that is too strict produces no build
 * error, no test failure and no server log; it blanks part of a page for a real user, and you find
 * out from a bug report. Nothing in CI can tell you which page. So the strict policy is sent as
 * `Content-Security-Policy-Report-Only` BESIDE the current one: browsers evaluate both, enforce the
 * old, and POST every violation of the new to /api/csp-report. After a week of ordinary use the
 * report says exactly what would have broken, and promoting it becomes a one-line swap.
 *
 * WHAT IS STRICT ABOUT IT. `script-src` is `'self' 'nonce-…' 'strict-dynamic'`. Only a script
 * carrying this response's nonce runs, and anything a nonce'd script loads is trusted by
 * inheritance (`strict-dynamic`), which is how Next's bootstrap pulls its chunks and how gtag pulls
 * its own. Under `strict-dynamic` the host allowlist and `'self'` are ignored by CSP3 browsers and
 * kept only for older ones. `'unsafe-eval'` is absent on purpose — report-only is precisely how we
 * learn whether anything still needs it — except in development, where React Refresh does.
 *
 * WHAT IS DELIBERATELY NOT STRICT. `style-src` keeps `'unsafe-inline'`. React sets `style={{…}}`
 * attributes everywhere, CSP3 governs those under `style-src-attr`, and reporting every one of them
 * would drown the signal this is meant to collect. The `<style>` ELEMENTS (theme vars, print CSS)
 * are server-controlled and small; nonce them in a later pass if the report is quiet.
 *
 * Next applies the nonce to its own inline scripts when it finds it in the REQUEST's
 * `content-security-policy` or `content-security-policy-report-only` header — see
 * node_modules/next/dist/server/app-render/app-render.js — which is why the proxy sets it on the
 * request as well as the response. Inline `<Script>` blocks the app owns take it via `nonce={…}`,
 * read from the `x-nonce` request header.
 */

import { imgSources } from './csp-enforcing.mjs'

export const CSP_REPORT_PATH = '/api/csp-report'
export const NONCE_HEADER = 'x-nonce'
export const REPORT_ONLY_HEADER = 'Content-Security-Policy-Report-Only'

/** 128 bits, base64. The regex Next matches nonces with allows `+/=`, so standard base64 is fine. */
export function generateNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Buffer.from(bytes).toString('base64')
}

/**
 * The same third parties the enforcing policy names, so a violation in the report is a NEW fact
 * rather than an old allowance re-stated.
 */
const SCRIPT_HOSTS = [
  'https://cdn.usefathom.com',
  'https://www.googletagmanager.com',
  'https://www.google-analytics.com',
]

/**
 * Why Next would render this request's scripts WITHOUT the nonce, or null when it will not.
 *
 * Next takes its render nonce from the request's `content-security-policy` header, falling back to
 * `-report-only` (route-modules/app-page/parse-request-headers.js), while the layouts read
 * `x-nonce`. proxy.ts sets all three. A local `next start` renders every `<script>` nonce'd, yet
 * production's report-only policy flags every `/_next/static` chunk on /auth and /start, which is
 * what an un-nonced render looks like. So the root layout calls this on every render and logs the
 * answer: one deploy of `grep '\\[csp-nonce\\]'` says which header the platform did not forward.
 * The report endpoint can't say; it is rate-limited to ten a minute per IP, so a page load's later
 * (inline) violations never reach the log.
 */
export function nonceRenderGap(headers: Headers): string | null {
  const nonce = headers.get(NONCE_HEADER)
  if (!nonce) return 'x-nonce missing'
  const csp = headers.get('content-security-policy') ?? headers.get(REPORT_ONLY_HEADER.toLowerCase())
  if (!csp) return 'no content-security-policy request header'
  const rendered = /'nonce-([^']+)'/.exec(csp)?.[1]
  if (rendered !== nonce) return 'request CSP carries a different nonce from x-nonce'
  return null
}

export function buildReportOnlyCsp(nonce: string, options: { development?: boolean } = {}): string {
  const scriptSrc = [
    "'self'",
    `'nonce-${nonce}'`,
    "'strict-dynamic'",
    // Ignored by browsers that honour strict-dynamic; here for the ones that do not.
    ...SCRIPT_HOSTS,
    // React Refresh evals in development. Never in the policy that reaches production.
    ...(options.development ? ["'unsafe-eval'"] : []),
  ].join(' ')

  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    // The same host list the enforcing policy uses (lib/security/csp-enforcing.mjs), not `https:`.
    `img-src ${imgSources(process.env.NEXT_PUBLIC_SUPABASE_URL).join(' ')}`,
    "font-src 'self'",
    "connect-src 'self' https://*.supabase.co https://*.supabase.in wss://*.supabase.co https://cdn.usefathom.com https://*.google-analytics.com https://*.analytics.google.com https://api.github.com",
    "frame-src https://*.supabase.co https://*.supabase.in",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    `report-uri ${CSP_REPORT_PATH}`,
  ].join('; ')
}
