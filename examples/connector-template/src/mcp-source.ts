import { createServer } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientInformationFull, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import type { StateStore } from './types.js'

/**
 * The SOURCE side, when the source is itself an MCP server: Carta's hosted one, Intuit's local
 * QuickBooks one, or any other. Two ways to reach one:
 *
 *   connectStdio  — a server you run as a subprocess (e.g. intuit/quickbooks-online-mcp-server).
 *   connectHttp   — a hosted server behind OAuth (e.g. https://mcp.app.carta.com/mcp).
 *
 * Hosted servers like Carta's offer no API keys: the only grant is a browser sign-in
 * (authorization code + PKCE) and then refresh tokens. So the first run is interactive
 * (`npm run login -- <connector>`), and every run after it refreshes silently from the stored
 * tokens. Read-only scopes are the ones to ask for: a connector only ever reads its source.
 */

export async function connectStdio(command: string, args: string[], env: Record<string, string> = {}): Promise<Client> {
  const transport = new StdioClientTransport({ command, args, env: { ...process.env as Record<string, string>, ...env } })
  const client = new Client({ name: 'portfolio-connector', version: '0.1.0' })
  await client.connect(transport)
  return client
}

const CALLBACK_PORT = Number(process.env.CONNECTOR_OAUTH_PORT || 8765)
const REDIRECT_URL = `http://localhost:${CALLBACK_PORT}/callback`

/** OAuth client state for one hosted MCP server, kept in the connector's StateStore. */
export class StoredOAuthProvider implements OAuthClientProvider {
  private verifier: string | undefined
  /** Set when the server needs a browser sign-in. Only `login` acts on it. */
  authorizationUrl: URL | undefined

  constructor(private readonly store: StateStore, private readonly scope: string, private readonly clientName = 'Portfolio connector') {}

  get redirectUrl() { return REDIRECT_URL }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.clientName,
      redirect_uris: [REDIRECT_URL],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: this.scope,
    }
  }

  clientInformation() { return this.store.get<OAuthClientInformationFull>('oauth_client') }
  saveClientInformation(info: OAuthClientInformationFull) { return this.store.set('oauth_client', info) }
  tokens() { return this.store.get<OAuthTokens>('oauth_tokens') }
  saveTokens(tokens: OAuthTokens) { return this.store.set('oauth_tokens', tokens) }
  redirectToAuthorization(url: URL) { this.authorizationUrl = url }
  async saveCodeVerifier(v: string) { this.verifier = v; await this.store.set('oauth_verifier', v) }
  async codeVerifier() {
    const v = this.verifier ?? await this.store.get<string>('oauth_verifier')
    if (!v) throw new Error('No PKCE verifier stored; run login again.')
    return v
  }
}

/**
 * Connect to a hosted MCP server with stored tokens. Throws a clear "run login" error when there
 * are none or they can no longer be refreshed. A scheduled run must never wait on a browser.
 */
export async function connectHttp(url: string, provider: StoredOAuthProvider): Promise<Client> {
  const client = new Client({ name: 'portfolio-connector', version: '0.1.0' })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { authProvider: provider }))
    return client
  } catch (e) {
    if (e instanceof UnauthorizedError) throw new Error(`Not signed in to ${url} (or the sign-in expired). Run: npm run login -- <connector>`)
    throw e
  }
}

/** Interactive first sign-in: open the printed URL, approve, and the local callback finishes it. */
export async function loginHttp(url: string, provider: StoredOAuthProvider, log: (m: string) => void): Promise<void> {
  const transport = new StreamableHTTPClientTransport(new URL(url), { authProvider: provider })
  const client = new Client({ name: 'portfolio-connector', version: '0.1.0' })
  try {
    await client.connect(transport)
    log('Already signed in.')
    await client.close()
    return
  } catch (e) {
    if (!(e instanceof UnauthorizedError) || !provider.authorizationUrl) throw e
  }

  log(`Open this URL to sign in:\n\n  ${provider.authorizationUrl.toString()}\n`)
  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', REDIRECT_URL)
      if (u.pathname !== '/callback') { res.writeHead(404).end(); return }
      const got = u.searchParams.get('code')
      res.writeHead(got ? 200 : 400, { 'Content-Type': 'text/plain' }).end(got ? 'Signed in. You can close this tab.' : 'No code in callback.')
      server.close()
      if (got) resolve(got)
      else reject(new Error(u.searchParams.get('error_description') ?? u.searchParams.get('error') ?? 'Sign-in failed'))
    })
    server.listen(CALLBACK_PORT)
  })
  await transport.finishAuth(code)
  log('Signed in; tokens stored.')
}

/** Call a source tool and return the text of its result (most servers answer in text). */
export async function callText(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const res: any = await client.callTool({ name, arguments: args })
  const text = (res.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
  if (res.isError) throw new Error(`${name}: ${text || 'tool error'}`)
  return text
}
