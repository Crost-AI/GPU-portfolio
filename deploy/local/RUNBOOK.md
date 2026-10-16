# Running Portfolio on one machine (no Supabase cloud, no Vercel)

`deploy/local/` runs the whole product with Docker Compose: Postgres 17, GoTrue (auth), PostgREST,
Storage and Kong from Supabase's self-hosting images, plus the app (`next start`) and a cron
container that replaces Vercel Cron. Commands below run from the repository root; `dc` is shorthand
for:

```sh
dc() { docker compose -f deploy/local/docker-compose.yml --env-file deploy/local/.env "$@"; }
```

## Prerequisites

- Docker with Compose v2.24+ (tested: Docker 29.8.2). Roughly 4 GB RAM for the build, then about 1.5 GB.
- `node` on the host is optional (`gen-keys.sh` falls back to the node image). The `supabase` CLI is
  only needed for `migrate.sh --cli`.
- Free host ports: 3000 (app), 8000 (Kong), and 54322 (Postgres, loopback only). Ports 54323
  (Studio) and 54324 (Mailpit) are only used with their profiles. Change any of them in `.env`.

## First-time setup

```sh
deploy/local/scripts/gen-keys.sh             # writes deploy/local/.env with fresh secrets
dc --profile mail up -d --build              # builds the app image (several minutes), starts everything
deploy/local/scripts/migrate.sh              # applies supabase/migrations, then checks the result
deploy/local/scripts/bootstrap-admin.sh --email you@firm.com --fund "Your Fund"
```

Open http://localhost:3000 and sign in with that email and the password `bootstrap-admin.sh`
asked for. After "Sign in" the page can stay on `/auth?next=/`: you are signed in, and a reload or
any link shows it (an app-side quirk, #53). Back up `deploy/local/.env` now. Its `ENCRYPTION_KEY`
encrypts every stored credential and cannot be recovered.

- `--profile mail` starts Mailpit, which the default `SMTP_*` settings deliver to. Without it, or
  real SMTP, every email GoTrue sends fails: a teammate's signup gets `500 Error sending confirmation
  email`. For production, set real SMTP (see "Email and the no-SMTP path") and drop the profile.
- A new fund starts with accounting, LPs, deals, compliance and some other areas switched **off**
  (`feature_visibility`), so `/api/accounting/*` answers 403 until the admin switches them on in
  Settings. That is the product's default, not a fault in the stack.

What each step does:

- **gen-keys.sh** generates `POSTGRES_PASSWORD`, `JWT_SECRET`, `ENCRYPTION_KEY`, `CRON_SECRET` and
  `PG_META_CRYPTO_KEY`. It also mints the `ANON_KEY` and `SERVICE_ROLE_KEY` JWTs from `JWT_SECRET`.
  It never overwrites an existing `.env` unless you pass `--force`.
- **up** starts db, then auth, rest and storage once db is healthy (GoTrue and storage-api create
  `auth.*` and `storage.*` on first boot). Kong starts at once; it resolves those services per
  request. The app waits for Kong, auth and storage, and the scheduler for the app. The app answers
  before migrations run, but every page errors until they are applied.
- **migrate.sh** waits for db, auth and storage to be healthy, because the migrations reference
  `auth.users` and `storage.buckets`. It then applies `supabase/migrations/*.sql` in filename order,
  each file in one transaction with its history row in `supabase_migrations.schema_migrations`.
  One file carries its own `begin`/`commit` (`20260714000001_commitment_events_snapshot_dedup.sql`),
  so its history row commits separately, as with the CLI. Interrupted between the two, the next run
  applies that file again. Last it checks `btree_gist`, the signup hook, the Data API grants, the 8
  private storage buckets the app uses (printing every bucket's size limit) and
  `GET /rest/v1/funds` with the service key.
  - It uses psql inside the db container by default. `supabase db push` cannot install this repo
    from empty: four versions are shared by two files each, and the CLI applies only the first of
    each pair. Once the database is current, `migrate.sh --cli` runs `supabase db push` instead;
    both read the same history table.
  - `supabase/pending-deploy/` is never applied. Those files wait for a release to ship first
    (see CLAUDE.md).
- **bootstrap-admin.sh** runs `npm run bootstrap` (`scripts/bootstrap-fund.ts`) inside the app
  container. That adds your email to `allowed_signups`, creates the confirmed account, creates the
  fund with you as `admin`, and prints an agent/MCP API key. Any other `npm run bootstrap` flag is
  passed through, such as `--ai assistant` or `--no-key`.
  - It then sets a password through GoTrue's admin API. The password comes from `ADMIN_PASSWORD`
    in the environment or a prompt, never from the command line. Leave it empty to use magic links
    only.

Signups stay gated. GoTrue calls `public.hook_before_user_created` on every signup, so only
addresses in `allowed_signups` (exact, or `*@domain`) or invited LPs can create an account; everyone
else gets 403. Allow a teammate with `insert into allowed_signups (email_pattern) values (...)`.
They sign up, which needs email (Mailpit or real SMTP), ask to join the fund, and the admin
approves them in Settings → Members. Without email, see below.

## Email and the no-SMTP path

GoTrue sends magic links, confirmations and password resets over SMTP (`SMTP_*` in `.env`). The
defaults point at Mailpit:

- `dc --profile mail up -d` starts it, and http://127.0.0.1:54324 shows every message.
- For real delivery, set your provider's `SMTP_HOST`/`PORT`/`USER`/`PASS`, then `dc up -d auth`.

With no SMTP at all, use passwords. `bootstrap-admin.sh` sets the first one. For a teammate,
allow-list the email (above), then create a confirmed account with a password. They sign in, ask to
join, and the admin approves them in Settings → Members. To set or reset any user's password, use
the user id from `auth.users`. Both need `SERVICE_ROLE_KEY`:

```sh
curl -X POST http://localhost:8000/auth/v1/admin/users \
  -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" -d @- <<< '{"email":"teammate@firm.com","password":"...","email_confirm":true}'
curl -X PUT http://localhost:8000/auth/v1/admin/users/<user-id> \
  -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" -d @- <<< '{"password":"..."}'
```

The branded templates in `supabase/templates/*.html` are not wired in, so GoTrue's defaults are
used. GoTrue loads templates from URLs (`GOTRUE_MAILER_TEMPLATES_MAGIC_LINK=https://...` and so on),
so to use them, serve the files somewhere GoTrue can fetch and add those variables to `auth`.

## Crons

The `scheduler` container (Alpine + busybox crond) runs `deploy/local/cron/crontab`. That file
has every `crons` entry from `vercel.json` at the same schedule, in UTC as on Vercel, and
`tests/local-deploy-cron.test.ts` fails if the two drift.

- Each job does `GET http://app:3000/api/cron/<name>` with `Authorization: Bearer $CRON_SECRET`
  and logs one line per run: `dc logs -f scheduler`.
- To run one by hand: `dc exec scheduler run-cron /api/cron/ops-reminders`.

## Backup and restore

```sh
deploy/local/scripts/backup.sh                    # -> deploy/local/backups/<UTC time>/
dc down -v && dc --profile mail up -d             # restore into a FRESH stack
deploy/local/scripts/restore.sh deploy/local/backups/<UTC time>
```

The backup stops the app, the scheduler, PostgREST and Storage while it runs, so the database and
the files describe the same moment, then starts them again. Schedule it for a quiet time.

Restarted services come back on new container IPs. Kong re-resolves them within 5 s
(`KONG_DNS_VALID_TTL=5`, `KONG_DNS_STALE_TTL=0`, `KONG_DNS_NOT_FOUND_TTL=1` on the `kong` service).
Without those settings, Kong's default DNS caching sent part of `/rest/v1` to the old IP for
minutes. That showed up as intermittent 502s, and once as a 200 with an empty result. To check,
after a backup, a restore or `dc restart rest`, wait 5 s and run a few hundred requests. None
should fail:

```sh
for i in $(seq 300); do curl -s -o /dev/null -w '%{http_code}\n' "http://localhost:8000/rest/v1/funds?select=id" \
  -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY"; done | sort | uniq -c   # all 200
```

A backup holds:

- `db.dump`: `pg_dump -Fc` of `public`, `auth`, `storage` and `supabase_migrations`.
- `extensions.sql`: the extensions to recreate first.
- `storage.tgz`: the files.

Restore replaces the data schemas and every file, and restarts the stack; no migrate is needed.
Restore into fresh volumes, as above. Over a stack with newer migrations, `pg_restore` would
replace only what the dump has: the newer tables would stay behind next to the older migration
history, and the next `migrate.sh` would trip over them. So `restore.sh` refuses when `public`
has relations the dump lacks, unless you pass `--force`. Steps 1–3 below change nothing that a
failure leaves broken; step 4 is where the old files are replaced:

1. It reads both halves to the end, and checks that the storage volume has room for a second copy of the files, before touching anything.
2. It extracts the files beside the live ones.
3. It restores the database in one transaction.
4. It swaps the files in.

A failure up to the database commit restarts the stack as it was. A failure after it leaves the
writers stopped and prints the command to re-run, which is safe to repeat. Keep the matching
`.env`, or at least its `ENCRYPTION_KEY`, with each backup. Copy backups off the machine.

## Upgrading

```sh
git pull
dc build app                          # NEXT_PUBLIC_* are compiled in: rebuild after changing them too
deploy/local/scripts/migrate.sh       # applies only what is new
dc up -d
```

Take a backup first. To change a Supabase image version, edit `docker-compose.yml`. A Postgres
**major** upgrade (17 → 18) cannot reuse the data volume: back up, `dc down -v`, change the image,
`dc up -d`, then restore.

## Row cap (PGRST_DB_MAX_ROWS)

PostgREST returns at most this many rows from any read that doesn't page. `supabase/config.toml`
(and the hosted default) says 1000; this stack uses **10000**. The app pages some reads at 1000
itself, but not every read. Under a 1000 cap, an unpaged read silently truncates on a large fund
instead of failing. Lower it in `.env` if you need the tighter limit, then run `dc up -d rest`.

## URLs, and why the app shares Kong's network

`SUPABASE_PUBLIC_URL` (default `http://localhost:8000`) and `SITE_URL` (default
`http://localhost:3000`) are compiled into the app as `NEXT_PUBLIC_SUPABASE_URL` and
`NEXT_PUBLIC_SITE_URL`. Both the browser and the app's server use them:

- The server calls Supabase at that same URL.
- The memo agent fetches the app's own PDF routes at `SITE_URL`.

So both must resolve from inside the app container, too. The compose file makes the defaults work
by running the app in Kong's network namespace (`network_mode: service:kong`). Inside it,
`localhost:8000` is Kong and `localhost:3000` is the app. The app's port is published on the `kong`
service for the same reason.

To serve other machines:

1. Set `BIND_ADDRESS=0.0.0.0`, or better, put a TLS reverse proxy (Caddy, nginx) in front of
   ports 3000 and 8000.
2. Set `SITE_URL` and `SUPABASE_PUBLIC_URL` to the public URLs; these must also resolve from inside
   the container. Add them to `ADDITIONAL_REDIRECT_URLS` if you sign in on more than one hostname.
3. `dc build app && dc up -d`.

The app container receives only the variables listed under `app.environment` in
`docker-compose.yml`, never the whole `.env`. It does not get `JWT_SECRET`, `POSTGRES_PASSWORD` or
`PG_META_CRYPTO_KEY`. To pass another app setting, add its name there.

If you add a proxy, give it a read timeout of **at least 300 s**. Vercel's per-route
`maxDuration` (up to 300 s for the cron and agent routes, 120 s for bank import) does not exist
under `next start`, and a shorter proxy timeout would cut those requests off. Nothing in this stack
puts a proxy in front of the app. Storage uploads through Kong allow up to an hour for large
recordings.

## PDFs

The PDF routes render with puppeteer-core. The app image installs Debian's `chromium` and sets
`CHROME_EXECUTABLE_PATH=/usr/bin/chromium`, which `getChromeConfig()` in `lib/lp-report-pdf.ts`
uses before probing fixed paths. `@sparticuz/chromium` is only used on Vercel or Lambda. The app
runs as the image's unprivileged `node` user.

To check, sign in as an admin with accounting on and at least one vehicle. Then copy the browser's
whole `Cookie` header for localhost:3000. The session is often split across
`sb-localhost-auth-token.0`, `.1` and so on, and all of the parts are needed:

```sh
curl -s "http://localhost:3000/api/accounting/statements/pdf?group=<vehicle name>" \
  -H "Cookie: <the browser's Cookie header>" | head -c5     # -> %PDF-
```

## What does nothing off Vercel

- `@vercel/analytics` and `@vercel/speed-insights` (`app/layout.tsx`) request `/_vercel/*` scripts
  that don't exist here. They log a console line and do nothing.
- BotID (`botid` in `next.config.mjs` and `proxy.ts`) has no Vercel edge to verify against. Its
  browser script may log an error, but no server code calls `checkBotId()`, so nothing is gated
  on it (`lib/botid-routes.ts`).
- `vercel.json` (`functions.maxDuration`, `crons`) is not read. Crons come from the scheduler
  container.
- The CSP is report-only and lists `*.supabase.co`, so connecting to `localhost:8000` logs a
  `[csp-report]` line in the app's logs. Nothing is blocked.

## Optional services

- `dc --profile studio up -d`: Supabase Studio at http://127.0.0.1:54323. It has no login of its
  own, so it is bound to loopback only; don't expose it. **Its pg-meta (`meta:8080`) runs any SQL
  as `postgres` with no authentication, and every container on the stack's network can reach it**,
  the app included. Only the host is kept out (loopback). Run the profile when you need it and
  `dc stop studio meta` afterwards.
- `dc --profile mail up -d`: Mailpit, as above.
- `AO_SESSION=<id>` in the environment labels every container `ao.session=<id>`, for supervisors
  that reap by label. It is unset otherwise.

## Stopping and resetting

`dc down` stops the stack and keeps the data. `dc down -v` also **deletes** the database and the
stored files.
