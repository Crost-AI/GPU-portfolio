#!/usr/bin/env bash
# Apply supabase/migrations to the local stack, then check the result. `docker compose up` already
# applies them (the `migrate` service, before the app starts); this is the way to see the checks.
#
#   deploy/local/scripts/migrate.sh         # the compose `migrate` service (scripts/migrate-inner.sh)
#   deploy/local/scripts/migrate.sh --cli   # the host supabase CLI: supabase db push
#
# Both record applied files in supabase_migrations.schema_migrations, so either one skips what the
# other applied. The `migrate` service is the default because the CLI cannot install this repo from
# empty (four versions are shared by two files each; see migrate-inner.sh). Once the database is up
# to date, `--cli` is fine for later migrations.
#
# MIGRATE_CHECK_URL (environment or .env): where Kong answers from this host (behind a proxy, the
# public URL), for the last check. Unset, that check runs from inside the app container instead.
#
# supabase/pending-deploy/ is never applied: those files wait for a release to ship first
# (CLAUDE.md), and are moved into migrations/ when it has.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "$here/../.." && pwd)"
dc() { docker compose -f "$here/docker-compose.yml" --env-file "$here/.env" "$@"; }
# One value from .env, read the way Compose reads it: split on the first '=', strip matching
# quotes, or on an unquoted value a ' #' comment. Never sourced: a valid Compose value such as
# SMTP_SENDER_NAME=My Fund is not valid shell. The last assignment wins, as in Compose.
env_get() {
  awk -v want="$1" '
    { line = $0; sub(/^[ \t]*(export[ \t]+)?/, "", line) }
    line ~ /^#/ || (p = index(line, "=")) == 0 { next }
    { key = substr(line, 1, p - 1); sub(/[ \t]+$/, "", key); if (key != want) next
      v = substr(line, p + 1); sub(/^[ \t]+/, "", v); q = substr(v, 1, 1)
      if ((q == "\"" || q == "\047") && (e = index(substr(v, 2), q)) > 0) v = substr(v, 2, e - 1)
      else { sub(/[ \t]+#.*$/, "", v); sub(/[ \t]+$/, "", v) }
      val = v; found = 1 }
    END { if (found) print val }
  ' "$here/.env"
}
urlencode() {
  local LC_ALL=C s="$1" out="" c i
  for ((i = 0; i < ${#s}; i++)); do
    c="${s:i:1}"
    case "$c" in [a-zA-Z0-9.~_-]) out+="$c" ;; *) printf -v c '%%%02X' "'$c"; out+="$c" ;; esac
  done
  printf '%s' "$out"
}
psql_db() { dc exec -T db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -X -q "$@"; }

# 1. db, auth and storage healthy: auth.* and storage.* exist only once GoTrue and storage-api
#    have run their own migrations, and the app's migrations reference both.
for svc in db auth storage; do
  printf 'waiting for %s ' "$svc"
  for _ in $(seq 1 120); do
    id="$(dc ps -q "$svc")"
    [[ -n "$id" && "$(docker inspect -f '{{.State.Health.Status}}' "$id")" == healthy ]] && break
    printf .; sleep 2
  done
  [[ -n "$id" && "$(docker inspect -f '{{.State.Health.Status}}' "$id")" == healthy ]] || { echo " not healthy"; exit 1; }
  echo " ok"
done

# 2. Apply.
if [[ "${1:-}" == "--cli" ]]; then
  command -v supabase >/dev/null || { echo "supabase CLI not found; drop --cli to use psql" >&2; exit 1; }
  pg_port="$(env_get POSTGRES_HOST_PORT)"
  (cd "$repo" && supabase db push --yes \
    --db-url "postgresql://postgres:$(urlencode "$(env_get POSTGRES_PASSWORD)")@127.0.0.1:${pg_port:-54322}/postgres")
  # 3. Let PostgREST see the new schema.
  psql_db -c "notify pgrst, 'reload schema'"
else
  # The compose `migrate` service: scripts/migrate-inner.sh, which `up` also runs before the app.
  dc run --rm -T migrate
fi

# 4. Check what the app depends on.
fail=0
check() { if [[ "$2" == "$3" ]]; then echo "ok    $1"; else echo "FAIL  $1: expected $3, got ${2:-nothing}"; fail=1; fi; }

check "btree_gist extension" "$(psql_db -tA -c "select count(*) from pg_extension where extname = 'btree_gist'")" 1
check "signup hook public.hook_before_user_created(jsonb)" \
  "$(psql_db -tA -c "select count(*) from pg_proc where oid = 'public.hook_before_user_created(jsonb)'::regprocedure and has_function_privilege('supabase_auth_admin', oid, 'execute')")" 1
check "Data API grants to authenticated" \
  "$(psql_db -tA -c "select (count(*) > 100)::text from information_schema.role_table_grants where grantee = 'authenticated' and table_schema = 'public'")" true

echo "storage buckets:"
psql_db -c "select id, public, file_size_limit from storage.buckets order by id"
expected="company-documents diligence-documents diligence-recordings email-attachments entity-documents lp-documents receipts style-anchor-memos"
# At least these: a later migration may add more.
check "the 8 private buckets the app uses" \
  "$(psql_db -tA -c "select count(*) from storage.buckets where not public and id = any(string_to_array('$expected', ' '))")" 8
check "no public bucket" "$(psql_db -tA -c "select count(*) from storage.buckets where public")" 0

# GET /rest/v1/funds through Kong with the service key. With MIGRATE_CHECK_URL (from the environment
# or .env: where Kong answers from here, behind a proxy the public URL), from this host; otherwise from inside the app
# container, which shares Kong's network (localhost:8000 there is Kong); the key goes in through
# `-e SERVICE_KEY`, not on the docker command line. `notify pgrst` is asynchronous: until
# PostgREST has reloaded, a new table answers 404, so any answer but 200 is retried a few times.
# No answer at all (000), or no app to ask from, is a skip, not a FAIL.
SERVICE_KEY="$(env_get SERVICE_ROLE_KEY)"; export SERVICE_KEY
check_url="${MIGRATE_CHECK_URL:-$(env_get MIGRATE_CHECK_URL)}"
funds() {
  if [[ -n "$check_url" ]]; then
    curl -s -o /dev/null -w '%{http_code}' "$check_url/rest/v1/funds?select=id&limit=1" \
      -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY" || true
  else
    dc exec -T -e SERVICE_KEY app sh -c 'curl -s -o /dev/null -w "%{http_code}" \
      -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY" \
      "http://localhost:8000/rest/v1/funds?select=id&limit=1"' || true
  fi
}
where="${check_url:-the app container}"
if [[ -z "$check_url" && -z "$(dc ps -q --status running app)" ]]; then
  echo "skip  GET /rest/v1/funds: app not running (or set MIGRATE_CHECK_URL to where Kong answers)"
else
  for _ in $(seq 1 10); do code="$(funds)"; [[ "$code" == 200 || "$code" == 000 ]] && break; sleep 2; done
  if [[ "$code" == 000 ]]; then
    echo "skip  GET /rest/v1/funds: Kong unreachable from $where (set MIGRATE_CHECK_URL to where Kong answers)"
  else
    check "GET /rest/v1/funds with the service key, from $where" "$code" 200
  fi
fi

exit "$fail"
