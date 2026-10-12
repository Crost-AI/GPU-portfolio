# Portfolio connector template

Use this template to build a **private data connector**: a small program that reads an outside
system, such as QuickBooks, Carta or a bank, and feeds a Portfolio deployment.

Copy this folder into a repository of your own, usually a private one, and add your connectors
there. Their code never has to live in Portfolio, and Portfolio needs no change to run one.

- [How it works](#how-it-works)
- [Before you start](#before-you-start)
- [Quick start](#quick-start)
- [Commands](#commands)
- [Mapping accounts](#mapping-accounts)
- [Running on a schedule](#running-on-a-schedule)
- [Writing a connector](#writing-a-connector)
- [Recipes: QuickBooks and Carta](#recipes-quickbooks-and-carta)
- [Where state lives](#where-state-lives)
- [Troubleshooting](#troubleshooting)

## How it works

A connector talks to Portfolio through the deployment's own MCP server at `<your app>/api/mcp`,
using a fund API key (`lk_…`). That is the whole contract.

```
your source ──read──▶ connector (your repo) ──MCP + API key──▶ Portfolio
                                                                    │
                                    drafts for review, never posted ◀┘
```

- **No database access.** The connector holds an API key, not a service-role key. It reaches
  only what that key's member can reach, through the same tools an agent uses. Revoke the key and
  the connector stops.
- **Writes apply directly, as drafts.** Writes made with an API key are not staged for approval
  the way a chat assistant's are. Journal imports still land as **drafts** on the journal page,
  where a person reviews and posts them. Every change is recorded in the audit trail with source
  `mcp`.
- **Safe to repeat.** Portfolio keys each imported entry by a hash of its content. Re-sending a
  transaction finds the existing entry instead of creating a second one. On each run, the runner
  re-reads the 45 days before the last cursor to pick up back-dated entries.
- **Review holds stop the run.** Before writing, Portfolio compares the import with its investment
  and LP records. If they differ, nothing is written and the run exits naming the differences. A
  person decides, then re-runs with `--review-token`. A schedule never confirms for anyone.

A connector uses these journal tools:

| Tool | What it does |
|---|---|
| `journal_import_accounts` | Lists the source accounts a batch touches, the saved mapping for each, and a proposed chart code where there is none. Writes nothing. |
| `save_journal_mapping` | Saves the mappings a person confirmed. Each `source` (`quickbooks`, `carta`) keeps its own. |
| `import_journal` | Imports transactions as drafts. Transactions touching an unmapped account are skipped and named. |

Any other Portfolio tool can be called the same way with `PortfolioClient.call(name, args)`, for
example `import_bank_transactions` for a bank or card feed. Use `tools/list` on the MCP endpoint
to see what your key can reach.

## Before you start

You need:

- **Node 20 or later.**
- **A Portfolio deployment that includes the journal tools above** (released with the
  "Data connectors" entry in Portfolio's CHANGELOG).
- **Agent access turned on.** An admin turns it on under **Settings → Agent access**.
- **An API key for the connector.** Create it under **Settings → API and MCP** with read & write
  scope, or get one from `npm run bootstrap` on a new deployment. Give each connector its own key
  so you can revoke one without the others. The key's member needs write access to accounting for
  the entity the connector feeds. Admin rights are not needed, because everything the connector
  imports is a draft.

## Quick start

1. Copy the template out of the Portfolio repository into a repository of your own:

   ```sh
   cp -r examples/connector-template ../my-connectors
   cd ../my-connectors
   git init
   ```

2. Configure it:

   ```sh
   cp .env.example .env    # PORTFOLIO_URL, PORTFOLIO_API_KEY, PORTFOLIO_VEHICLE
   ```

3. Install and check the code:

   ```sh
   npm install
   npm test
   ```

4. Try the example connector without writing anything. It reads `data/journal.example.json`:

   ```sh
   npm run sync -- example-file --dry-run
   ```

   The first real run usually skips transactions whose accounts aren't mapped yet. Map them once,
   as described in [Mapping accounts](#mapping-accounts).

## Commands

| Command | What it does |
|---|---|
| `npm run sync -- <id>` | Pulls the window and imports it as drafts. Takes `--from`, `--to` (YYYY-MM-DD), `--dry-run` and `--review-token <token>`. |
| `npm run accounts -- <id>` | Pulls the window, shows how each source account maps, and writes the ones that need a decision to `mappings/<id>.json`. Writes nothing to Portfolio. |
| `npm run map -- <id> --apply <file>` | Saves the mappings in that file to Portfolio. |
| `npm run login -- <id>` | One-time browser sign-in, for sources that use OAuth. |

The exit code tells a scheduler what happened: `0` for done, `1` for an error, `2` for usage, and
`3` for held for review.

## Mapping accounts

Portfolio has to know which of its chart accounts each source account goes to. You decide this
once per source and entity, and Portfolio remembers it:

```sh
npm run accounts -- example-file
# Review mappings/example-file.json: set accountCode for each account, or "excluded": true
npm run map -- example-file --apply mappings/example-file.json
npm run sync -- example-file
```

A wrong mapping misstates an account in every period you import, so a person makes these
decisions, never the connector. Excluded accounts drop the whole transaction, not half of it.

## Running on a schedule

`npm run sync -- <id>` is the whole job. Anything that runs Node on a schedule works: cron on a
server, GitHub Actions in your own repository, or a serverless scheduled function.
`.github/workflows/sync.yml.example` is a nightly GitHub Actions job; rename it to `sync.yml` to
turn it on. Read [Where state lives](#where-state-lives) before you schedule anything that signs
in with OAuth.

## Writing a connector

A connector is an object with a `source` and an async generator. For a date window, the
generator yields batches of `JournalTransaction` (see `src/types.ts`):

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

Register it in `src/connectors/index.ts`. The smallest working one is
`src/connectors/example-file.ts`. The runner handles windows, batches of 200, review holds and the
cursor.

Rules that keep the books right:

- **Read only.** A connector never writes back to its source.
- **Balanced, with positive amounts.** In each transaction, debits equal credits, and both are
  positive amounts. Portfolio drops and names any transaction that doesn't balance.
- **Stable ids.** `num` is part of the idempotency key. Use the source's own id for the
  transaction, and make sure it stays the same between reads.
- **Stable account names.** Portfolio saves the mapping under `account` exactly as you send it.
  Choose one form, such as code plus name, and never change it. If it changes, every account has
  to be mapped again.
- **Partner names on capital lines.** An LP's name in `name` on a capital line routes the amount
  to that partner's capital account.

### Sources that are MCP servers

`src/mcp-source.ts` connects to a source's own MCP server:

- `connectStdio` for a server that runs locally.
- `connectHttp` for a hosted one behind OAuth. The user signs in once with
  `npm run login -- <id>`, and the connector refreshes its tokens after that.

Ask for read-only scopes.

## Recipes: QuickBooks and Carta

These are the approaches the QuickBooks and Carta connectors take. Build your own from them in
your private copy.

### QuickBooks Online

- **Read the Journal report**, `GET /v3/company/<realm>/reports/JournalReport`, one month at a
  time. It is the only QuickBooks report that is already double-entry, with one row per split
  line, and it is the same report Portfolio's paste-in import uses.
  - The General Ledger report loses which credit answers which debit, so don't use it.
  - Intuit's MCP server doesn't offer the Journal report, so call the REST API directly. It needs
    the same Intuit app either way.
- **Group lines into transactions.** A row with a date starts a new transaction, a row without
  one continues it, and each report Section ends one. Skip total rows.
- **Sign in with OAuth 2.0** through an app at developer.intuit.com, using the
  `com.intuit.quickbooks.accounting` scope.
  - Refresh tokens change every time you use one, and expire after about 100 days if unused.
    Store the new token before using it.
  - Production keys don't accept a localhost redirect, so get the first refresh token from
    Intuit's OAuth Playground.
- **Send `source: 'quickbooks'`.**

### Carta fund admin

- **Read through Carta's hosted MCP server**, `https://mcp.app.carta.com/mcp`. Carta's REST API
  has no general-ledger scope; its MCP server reaches the fund-admin data warehouse.
- **Query `FUND_ADMIN.JOURNAL_ENTRIES`**, filtered on `FUND_UUID` and `EFFECTIVE_DATE` and ordered
  by `JOURNAL_ENTRY_ID`, through `read_tool` → `dwh__execute__query` with `format: 'ndjson'`.
  - The table has one row per journal line.
  - `AMOUNT` is signed: a debit is positive and a credit is negative.
  - Page with `next_offset`, and hold back the last entry of each page until the next page
    arrives, so an entry split across pages stays whole.
- **Map each row:**
  - `account` is `ACCOUNT_TYPE` and `ACCOUNT_NAME` joined.
  - `num` is `JOURNAL_ENTRY_GLUUID`. It survives an edit in Carta; `JOURNAL_ENTRY_ID` does not.
  - `name` is `PARTNER_NAME` or `VENDOR_NAME`.
- **Sign in once in the browser** (authorization code with PKCE, read-only scopes). Carta has no
  API keys.
- **Send `source: 'carta'`.**
- **Known lag:** the warehouse is a refreshed copy, so it can lag the Carta UI by up to a few
  days. The runner's overlap window picks up late data on the next run.

### Banks and cards

For a bank or card feed (Ramp, Plaid, a bank's CSV or BAI2 file), call
`import_bank_transactions` with `PortfolioClient.call` instead of the journal tools. Skip it if
the account already syncs into QuickBooks, because the QuickBooks connector brings those
transactions in.

## Where state lives

Each connector keeps its state in `.state/<id>.json`: the cursor and any OAuth tokens. The file is
git-ignored; never commit it.

Some sources, such as QuickBooks, rotate refresh tokens on every use. A runner whose disk
disappears after each run (GitHub Actions, a serverless function) loses the newest token. Before
you schedule such a connector there, replace `FileStateStore` in `src/state.ts` with a store
backed by something durable, such as a secrets manager, a key-value store or a private bucket. The
interface is two methods.

## Troubleshooting

| You see | What it means |
|---|---|
| `N skipped` with "No mapping for … account" | Map those accounts: `npm run accounts -- <id>`. |
| `HELD FOR REVIEW` (exit 3) | Portfolio's investment or LP records differ from the import. Check the listed differences, then re-run with `--review-token`. |
| `This credential is read-only.` | The API key needs read & write scope. |
| `Not signed in … Run: npm run login` | No stored tokens, or they expired. Sign in again. |
| A closed period in the errors | Portfolio won't write into a closed period. Reopen it, or leave those entries out. |
| `429` from Portfolio | The fund's limit is 60 write calls a minute. Raise `BATCH_SIZE` in `src/sync.ts` so each call carries more, or space out connectors that run together. |
