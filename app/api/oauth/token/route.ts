import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { audienceOf } from '@/lib/oauth/audience'
import {
  getClient,
  clientSecretValid,
  redirectUriAllowed,
  consumeAuthorizationCode,
  pkceValid,
  issueTokens,
  rotateRefreshToken,
} from '@/lib/oauth/store'
import { agentApiEnabled } from '@/lib/oauth/enabled'
import { rateLimit, getClientIp } from '@/lib/rate-limit'

/**
 * OAuth 2.1 token endpoint. Two grants:
 *
 *   authorization_code — exchange the code from /oauth/authorize for tokens.
 *   refresh_token      — rotate an expiring access token.
 *
 * Public (no session): the client authenticates with its client_id plus, for
 * confidential clients, a secret — and for public clients (Claude), with PKCE.
 *
 * RFC 6749 §5.1 requires form-encoded bodies here, not JSON. We accept both,
 * because some clients get this wrong and a 400 at this step is opaque to debug.
 */

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  // Public by necessity (public clients present no secret), and it accepts
  // guessable-shaped credentials — codes, refresh tokens, client secrets. Metered
  // per IP so a failed-grant hammer is bounded. The ceiling is generous relative to
  // real use: a client exchanges one code per authorization and refreshes about
  // hourly.
  const limited = await rateLimit({ key: `oauth-token:${getClientIp(req)}`, limit: 60, windowSeconds: 300 })
  if (limited) return limited

  const params = await readParams(req)
  const admin = createAdminClient()

  const grantType = params.get('grant_type')
  const clientId = params.get('client_id')
  if (!clientId) return err('invalid_request', 'client_id is required')

  const client = await getClient(admin, clientId)
  if (!client) return err('invalid_client', 'Unknown client', 401)

  // Confidential clients must prove themselves. Public clients pass this trivially
  // and are held to PKCE instead (checked below).
  if (!clientSecretValid(client, params.get('client_secret'))) {
    return err('invalid_client', 'Client authentication failed', 401)
  }

  if (grantType === 'authorization_code') {
    const code = params.get('code')
    const verifier = params.get('code_verifier')
    const redirectUri = params.get('redirect_uri')

    if (!code) return err('invalid_request', 'code is required')
    if (!verifier) return err('invalid_request', 'code_verifier is required')
    if (!redirectUri) return err('invalid_request', 'redirect_uri is required')

    // Consume atomically. A code is single-use; a replay gets nothing.
    const consumed = await consumeAuthorizationCode(admin, code)
    if (!consumed) return err('invalid_grant', 'Code is invalid, expired, or already used')

    // The code was minted for THIS client. Without this check, one registered
    // client could redeem a code issued to another.
    if (consumed.clientId !== clientId) {
      return err('invalid_grant', 'Code was not issued to this client')
    }

    // The redirect_uri presented now must match the one bound at authorize time,
    // and that one was exact-matched against the client's registered set.
    if (consumed.redirectUri !== redirectUri || !redirectUriAllowed(client, redirectUri)) {
      return err('invalid_grant', 'redirect_uri mismatch')
    }

    // PKCE. For a public client this is the ONLY thing proving the caller is the
    // same party that started the flow — an intercepted code is useless without
    // the verifier.
    if (!pkceValid(verifier, consumed.codeChallenge)) {
      return err('invalid_grant', 'PKCE verification failed')
    }

    // Last gate: the fund may have switched the agent surface off between consent
    // and exchange.
    if (audienceOf(consumed.resource) === 'portal') {
      // The investor connector has its own switch, and its own identity: still an active investor
      // in this fund, with the fund's portal and connector both on.
      const { connectorPrincipal, lpConnectorEnabled } = await import('@/lib/portal/principal')
      if (!(await lpConnectorEnabled(admin, consumed.fundId)) || !(await connectorPrincipal(admin, consumed.userId, consumed.fundId))) {
        return err('invalid_grant', 'The investor connector is not available for this fund', 403)
      }
    } else if (!(await agentApiEnabled(admin, consumed.fundId))) {
      return err('invalid_grant', 'Agent access is disabled for this fund', 403)
    }

    const tokens = await issueTokens(admin, {
      clientId,
      userId: consumed.userId,
      fundId: consumed.fundId,
      scope: consumed.scope,
      resource: consumed.resource,
    })

    return tokenResponse(tokens)
  }

  if (grantType === 'refresh_token') {
    const refreshToken = params.get('refresh_token')
    if (!refreshToken) return err('invalid_request', 'refresh_token is required')

    // Rotation, replay detection, and a live re-check of the owner's role all
    // happen inside. A refresh must never launder a stale privilege.
    const tokens = await rotateRefreshToken(admin, { clientId, refreshToken })
    if (!tokens) return err('invalid_grant', 'Refresh token is invalid, expired, or revoked')

    return tokenResponse(tokens)
  }

  return err('unsupported_grant_type', `Unsupported grant_type: ${grantType ?? '(none)'}`)
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: cors() })
}

async function readParams(req: NextRequest): Promise<URLSearchParams> {
  const ct = req.headers.get('content-type') ?? ''
  if (ct.includes('application/json')) {
    const body = await req.json().catch(() => ({}))
    const p = new URLSearchParams()
    for (const [k, v] of Object.entries(body ?? {})) {
      if (typeof v === 'string') p.set(k, v)
    }
    return p
  }
  const text = await req.text().catch(() => '')
  return new URLSearchParams(text)
}

function tokenResponse(tokens: { accessToken: string; refreshToken: string; expiresIn: number; scope: string }) {
  return NextResponse.json(
    {
      access_token: tokens.accessToken,
      token_type: 'Bearer',
      expires_in: tokens.expiresIn,
      refresh_token: tokens.refreshToken,
      scope: tokens.scope,
    },
    {
      status: 200,
      // Tokens must never be cached by anything, anywhere. RFC 6749 §5.1.
      headers: { ...cors(), 'Cache-Control': 'no-store', Pragma: 'no-cache' },
    }
  )
}

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  }
}

function err(code: string, description: string, status = 400) {
  return NextResponse.json(
    { error: code, error_description: description },
    { status, headers: { ...cors(), 'Cache-Control': 'no-store' } }
  )
}
