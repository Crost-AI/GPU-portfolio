#!/usr/bin/env bash
# Restore a backup made by backup.sh:
#   deploy/local/scripts/restore.sh [--force] deploy/local/backups/<time>
#
# Restore into a fresh stack: `dc down -v`, then this directly (it starts db, auth and storage
# itself; the dump carries the schema and the migration history). Its final `up -d` runs the
# `migrate` service, which migrates the backup forward. Restoring over a stack with NEWER migrations
# would leave their tables behind next to the older history, so this refuses when `public` has
# relations the dump does not, unless --force. deploy/local/.env must hold the backup's ENCRYPTION_KEY.
#
# Every writer (app, scheduler, PostgREST, storage API, and GoTrue, whose tables are replaced too)
# is stopped throughout. The steps run so that a failure leaves something usable:
#   1. both halves are read to the end (pg_restore, tar -t), and the storage volume must have room
#      for a second copy of the files: nothing is touched yet
#   2. the files are extracted beside the live ones, into a staging directory on the same volume
#   3. the database is restored in one transaction: a failure leaves it as it was
#   4. the staged files are swapped in, every move checked; a failed move keeps both directories
# A failure in 1-3 restarts the writers that were running. Step 3 committing is the point of no
# return: if step 4 then fails, the writers stay stopped, and re-running the restore (safe to
# repeat) finishes the job.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
dc() { docker compose -f "$here/docker-compose.yml" --env-file "$here/.env" "$@"; }
force=0; [[ "${1:-}" == "--force" ]] && { force=1; shift; }
src="$(cd "${1:?usage: $0 [--force] <backup directory>}" && pwd)"
[[ -f "$src/db.dump" && -f "$src/storage.tgz" ]] || { echo "$src needs db.dump and storage.tgz" >&2; exit 1; }

read -r -p "Replace this stack's data with $src? [y/N] " ok; [[ "$ok" == [yY] ]] || exit 1

running=()
while read -r svc; do
  [[ "$svc" =~ ^(scheduler|app|rest|storage|auth)$ ]] && running+=("$svc")
done < <(dc ps --services --status running)
committed=0 restored=0 staged=0
on_exit() {
  # The dump holds every credential and personal record: never leave it in the db container.
  dc exec -T db rm -f /tmp/restore.dump /tmp/restore.list >/dev/null 2>&1 || true
  ((restored)) && return
  if ((committed)); then
    echo "RESTORE INCOMPLETE: the database now holds the backup, but its files were not all swapped in." >&2
    echo "Nothing was deleted: on the storage volume, the previous files are in .restore-old and the" >&2
    echo "backup's in .restore-staging. The app, scheduler, PostgREST, storage and auth are left stopped." >&2
    echo "Fix the cause (see the swap: lines above), then re-run, which redoes the swap:" >&2
    echo "  $0 --force $src" >&2
    exit 1
  fi
  # Before the commit the staged copy is only a copy: drop it. (After, it is the backup's files.)
  if ((staged)); then in_storage 'rm -rf /var/lib/storage/.restore-staging' </dev/null >/dev/null 2>&1 || true; fi
  if ((${#running[@]})); then dc start "${running[@]}"; fi
}
trap on_exit EXIT
in_storage() { dc run --rm --no-deps -T --entrypoint sh storage -c "$1"; }

# On a fresh stack, GoTrue and storage-api create their schemas on first boot; let them.
dc up -d --wait db auth storage

# 1. Both halves readable to the end, before anything changes.
dc exec -T db sh -c 'umask 077 && cat > /tmp/restore.dump' < "$src/db.dump"
dc exec -T db pg_restore -f /dev/null /tmp/restore.dump
# Reading the archive to the end also totals its files: staging holds them beside the live ones
# until the swap, so the volume needs that much free (busybox tar -tv: size is column 3).
in_storage 'set -o pipefail
  need=$(tar -tzvf - | awk "{ s += \$3 } END { print s + 0 }") || exit 1
  free=$(df -Pk /var/lib/storage | awk "NR == 2 { print \$4 * 1024 }")
  [ "$need" -lt "$free" ] || { echo "restore: the backup files need $need bytes on the storage volume; $free are free" >&2; exit 1; }' < "$src/storage.tgz"

# Relations in `public` that the dump would not replace (a stack ahead of the backup). Each list is
# captured first so that a failing query aborts the restore (set -e); inside <( ) it would just
# come back empty, and the check would pass as if the stack were fresh.
live_rels="$(dc exec -T db psql -U supabase_admin -d postgres -tA -c "select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'S')")"
dump_rels="$(dc exec -T db pg_restore -l /tmp/restore.dump | awk '$5 == "public" && ($4 == "TABLE" || $4 == "VIEW" || $4 == "SEQUENCE") { print $6 } $4 == "MATERIALIZED" && $6 == "public" { print $7 }')"
extra="$(comm -23 <(sort -u <<<"$live_rels") <(sort -u <<<"$dump_rels"))"
if [[ -n "$extra" ]] && ((!force)); then
  echo "Refusing: public has relations the backup does not, so this stack is ahead of it:" >&2
  head -10 <<<"$extra" | sed 's/^/  /' >&2
  echo "Restore into a fresh stack (dc down -v, then this directly: it starts db, auth and storage itself," >&2
  echo "and its final up -d migrates the backup forward), or pass --force to restore over them anyway." >&2
  exit 1
fi

dc stop -t 30 scheduler app rest storage auth

# 2. Stage the files beside the live ones.
staged=1
in_storage 'rm -rf /var/lib/storage/.restore-staging && mkdir /var/lib/storage/.restore-staging &&
  tar -xzf - -C /var/lib/storage/.restore-staging' < "$src/storage.tgz"

# 3. The database, in one transaction. Superuser, because auth and storage objects belong to their
#    own roles. Every entry but the public schema itself: it already exists, and the extensions
#    recreated first now live in it.
if [[ -f "$src/extensions.sql" ]]; then
  dc exec -T db psql -U supabase_admin -d postgres -q -v ON_ERROR_STOP=1 < "$src/extensions.sql"
fi
dc exec -T db sh -c 'pg_restore -l /tmp/restore.dump | grep -v " SCHEMA - public " > /tmp/restore.list &&
  pg_restore -U supabase_admin -d postgres --clean --if-exists --single-transaction --exit-on-error \
    -L /tmp/restore.list /tmp/restore.dump; s=$?; rm -f /tmp/restore.dump /tmp/restore.list; exit $s'
committed=1

# 4. Swap the staged files in, every move checked (scripts/swap-staged-files.sh).
dc run --rm --no-deps -T --entrypoint sh storage -s -- /var/lib/storage < "$here/scripts/swap-staged-files.sh"

restored=1
dc up -d
dc exec -T db psql -U postgres -c "notify pgrst, 'reload schema'" >/dev/null
echo "Restored from $src."
