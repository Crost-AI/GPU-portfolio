import type { NextRequest } from 'next/server'

/**
 * The OAuth issuer identity for this deployment.
 *
 * Derived from the REQUEST HOST, not from NEXT_PUBLIC_SITE_URL — and the order
 * matters. An OAuth client rejects metadata whose `issuer` doesn't match the
 * origin it fetched the document from, so an env var that disagrees with the host
 * actually in use (a preview deploy, a bare *.vercel.app URL, a second custom
 * domain, localhost on a non-default port) breaks discovery with an error that
 * points nowhere near the cause. Deriving from the request is always
 * self-consistent, whatever domain someone reaches us on.
 *
 * Trusting the Host header is safe here: this document is public, carries no
 * secrets, and grants nothing. A forged Host produces metadata describing the
 * forger's own domain, served back to the forger. What actually protects the flow
 * is the redirect_uri allowlist, which is exact-matched against what the client
 * registered.
 *
 * `x-forwarded-*` is what Vercel/Netlify set in front of the function; NEXT_PUBLIC_SITE_URL
 * remains as a last resort for contexts with no host header at all.
 */
export function issuerFor(req: NextRequest): string {
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host')
  if (host) {
    const proto = req.headers.get('x-forwarded-proto')
      ?? (host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https')
    return `${proto}://${host}`
  }

  const explicit = process.env.NEXT_PUBLIC_SITE_URL
  if (explicit) return explicit.replace(/\/$/, '')

  throw new Error('Cannot determine the OAuth issuer: no Host header and no NEXT_PUBLIC_SITE_URL')
}

/** The fund's MCP endpoint, the resource clients are pointed at by default. */
export const FUND_MCP_PATH = '/api/mcp'
/** The investor connector: an LP's own portal over MCP (app/api/portal/mcp). */
export const PORTAL_MCP_PATH = '/api/portal/mcp'

/** The MCP resource this authorization server guards: the fund's, or the investor connector. */
export function resourceFor(req: NextRequest, path: string = FUND_MCP_PATH): string {
  return `${issuerFor(req)}${path}`
}

/**
 * Which resource a protected-resource metadata request is about. RFC 9728 clients probe
 * /.well-known/oauth-protected-resource/<resource-path>; the rewrite in next.config.mjs passes
 * that path along as `?path=`. Anything but the investor connector describes the fund's endpoint.
 */
export function resourcePathFor(probedPath: string | null | undefined): string {
  const p = `/${String(probedPath ?? '').replace(/^\/+/, '')}`
  return p === PORTAL_MCP_PATH || p.startsWith(`${PORTAL_MCP_PATH}/`) ? PORTAL_MCP_PATH : FUND_MCP_PATH
}

/**
 * RFC 8414 — Authorization Server Metadata.
 *
 * `registration_endpoint` is the one that matters most: its presence is what tells
 * Claude that Dynamic Client Registration is available. Without it the connector
 * has no way to obtain a client_id and gives up.
 */
export function authorizationServerMetadata(req: NextRequest) {
  const issuer = issuerFor(req)
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/api/oauth/token`,
    registration_endpoint: `${issuer}/api/oauth/register`,
    revocation_endpoint: `${issuer}/api/oauth/revoke`,

    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],

    // S256 only. OAuth 2.1 forbids `plain`, and advertising it would invite
    // clients to use it.
    code_challenge_methods_supported: ['S256'],

    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    scopes_supported: ['read', 'write'],

    // RFC 9207 — every authorization response carries `iss` (app/api/oauth/consent). Advertising
    // this and omitting it is worse than not advertising it: ChatGPT refuses the response.
    authorization_response_iss_parameter_supported: true,
  }
}

/**
 * RFC 9728 — Protected Resource Metadata. Points the client at the authorization
 * server that guards this MCP endpoint (which is us).
 */
export function protectedResourceMetadata(req: NextRequest, path: string = FUND_MCP_PATH) {
  const issuer = issuerFor(req)
  return {
    resource: resourceFor(req, path),
    authorization_servers: [issuer],
    scopes_supported: ['read', 'write'],
    bearer_methods_supported: ['header'],
  }
}

/**
 * The `WWW-Authenticate` header a 401 from the MCP endpoint MUST carry.
 *
 * This is the thread the whole discovery flow hangs from: an unauthenticated
 * client calls the MCP endpoint, gets a 401, reads `resource_metadata` off this
 * header, and follows it to the metadata document. Without it, a client that
 * wasn't told where to look has nowhere to start.
 */
export function wwwAuthenticate(req: NextRequest, path: string = FUND_MCP_PATH): string {
  const issuer = issuerFor(req)
  const suffix = path === FUND_MCP_PATH ? '' : path
  return `Bearer realm="mcp", resource_metadata="${issuer}/.well-known/oauth-protected-resource${suffix}"`
}
