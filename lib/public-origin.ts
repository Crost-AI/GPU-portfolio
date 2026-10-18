/**
 * The app's public origin, for redirects and self-requests.
 *
 * NOT `new URL(request.url).origin`: under `next start` behind a proxy (deploy/local, Dokploy) Next
 * builds request.url from its own bind address, so that origin is https://localhost:3000 and a
 * redirect built from it sends the browser to localhost. NEXT_PUBLIC_SITE_URL is the configured
 * public origin (deploy/local compiles it from SITE_URL; scripts/setup.ts sets it on Vercel for
 * production only). request.url stays the fallback where it isn't set (Vercel previews, whose
 * request.url is already the preview's own host), and is always used under `next dev`: setup.ts
 * also writes the production NEXT_PUBLIC_SITE_URL into .env.local, and a dev server must not
 * redirect to production.
 */
export function publicOrigin(request: Request): string {
  if (process.env.NODE_ENV === 'development') return new URL(request.url).origin
  const site = process.env.NEXT_PUBLIC_SITE_URL || process.env.NEXT_PUBLIC_APP_URL
  if (site) {
    try {
      // `localhost:3000` or `cap.example.com:443` parse with the host as the scheme, and their
      // origin is the string "null": only an http(s) URL is a usable origin.
      const url = new URL(site)
      if (url.protocol === 'https:' || url.protocol === 'http:') return url.origin
    } catch {
      // An unparseable value: fall through to the request's own origin.
    }
  }
  return new URL(request.url).origin
}
