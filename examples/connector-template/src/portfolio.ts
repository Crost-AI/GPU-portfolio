import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { JournalSource, JournalTransaction } from './types.js'

/**
 * The Portfolio side: an MCP client for the deployment's own server at <PORTFOLIO_URL>/api/mcp,
 * authenticated with a fund API key (`lk_…`, Settings → API keys, write scope).
 *
 * This is the ENTIRE contract between a connector and the app. The connector never touches the
 * database and holds no service-role key; it calls the same tools an agent would, under the key
 * owner's access, and every write lands as a draft for review. Revoke the key and the connector
 * is cut off.
 */

export interface PortfolioOptions {
  url: string
  apiKey: string
  vehicle: string
}

export interface ImportResult {
  dryRun?: boolean
  reviewRequired?: boolean
  error?: string
  importReview?: { token: string; differences: Array<{ message?: string; name?: string; metric?: string }> }
  transactionsParsed?: number
  created?: number
  wouldCreate?: number
  alreadyPresent?: number
  skipped?: number
  errors?: string[]
  capitalWarnings?: string[]
}

export interface AccountProposal {
  qbAccount: string
  code: string | null
  confidence: 'exact' | 'likely' | 'none'
  reason: string
  excluded?: boolean
  lineCount: number
}

export class PortfolioClient {
  private client: Client | null = null

  constructor(private readonly opts: PortfolioOptions) {}

  static fromEnv(): PortfolioClient {
    const need = (k: string) => {
      const v = process.env[k]
      if (!v) throw new Error(`${k} is not set (see .env.example)`)
      return v
    }
    return new PortfolioClient({ url: need('PORTFOLIO_URL'), apiKey: need('PORTFOLIO_API_KEY'), vehicle: need('PORTFOLIO_VEHICLE') })
  }

  private async connect(): Promise<Client> {
    if (this.client) return this.client
    const transport = new StreamableHTTPClientTransport(new URL('/api/mcp', this.opts.url), {
      requestInit: { headers: { Authorization: `Bearer ${this.opts.apiKey}` } },
    })
    const client = new Client({ name: 'portfolio-connector', version: '0.1.0' })
    await client.connect(transport)
    this.client = client
    return client
  }

  /** Call one tool and return its JSON result. A tool error becomes a thrown Error with its text. */
  async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const client = await this.connect()
    const res: any = await client.callTool({ name, arguments: { vehicle: this.opts.vehicle, ...args } })
    const text = (res.content ?? []).find((c: any) => c.type === 'text')?.text ?? ''
    if (res.isError) throw new Error(`${name}: ${text || 'tool error'}`)
    if (res.structuredContent) return res.structuredContent as T
    try { return JSON.parse(text) as T } catch { return text as T }
  }

  /** Step 1: which source accounts these transactions touch, and how each maps (or would). */
  accounts(source: JournalSource, transactions: JournalTransaction[]) {
    return this.call<{ accounts: AccountProposal[]; errors: string[] }>('journal_import_accounts', { source, transactions })
  }

  /** Step 2: save mappings a person has confirmed. */
  saveMapping(source: JournalSource, rows: Array<{ qbAccount: string; accountCode?: string | null; excluded?: boolean; note?: string }>) {
    return this.call<{ saved: number }>('save_journal_mapping', { source, rows })
  }

  /** Step 3: import as drafts. Idempotent, so resending an overlapping window is safe. */
  importJournal(source: JournalSource, transactions: JournalTransaction[], opts: { dryRun?: boolean; reviewToken?: string; sourceLabel?: string } = {}) {
    return this.call<ImportResult>('import_journal', { source, transactions, ...opts })
  }

  async close() {
    await this.client?.close()
    this.client = null
  }
}
