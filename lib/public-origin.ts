/**
 * The app's public origin, for redirects and self-requests.
 *
 * NOT `new URL(request.url).origin`: under `next start` behind a proxy (deploy/local, Dokploy) Next
 * builds request.url from its own bind address, so that origin is https://localhost:3000 and a
 * redirect built from it sends the browser to localhost. NEXT_PUBLIC_SITE_URL is the configured
 * public origin (deploy/local compiles it from SITE_URL; scripts/setup.ts sets it on Vercel for
 * production only). request.url stays the fallback where it isn't set: plain `next dev`, and Vercel
 * previews, whose request.url is already the preview's own host.
 */
export function publicOrigin(request: Request): string {
  const site = process.env.NEXT_PUBLIC_SITE_URL || process.env.NEXT_PUBLIC_APP_URL
  if (site) {
    try {
      return new URL(site).origin
    } catch {
      // An unparseable value: fall through to the request's own origin.
    }
  }
  return new URL(request.url).origin
}
