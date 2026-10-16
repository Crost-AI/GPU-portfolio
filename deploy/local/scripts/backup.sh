#!/usr/bin/env bash
# Back up the database and the stored files into deploy/local/backups/<UTC time>/ (or $1):
#   db.dump      pg_dump, custom format, of the schemas that hold data: public, auth, storage,
#                supabase_migrations (everything else is recreated by the images and migrate.sh)
#   extensions.sql  the extensions the migrations created (a schema-scoped dump leaves them out)
#   storage.tgz  the storage volume (file contents; storage.objects in db.dump indexes them)
# Copy the directory, and deploy/local/.env, off the machine: ENCRYPTION_KEY is not in the dump.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
dc() { docker compose -f "$here/docker-compose.yml" --env-file "$here/.env" "$@"; }
out="${1:-$here/backups/$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$out"; out="$(cd "$out" && pwd)"

dc exec -T db pg_dump -U supabase_admin -d postgres -Fc \
  -n public -n auth -n storage -n supabase_migrations > "$out/db.dump"
dc exec -T db psql -U supabase_admin -d postgres -tA -c "select format('create extension if not exists %I with schema %I;', e.extname, n.nspname)
  from pg_extension e join pg_namespace n on n.oid = e.extnamespace" > "$out/extensions.sql"
dc run --rm --no-deps -T -v "$out:/backup" --entrypoint tar storage -czf /backup/storage.tgz -C /var/lib/storage .
ls -lh "$out"
