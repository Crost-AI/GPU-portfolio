#!/usr/bin/env bash
# Restore a backup made by backup.sh:   deploy/local/scripts/restore.sh deploy/local/backups/<time>
# Replaces the database's data schemas and every stored file. Meant for a fresh stack (`up -d`,
# no migrate.sh needed: the dump carries the schema and the migration history) or a broken one.
# deploy/local/.env must hold the same ENCRYPTION_KEY as when the backup was taken.
#
# Like backup.sh, every writer (app, scheduler, PostgREST, storage API, and GoTrue, whose tables
# are replaced too) is stopped throughout. On success the whole stack is started; on failure the
# writers that were running before are started again. The database half is one transaction, so a
# failure there leaves the data as it was.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
dc() { docker compose -f "$here/docker-compose.yml" --env-file "$here/.env" "$@"; }
src="$(cd "${1:?usage: $0 <backup directory>}" && pwd)"
[[ -f "$src/db.dump" && -f "$src/storage.tgz" ]] || { echo "$src needs db.dump and storage.tgz" >&2; exit 1; }

read -r -p "Replace this stack's data with $src? [y/N] " ok; [[ "$ok" == [yY] ]] || exit 1

running=()
while read -r svc; do
  [[ "$svc" =~ ^(scheduler|app|rest|storage|auth)$ ]] && running+=("$svc")
done < <(dc ps --services --status running)
restored=0
resume() { if ((!restored && ${#running[@]})); then dc start "${running[@]}"; fi; }
trap resume EXIT

# On a fresh stack, GoTrue and storage-api create their schemas on first boot; let them.
dc up -d --wait db auth storage
dc stop -t 30 scheduler app rest storage auth
[[ -f "$src/extensions.sql" ]] && dc exec -T db psql -U supabase_admin -d postgres -q -v ON_ERROR_STOP=1 < "$src/extensions.sql"
# Superuser, because auth and storage objects belong to their own roles. Every entry but the
# public schema itself: it already exists, and the extensions above now live in it.
dc exec -T db sh -c 'cat > /tmp/restore.dump'  < "$src/db.dump"
dc exec -T db sh -c 'pg_restore -l /tmp/restore.dump | grep -v " SCHEMA - public " > /tmp/restore.list &&
  pg_restore -U supabase_admin -d postgres --clean --if-exists --single-transaction --exit-on-error \
    -L /tmp/restore.list /tmp/restore.dump; s=$?; rm -f /tmp/restore.dump /tmp/restore.list; exit $s'
dc run --rm --no-deps -T -v "$src:/backup:ro" --entrypoint sh storage \
  -c 'rm -rf /var/lib/storage/* && tar -xzf /backup/storage.tgz -C /var/lib/storage'
restored=1
dc up -d
dc exec -T db psql -U postgres -c "notify pgrst, 'reload schema'" >/dev/null
echo "Restored from $src."
