#!/usr/bin/env bash
# Apply supabase/migrations to the local stack, then check the result.
#
#   deploy/local/scripts/migrate.sh         # psql inside the db container (the default)
#   deploy/local/scripts/migrate.sh --cli   # the host supabase CLI: supabase db push
#
# Both record applied files in supabase_migrations.schema_migrations, so either one skips what the
# other applied. psql is the default because the CLI cannot install this repo from empty: four
# versions are shared by two files each (e.g. 20260625000000_*), the history table's key is the
# version, and `db push` applies the first file of each pair, fails on the second, and from then on
# counts both as applied. The psql path applies both and records one row per version, naming both
# files. Once the database is up to date, `--cli` is fine for later migrations.
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
else
  # The history table as the CLI creates it.
  psql_db <<'SQL'
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
SQL
  # "version name" per applied file; a shared version's row names its files comma-separated.
  applied="$(psql_db -tA -c "select version || ' ' || n from supabase_migrations.schema_migrations, unnest(string_to_array(coalesce(name, ''), ',')) n")"
  versions="$(psql_db -tA -c "select version from supabase_migrations.schema_migrations")"
  for f in "$repo"/supabase/migrations/*.sql; do
    base="$(basename "$f" .sql)"; version="${base%%_*}"; name="${base#*_}"
    grep -qxF "$version $name" <<<"$applied" && continue
    # A version the CLI recorded (name unknown to compare) counts as applied when its file is the
    # first of its version, which is the one the CLI applies.
    first="$(basename "$(ls "$repo/supabase/migrations/${version}"_*.sql | head -1)" .sql)"
    grep -qxF "$version" <<<"$versions" && [[ "$base" == "$first" ]] && continue
    echo "applying $base"
    # One transaction per file, history row included, as the CLI does. The file is stored as one
    # statement where the CLI splits it; nothing compares statements.
    { cat "$f"
      printf '\n;\ninsert into supabase_migrations.schema_migrations (version, name, statements)\n'
      printf "values (:'mig_version', :'mig_name', array[:'mig_sql']) on conflict (version) do update\n"
      printf "set name = schema_migrations.name || ',' || excluded.name, statements = schema_migrations.statements || excluded.statements;\n"
    } | psql_db --single-transaction -v mig_version="$version" -v mig_name="$name" -v mig_sql="$(cat "$f")"
  done
fi

# 3. Let PostgREST see the new schema.
psql_db -c "notify pgrst, 'reload schema'"

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
check "the 8 private buckets" \
  "$(psql_db -tA -c "select string_agg(id, ' ' order by id) from storage.buckets where not public")" "$expected"
check "no public bucket" "$(psql_db -tA -c "select count(*) from storage.buckets where public")" 0

service_key="$(env_get SERVICE_ROLE_KEY)"; kong_port="$(env_get KONG_HTTP_PORT)"
code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${kong_port:-8000}/rest/v1/funds?select=id&limit=1" \
  -H "apikey: $service_key" -H "Authorization: Bearer $service_key")"
check "GET /rest/v1/funds with the service key" "$code" 200

exit "$fail"
