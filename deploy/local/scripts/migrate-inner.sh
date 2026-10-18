#!/usr/bin/env bash
# Apply /migrations/*.sql over the network with psql, then tell PostgREST to reload its schema.
# Runs as the compose `migrate` service on every `docker compose up` (scripts/migrate.sh runs it by
# hand and then checks the result). Everything comes from the environment compose passes in:
# PGHOST, PGUSER, PGPASSWORD, PGDATABASE. It never reads deploy/local/.env and needs no docker.
#
# Applied files are recorded in supabase_migrations.schema_migrations as the supabase CLI records
# them, so `supabase db push` (migrate.sh --cli) skips what this applied and vice versa. Four
# versions are shared by two files each (e.g. 20260625000000_*), and the history table's key is the
# version: the CLI applies the first file of each pair, fails on the second, and from then on counts
# both as applied. This applies both and records one row per version, naming both files.
#
# Only supabase/migrations is mounted: supabase/pending-deploy/ waits for a release to ship first
# (CLAUDE.md), and is moved into migrations/ when it has.
set -euo pipefail
dir=/migrations
psql_db() { psql -v ON_ERROR_STOP=1 -X -q "$@"; }
# The last line is the one operators read (e.g. in Dokploy's logs): what ran, or where it stopped.
step="the history table" applied_n=0 skipped_n=0
trap 's=$?; ((s)) && echo "migrate: FAILED on $step"' EXIT

# The history table as the CLI creates it.
psql_db <<'SQL'
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
SQL
# "version name" per applied file; a shared version's row names its files comma-separated.
applied="$(psql_db -tA -c "select version || ' ' || n from supabase_migrations.schema_migrations, unnest(string_to_array(coalesce(name, ''), ',')) n")"
versions="$(psql_db -tA -c "select version from supabase_migrations.schema_migrations")"
for f in "$dir"/*.sql; do
  base="$(basename "$f" .sql)"; version="${base%%_*}"; name="${base#*_}"
  grep -qxF "$version $name" <<<"$applied" && { skipped_n=$((skipped_n + 1)); continue; }
  # A version the CLI recorded (name unknown to compare) counts as applied when its file is the
  # first of its version, which is the one the CLI applies.
  first="$(basename "$(ls "$dir/${version}"_*.sql | head -1)" .sql)"
  grep -qxF "$version" <<<"$versions" && [[ "$base" == "$first" ]] && { skipped_n=$((skipped_n + 1)); continue; }
  step="$base.sql"
  [[ "$version" =~ ^[0-9]+$ && "$name" =~ ^[A-Za-z0-9_]+$ ]] || { echo "unexpected migration file name: $base" >&2; exit 1; }
  echo "applying $base"
  # One transaction per file, history row included, as the CLI does. Exception: a file with its
  # own begin/commit (20260714000001_commitment_events_snapshot_dedup.sql) ends that transaction
  # early, so its history row commits separately; the CLI behaves the same. Interrupted between
  # the two, the next run applies that file again.
  #
  # The file is recorded as one statement where the CLI splits it (nothing compares
  # statements), as a dollar-quoted literal whose tag the file does not contain, not even without
  # its closing "$" (a file ending in "$mig" would close the literal early). Everything travels
  # on stdin: Linux caps a single argument at 128 KiB, and migrations here pass 100 KiB.
  tag=mig; while grep -qF "\$$tag" "$f"; do tag="mig_$RANDOM"; done
  { cat "$f"
    printf '\n;\ninsert into supabase_migrations.schema_migrations (version, name, statements)\n'
    printf "values ('%s', '%s', array[\$%s\$" "$version" "$name" "$tag"
    cat "$f"
    printf '$%s$]) on conflict (version) do update\n' "$tag"
    # coalesce: a row the CLI recorded may have no name, and null || ',b' would stay null, so the
    # next run would apply the second file again. ',b' reads as applied.
    printf "set name = coalesce(schema_migrations.name, '') || ',' || excluded.name, statements = schema_migrations.statements || excluded.statements;\n"
  } | psql_db --single-transaction
  applied_n=$((applied_n + 1))
done

# Let PostgREST see the new schema.
step="notify pgrst"
psql_db -c "notify pgrst, 'reload schema'"
echo "migrate: applied $applied_n, already applied $skipped_n"
