# Portfolio connector template

A starting point for a **private data connector**: a small program that reads an outside system
(QuickBooks, Carta, a bank, anything) and feeds a Portfolio deployment. Copy this folder into a
private repository of your own and add connectors there. None of their code needs to live in
Portfolio, and Portfolio needs no change to run one.

## How a connector talks to Portfolio

Through the deployment's own MCP server, `<your app>/api/mcp`, with a fund API key. That's the
whole contract:

```
your source ──read──▶ connector (this repo, private) ──MCP + lk_ key──▶ Portfolio
                                                                        │
                                       drafts for review, never posted ◀┘
```

- **No database access.** The connector holds a fund API key, not a service-role key. Create one
  under **Settings → API and MCP** with read & write scope, after an admin turns on
  **Settings → Agent access**. It can do what that key's owner can do, through the same tools an agent
  uses, and nothing else. Revoke the key and the connector stops.
- **Nothing posts.** Journal imports land as drafts on the journal page, where a person reviews
  and bulk-posts them.
- **Safe to repeat.** Every imported entry is keyed by a content hash, so re-sending a window is
  matched, not duplicated. The runner re-reads 45 days before the last cursor on each run to catch
  back-dated entries.
- **Holds stop the run.** If Portfolio's comparison with its investment and LP records finds a
  difference, nothing is written and the run exits naming it. A person decides, then re-runs with
  `--review-token`. A scheduler never confirms on anyone's behalf.

The journal tools a connector uses:

| Tool | What it does |
|---|---|
| `journal_import_accounts` | Lists the source accounts a batch touches, the saved mapping for each, and a proposal where there is none. Writes nothing. |
| `save_journal_mapping` | Saves mappings a person confirmed. Each `source` (`quickbooks`, `carta`) keeps its own. |
| `import_journal` | Imports transactions as drafts. Unmapped accounts are skipped and named. |

Any other Portfolio tool (`import_bank_transactions`, `list_accounts`, …) is callable the same way
with `PortfolioClient.call(name, args)`; `tools/list` on the MCP endpoint shows what your key can use.

## Getting started

```sh
cp .env.example .env          # PORTFOLIO_URL, PORTFOLIO_API_KEY, PORTFOLIO_VEHICLE
npm install
npm run sync -- example-file --dry-run    # reads data/journal.example.json
```

The first real run usually skips transactions whose accounts aren't mapped yet. Map them once:

```sh
npm run accounts -- example-file          # writes mappings/example-file.json with proposals
# review that file: set accountCode for each account, or "excluded": true
npm run map -- example-file --apply mappings/example-file.json
npm run sync -- example-file
```

## Writing a connector

A connector is an object with a `source` and an async generator that yields batches of
`JournalTransaction` (`src/types.ts`) for a date window:

```ts
export const mySource: Connector = {
  id: 'my-source',
  source: 'quickbooks',            // whose books: decides which account mapping is used
  description: 'What it reads',
  async *pull({ window, state, log }) {
    for await (const page of readMySource(window.from, window.to)) yield page.map(toTransaction)
  },
}
```

Register it in `src/connectors/index.ts`. `src/connectors/example-file.ts` is the smallest working
one. Rules that keep the books right:

- **Read only.** A connector never writes back to its source.
- **Balanced, positive amounts.** Each transaction's debits equal its credits, both as positive
  magnitudes. Portfolio drops (and names) any that don't balance.
- **Stable ids.** `num` is part of the idempotency key. Use the source's id for the transaction,
  not something that changes between reads.
- **Stable account names.** The mapping is saved under `account` exactly as you send it. Pick one
  form (for example, code plus name) and never change it, or every account needs mapping again.
- **Partner names on capital lines.** An LP's name in `name` on a capital line routes it to that
  partner's capital account.

### Sources that are MCP servers

`src/mcp-source.ts` connects to a source's own MCP server: a local one over stdio
(`connectStdio`), or a hosted one behind OAuth (`connectHttp`, with `npm run login -- <id>` for the
one-time browser sign-in and refresh tokens after that). Ask for read-only scopes.

## Where state lives

`.state/<connector>.json` holds the cursor and any OAuth tokens. It is git-ignored; never commit
it. Some sources (QuickBooks) rotate refresh tokens on every use, so on an ephemeral runner,
replace `FileStateStore` with a store backed by something durable. `.github/workflows/sync.yml.example`
shows a nightly schedule.

## Running it elsewhere

`npm run sync -- <id>` is the whole job, so anything that runs Node on a schedule works: cron on a
server, GitHub Actions in your private repo, a serverless scheduled function. Give each connector
its own API key so you can revoke one without the others.
