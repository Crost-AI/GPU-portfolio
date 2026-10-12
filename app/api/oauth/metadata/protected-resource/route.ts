import { NextRequest, NextResponse } from 'next/server'
import { protectedResourceMetadata, resourcePathFor } from '@/lib/oauth/metadata'

/**
 * RFC 9728 Protected Resource Metadata.
 *
 * Served at /.well-known/oauth-protected-resource (and the path-suffixed variants
 * some clients probe, e.g. /.well-known/oauth-protected-resource/api/mcp) via
 * rewrites in next.config.js.
 *
 * Public and unauthenticated: it names the authorization server guarding the MCP
 * endpoint and nothing else.
 */

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  // /.well-known/oauth-protected-resource/api/portal/mcp describes the investor connector.
  return NextResponse.json(protectedResourceMetadata(req, resourcePathFor(req.nextUrl.searchParams.get('path'))), {
    headers: {
      'Cache-Control': 'public, max-age=300',
      'Access-Control-Allow-Origin': '*',
    },
  })
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, MCP-Protocol-Version',
    },
  })
}
