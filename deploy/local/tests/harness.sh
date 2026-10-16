#!/usr/bin/env bash
# Checks for deploy/local/scripts that need no running stack and publish no ports:
#
#   deploy/local/tests/harness.sh
#
# 1. migrate.sh against a throwaway Postgres container: a migration over Linux's 128 KiB
#    single-argument limit applies and is recorded whole, a shared version records both files, and
#    a second run applies nothing.
# 2. backup.sh and restore.sh against a fake `docker` that records what they ask for and fails on
#    demand: which services stop and start, on success and on a failure at every step.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
real_docker="$(command -v docker)"
tmp="$(mktemp -d)"; pg=""
cleanup() { [[ -n "$pg" ]] && "$real_docker" rm -f "$pg" >/dev/null 2>&1; rm -rf "$tmp"; }
trap cleanup EXIT
pass=0 failed=0
ok() { echo "ok    $1"; pass=$((pass + 1)); }
bad() { echo "FAIL  $1"; failed=$((failed + 1)); }
expect() { if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1: expected [$3], got [$2]"; fi; }

# ── A copy of deploy/local with a fake docker on PATH ───────────────────────────────────────────
mkdir -p "$tmp/repo/deploy/local" "$tmp/repo/supabase/migrations" "$tmp/bin"
cp -R "$here/scripts" "$tmp/repo/deploy/local/"
touch "$tmp/repo/deploy/local/docker-compose.yml"
printf 'KONG_HTTP_PORT=1\nSERVICE_ROLE_KEY=x\n' > "$tmp/repo/deploy/local/.env"   # port 1: refused
cat > "$tmp/bin/docker" <<'EOF'
#!/usr/bin/env bash
# `docker inspect` / `docker compose -f … --env-file … <cmd>`. Logs <cmd>; exits 1 when FAIL_ON
# is in it. With PG set, `exec -T db psql …` runs in that real container.
if [[ "$1" == inspect ]]; then echo healthy; exit 0; fi
shift; while [[ "$1" == -f || "$1" == --env-file ]]; do shift 2; done
echo "$*" >> "$LOG"
[[ -n "${FAIL_ON:-}" && "$*" == *"$FAIL_ON"* ]] && exit 1
case "$*" in
  "ps -q "*) echo fake ;;
  "ps --services --status running") printf '%s\n' $RUNNING ;;
  "exec -T db psql -U supabase_admin -d postgres -tA -c select c.relname"*) printf '%s\n' $DB_RELS ;;
  "exec -T db pg_restore -l /tmp/restore.dump") printf '%s\n' "${DUMP_TOC:-}" ;;
  "exec -T db psql "*) [[ -n "${PG:-}" ]] && { shift 3; exec "$REAL_DOCKER" exec -i "$PG" "$@"; } ;;
esac
exit 0
EOF
chmod +x "$tmp/bin/docker"
export PATH="$tmp/bin:$PATH" LOG="$tmp/log" REAL_DOCKER="$real_docker"
scripts="$tmp/repo/deploy/local/scripts"

# ── 1. migrate.sh against real Postgres ─────────────────────────────────────────────────────────
pg="$("$real_docker" run -d --rm --label "ao.session=${AO_SESSION:-}" -e POSTGRES_PASSWORD=harness \
  supabase/postgres:17.6.1.136 postgres -c config_file=/etc/postgresql/postgresql.conf)"
for _ in $(seq 1 60); do "$real_docker" exec "$pg" pg_isready -U postgres -h localhost >/dev/null 2>&1 && break; sleep 2; done
sleep 3   # the image runs its init scripts after the first ready
for _ in $(seq 1 30); do "$real_docker" exec "$pg" psql -U postgres -tAc 'select 1' >/dev/null 2>&1 && break; sleep 2; done

if "$real_docker" exec "$pg" sh -c ':' "$(head -c 140000 /dev/zero | tr '\0' x)" 2>/dev/null; then
  bad "the container accepts a 140000-byte argument, so check 1 proves nothing"
else
  ok "the container refuses a 140000-byte argument (the limit the big migration must avoid)"
fi

big="$tmp/repo/supabase/migrations/20990101000000_big.sql"
{ echo "create table harness_big (body text);"
  # \$mig\$ in the text makes migrate.sh pick another dollar-quote tag.
  printf "insert into harness_big values ('%s');\n" "\$mig\$ $(head -c 140000 /dev/zero | tr '\0' y)"
} > "$big"
echo "create table harness_a (x int);" > "$tmp/repo/supabase/migrations/20990101000001_a.sql"
echo "create table harness_b (x int);" > "$tmp/repo/supabase/migrations/20990101000001_b.sql"
size="$(wc -c < "$big" | tr -d ' ')"

export PG="$pg"
: > "$LOG"; "$scripts/migrate.sh" > "$tmp/migrate1.out" 2>&1 || true   # its stack checks fail here
q() { "$real_docker" exec "$pg" psql -U postgres -tAc "$1"; }
expect "a ${size}-byte migration applied" "$(q "select length(body) > 140000 from harness_big")" t
expect "its history row holds the whole file" \
  "$(q "select octet_length(statements[1]) from supabase_migrations.schema_migrations where version = '20990101000000'")" "$size"
expect "a shared version records both files" \
  "$(q "select name from supabase_migrations.schema_migrations where version = '20990101000001'")" "a,b"
expect "both files of the shared version ran" "$(q "select count(*) from pg_tables where tablename in ('harness_a', 'harness_b')")" 2
"$scripts/migrate.sh" > "$tmp/migrate2.out" 2>&1 || true
expect "a second run applies nothing" "$(grep -c '^applying' "$tmp/migrate2.out" || true)" 0
unset PG

# ── 2. backup.sh / restore.sh against the fake ──────────────────────────────────────────────────
all="db auth kong rest storage app scheduler"
log_has() { grep -qE "$1" "$LOG"; }
backup() { : > "$LOG"; RUNNING="$1" FAIL_ON="$2" "$scripts/backup.sh" "$tmp/bk" </dev/null >/dev/null 2>&1 && echo 0 || echo 1; }
restore() { : > "$LOG"; echo y | RUNNING="$1" FAIL_ON="$2" "$scripts/restore.sh" ${3:-} "$tmp/bk" >"$tmp/restore.out" 2>&1 && echo 0 || echo 1; }

expect "backup: succeeds" "$(backup "$all" "")" 0
expect "backup: stops the writers before pg_dump" "$(grep -nE '^stop |pg_dump' "$LOG" | cut -d: -f2 | cut -c1-4 | tr '\n' ' ')" "stop exec "
expect "backup: restarts exactly the writers" "$(grep '^start ' "$LOG")" "start rest storage app scheduler"
for step in pg_dump "--entrypoint tar"; do
  expect "backup: fails when $step fails" "$(backup "$all" "$step")" 1
  log_has '^start rest storage app scheduler$' && ok "backup: restarts the writers after a $step failure" || bad "backup: no restart after a $step failure"
done
backup "db auth kong" "" >/dev/null
log_has '^(stop|start) ' && bad "backup: touched services that were not running" || ok "backup: stops and starts nothing when no writer runs"

touch "$tmp/bk/db.dump" "$tmp/bk/storage.tgz"
export DUMP_TOC="1; 1259 1 TABLE public funds postgres" DB_RELS="funds"
expect "restore: succeeds" "$(restore "$all" "")" 0
log_has '^up -d$' && ok "restore: brings the stack up after success" || bad "restore: no final up -d"
for step in "-f /dev/null" "tar -tzf" "tar -xzf" "--clean"; do
  expect "restore: fails when '$step' fails" "$(restore "$all" "$step")" 1
  if log_has '^start auth rest storage app scheduler$' && ! log_has '^up -d$'; then
    ok "restore: before the commit, '$step' failing restarts what was running"
  else bad "restore: '$step' failing did not restart the writers"; fi
done
expect "restore: fails when the swap fails" "$(restore "$all" "find .restore-staging")" 1
if ! log_has '^(start|up -d$)' && grep -q "RESTORE INCOMPLETE" "$tmp/restore.out"; then
  ok "restore: after the commit, a failed swap leaves the writers stopped and says how to finish"
else bad "restore: a failed swap restarted writers or printed no recovery message"; fi

export DB_RELS="funds newer_table"
expect "restore: refuses a stack ahead of the backup" "$(restore "$all" "")" 1
if grep -q newer_table "$tmp/restore.out" && ! log_has '^stop '; then ok "restore: names the extra relation and stops nothing"
else bad "restore: did not refuse cleanly"; fi
expect "restore: --force restores anyway" "$(restore "$all" "" --force)" 0

echo "$pass passed, $failed failed"
((failed == 0))
