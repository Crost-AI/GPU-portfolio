#!/usr/bin/env bash
# Back up the database and the stored files into deploy/local/backups/<UTC time>/ (or $1):
#   db.dump      pg_dump, custom format, of the schemas that hold data: public, auth, storage,
#                supabase_migrations (everything else is recreated by the images and migrate.sh)
#   extensions.sql  the extensions the migrations created (a schema-scoped dump leaves them out)
#   storage.tgz  the storage volume (file contents; storage.objects in db.dump indexes them)
# Copy the directory, and deploy/local/.env, off the machine: ENCRYPTION_KEY is not in the dump.
#
# The two halves must describe the same moment, or a restore pairs rows with files that were
# deleted or rewritten in between. So every writer (the app, its scheduler, PostgREST and the
# storage API) is stopped for the duration, and whichever were running are started again
# afterwards, also when the backup fails. The app is unavailable meanwhile.
set -euo pipefail
umask 077   # the dump holds every credential and personal record
here="$(cd "$(dirname "$0")/.." && pwd)"
dc() { docker compose -f "$here/docker-compose.yml" --env-file "$here/.env" "$@"; }
out="${1:-$here/backups/$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$out"; out="$(cd "$out" && pwd)"

running=()
while read -r svc; do
  [[ "$svc" =~ ^(scheduler|app|rest|storage)$ ]] && running+=("$svc")
done < <(dc ps --services --status running)
resume() { if ((${#running[@]})); then dc start "${running[@]}"; fi; }
trap resume EXIT
# 30s for in-flight requests to finish; a cron route cut off mid-run rolls back its transaction.
if ((${#running[@]})); then dc stop -t 30 "${running[@]}"; fi

dc exec -T db pg_dump -U supabase_admin -d postgres -Fc \
  -n public -n auth -n storage -n supabase_migrations > "$out/db.dump"
dc exec -T db psql -U supabase_admin -d postgres -tA -c "select format('create extension if not exists %I with schema %I;', e.extname, n.nspname)
  from pg_extension e join pg_namespace n on n.oid = e.extnamespace" > "$out/extensions.sql"
# Streamed out, so the file is written here, under the umask above and owned by you, like db.dump.
dc run --rm --no-deps -T --entrypoint tar storage \
  --exclude=./.restore-staging --exclude=./.restore-old -czf - -C /var/lib/storage . > "$out/storage.tgz"
ls -lh "$out"
