import { withBotId } from 'botid/next/config'
import { buildEnforcingCsp } from './lib/security/csp-enforcing.mjs'
import { pdfTracingIncludes } from './lib/pdf-routes.mjs'

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Turbopack infers the workspace root from the nearest lockfile, and a stray package-lock.json
  // in a parent directory (a developer's ~/Documents, say) makes it guess wrong and warn on every
  // build. The root is this directory; say so.
  turbopack: { root: import.meta.dirname },
  // Both were `experimental.*` on Next 14 and are top-level on 16. `serverComponentsExternalPackages`
  // was also renamed to `serverExternalPackages`.
  //
  // isomorphic-dompurify is NOT here any more because it is gone: its jsdom would not load in the
  // deployed functions, externalised or not, and took every route importing lib/sanitize.ts (all
  // the PDF routes, through lib/lp-report-pdf.ts) down with an empty 500. lib/sanitize.ts uses
  // sanitize-html, which needs no DOM. Do not bring a jsdom-backed package back into a server path.
  serverExternalPackages: ['@sparticuz/chromium', 'puppeteer-core', 'unpdf', 'tesseract.js', '@napi-rs/canvas'],
  // Include the memo-agent default schema files in the serverless function
  // bundle. Without this, `fs.readFile` calls inside `ensureDefaults` silently
  // return null in production (the YAML/MD files aren't traced), so a fresh
  // fund sees every schema marked "not yet seeded" and the schema editor loads
  // empty content. The trace is keyed `/**` so every route that imports
  // firm-schemas.ts gets the files — schemas page, agent stages, render job.
  //
  // The PDF routes also get Chromium's binary, which the tracer cannot see (lib/pdf-routes.mjs).
  outputFileTracingIncludes: {
    '/**': ['./lib/memo-agent/defaults/**/*'],
    ...pdfTracingIncludes(),
  },
  // OAuth discovery lives at /.well-known/*, but Next's app router will not route
  // a literal dot-prefixed directory — so the well-known paths are rewritten onto
  // real routes under /api/oauth/metadata/.
  //
  // The path-suffixed variants matter: RFC 9728 says a client MAY probe
  // /.well-known/oauth-protected-resource/<resource-path>, and Claude does exactly
  // that for /api/mcp. Serving only the bare path would leave discovery failing
  // for no visible reason.
  async rewrites() {
    return [
      {
        source: '/.well-known/oauth-authorization-server',
        destination: '/api/oauth/metadata/authorization-server',
      },
      {
        source: '/.well-known/oauth-authorization-server/:path*',
        destination: '/api/oauth/metadata/authorization-server',
      },
      {
        source: '/.well-known/oauth-protected-resource',
        destination: '/api/oauth/metadata/protected-resource',
      },
      {
        source: '/.well-known/oauth-protected-resource/:path*',
        destination: '/api/oauth/metadata/protected-resource',
      },
    ]
  },
  async headers() {
    const securityHeaders = [
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
      // The enforcing policy; see lib/security/csp-enforcing.mjs. The strict nonce policy rides
      // beside it as report-only, set per request by proxy.ts.
      {
        key: 'Content-Security-Policy',
        value: buildEnforcingCsp({
          development: process.env.NODE_ENV === 'development',
          supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
        }),
      },
    ]

    const noCacheHeaders = [
      { key: 'Cache-Control', value: 'no-store, no-cache, must-revalidate' },
      { key: 'CDN-Cache-Control', value: 'no-store' },
    ]

    return [
      // Security headers for pages and API routes only — exclude _next/static so the CDN can
      // serve immutable JS/CSS chunks straight from cache without these headers in the way.
      {
        source: '/((?!_next/static).*)',
        headers: securityHeaders,
      },
      // Prevent caching on the auth routes.
      { source: '/auth/:path*', headers: noCacheHeaders },
      { source: '/api/auth/:path*', headers: noCacheHeaders },
      { source: '/api/demo/:path*', headers: noCacheHeaders },
    ]
  },
}
export default withBotId(nextConfig)
