#!/usr/bin/env bash
# Checks for deploy/local/scripts that need no running stack and publish no ports:
#
#   deploy/local/tests/harness.sh
#
# 1. migrate-inner.sh (the compose `migrate` service) against a throwaway Postgres container: it
#    applies nothing over a history the previous migrate.sh wrote (production's), a migration over
#    Linux's 128 KiB single-argument limit applies and is recorded whole, a shared version records
#    both files, a second run applies nothing, and a failing file is named and not recorded. Then
#    migrate.sh's last check: from the app container, or MIGRATE_CHECK_URL; skipped when unreachable.
# 2. backup.sh and restore.sh against a fake `docker` that records what they ask for and fails on
#    demand: which services stop and start, on success and on a failure at every step.
# 3. swap-staged-files.sh in the pinned storage image (busybox, as in production) with a real
#    failing `mv`: a move that fails keeps both directories and exits 1.
# 4. Kong's DNS TTLs, so services restarted by backup/restore (new IPs) are re-resolved in 5 s.
# 5. The resolved compose config: the app waits for the `migrate` service, which mounts only
#    supabase/migrations and its script; GoTrue's MFA and mailer settings.
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
printf 'KONG_HTTP_PORT=1\nSERVICE_ROLE_KEY=harness-service-key\n' > "$tmp/repo/deploy/local/.env"
cat > "$tmp/bin/docker" <<'EOF'
#!/usr/bin/env bash
# `docker inspect` / `docker compose -f … --env-file … <cmd>`. Logs <cmd>; exits 1 when FAIL_ON
# is in it. With PG set, `exec -T db psql …` runs in that real container, and `run --rm -T migrate`
# runs migrate-inner.sh against it. The app is running when APP_UP is set, and its curl answers
# FUNDS_CODE, but only when SERVICE_KEY reached it through the environment.
if [[ "$1" == inspect ]]; then echo healthy; exit 0; fi
shift; while [[ "$1" == -f || "$1" == --env-file ]]; do shift 2; done
echo "$*" >> "$LOG"
[[ -n "${FAIL_ON:-}" && "$*" == *"$FAIL_ON"* ]] && exit 1
case "$*" in
  "run --rm -T migrate")
    exec "$REAL_DOCKER" run --rm --label "ao.session=${AO_SESSION:-}" --network "container:$PG" \
      -v "$MIGRATIONS:/migrations:ro" -v "$INNER:/usr/local/bin/migrate-inner.sh:ro" \
      -e PGHOST=localhost -e PGUSER=postgres -e PGDATABASE=postgres -e PGPASSWORD=harness \
      --entrypoint bash supabase/postgres:17.6.1.136 /usr/local/bin/migrate-inner.sh ;;
  "ps -q --status running app") [[ -n "${APP_UP:-}" ]] && echo fake ;;
  "exec -T -e SERVICE_KEY app sh -c "*)
    [[ "$SERVICE_KEY" == harness-service-key ]] && printf '%s' "$FUNDS_CODE" || printf 'no-key' ;;
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

migrations="$tmp/repo/supabase/migrations"
big="$migrations/20990101000000_big.sql"
{ echo "create table harness_big (body text);"
  # \$mig\$ in the text makes the runner pick another dollar-quote tag.
  printf "insert into harness_big values ('%s');\n" "\$mig\$ $(head -c 140000 /dev/zero | tr '\0' y)"
} > "$big"
echo "create table harness_a (x int);" > "$migrations/20990101000001_a.sql"
echo "create table harness_b (x int);" > "$migrations/20990101000001_b.sql"
size="$(wc -c < "$big" | tr -d ' ')"

export PG="$pg" MIGRATIONS="$migrations" INNER="$here/scripts/migrate-inner.sh"
q() { "$real_docker" exec "$pg" psql -U postgres -tAc "$1"; }
inner() { docker compose run --rm -T migrate > "$tmp/$1.out" 2>&1 && echo 0 || echo 1; }   # via the fake
last() { tail -1 "$tmp/$1.out"; }

# Production's history was written by the psql loop in migrate.sh as it shipped in a688a182. The
# runner must read it as applied, or the first deploy re-applies every file to a live database.
if git -C "$here" show a688a182:deploy/local/scripts/migrate.sh > "$scripts/migrate-a688a182.sh"; then
  chmod +x "$scripts/migrate-a688a182.sh"
  : > "$LOG"; "$scripts/migrate-a688a182.sh" > "$tmp/old.out" 2>&1 || true   # its stack checks fail here
  rows="$(q "select count(*) from supabase_migrations.schema_migrations")"
  expect "the a688a182 migrate.sh applied the 3 files (2 history rows)" "$(grep -c '^applying' "$tmp/old.out")/$rows" "3/2"
  expect "migrate-inner.sh over that history: exits 0" "$(inner compat)" 0
  expect "...and applies nothing" "$(last compat)" "migrate: applied 0, already applied 3"
  expect "...and adds no history row" "$(q "select count(*) from supabase_migrations.schema_migrations")" "$rows"
  rm "$scripts/migrate-a688a182.sh"
else bad "git show a688a182:deploy/local/scripts/migrate.sh (needs the repo's history)"; fi

q "drop schema supabase_migrations cascade; drop table harness_big, harness_a, harness_b" >/dev/null 2>&1
expect "migrate-inner.sh on an empty database: exits 0" "$(inner first)" 0
expect "...and says what it did" "$(last first)" "migrate: applied 3, already applied 0"
expect "a ${size}-byte migration applied" "$(q "select length(body) > 140000 from harness_big")" t
expect "its history row holds the whole file" \
  "$(q "select octet_length(statements[1]) from supabase_migrations.schema_migrations where version = '20990101000000'")" "$size"
expect "a shared version records both files" \
  "$(q "select name from supabase_migrations.schema_migrations where version = '20990101000001'")" "a,b"
expect "both files of the shared version ran" "$(q "select count(*) from pg_tables where tablename in ('harness_a', 'harness_b')")" 2
inner second >/dev/null
expect "a second run applies nothing" "$(grep -c '^applying' "$tmp/second.out" || true)/$(last second)" "0/migrate: applied 0, already applied 3"

printf 'create table harness_c (x int);\nselect harness_no_such_function();\n' > "$migrations/20990101000002_bad.sql"
expect "a failing migration: exits 1" "$(inner bad)" 1
expect "...names the file on the last line" "$(last bad)" "migrate: FAILED on 20990101000002_bad.sql"
expect "...and records and keeps nothing of it" \
  "$(q "select count(*) from supabase_migrations.schema_migrations where version = '20990101000002'")/$(q "select count(*) from pg_tables where tablename = 'harness_c'")" "0/0"
rm "$migrations/20990101000002_bad.sql"

# A version's row that names only its first file, or nothing (the CLI applies only the first file of
# a shared version): the first file counts as applied, the other one is still applied.
for row in "null" "'a'"; do
  q "truncate supabase_migrations.schema_migrations; drop table harness_big, harness_b;
     insert into supabase_migrations.schema_migrations (version, name) values ('20990101000001', $row)" >/dev/null
  inner first-file >/dev/null
  expect "a shared version recorded with name $row: applies _b, not _a" \
    "$(grep '^applying 20990101000001' "$tmp/first-file.out" | tr '\n' ' ')$(last first-file)" \
    "applying 20990101000001_b migrate: applied 2, already applied 1"
  inner first-file-again >/dev/null
  expect "...and a second run applies nothing" "$(last first-file-again)" "migrate: applied 0, already applied 3"
done

# migrate.sh: applies through the `migrate` service, then checks. Its other checks fail here (no
# Supabase schemas); only the last one, GET /rest/v1/funds, is under test. storage.buckets is
# listed, not just counted, so it has to exist for the script to get that far.
"$real_docker" exec "$pg" psql -U supabase_admin -d postgres -qc \
  "create table storage.buckets (id text, public bool, file_size_limit bigint)"
unset MIGRATE_CHECK_URL
host() { : > "$LOG"; "$scripts/migrate.sh" > "$tmp/host.out" 2>&1 || true; grep 'GET /rest/v1/funds' "$tmp/host.out"; }
expect "migrate.sh: app not running: skips the funds check" "$(host)" \
  "skip  GET /rest/v1/funds: app not running (or set MIGRATE_CHECK_URL to where Kong answers)"
grep -qxF "run --rm -T migrate" "$LOG" && ok "migrate.sh: applies through the compose migrate service" || bad "migrate.sh: did not run the migrate service"
expect "migrate.sh: from the app container, 200 is ok" "$(APP_UP=1 FUNDS_CODE=200 host)" \
  "ok    GET /rest/v1/funds with the service key, from the app container"
grep -q harness-service-key "$LOG" && bad "migrate.sh: the service key is on a docker command line" || ok "migrate.sh: the service key reaches the app container through the environment, not argv"
expect "migrate.sh: from the app container, 000 (Kong down) is a FAIL" "$(APP_UP=1 FUNDS_CODE=000 host)" \
  "FAIL  GET /rest/v1/funds with the service key, from the app container: expected 200, got 000"
expect "migrate.sh: from the app container, 404 is a FAIL (after retrying)" "$(APP_UP=1 FUNDS_CODE=404 host)/$(grep -c 'app sh -c' "$LOG")" \
  "FAIL  GET /rest/v1/funds with the service key, from the app container: expected 200, got 404/10"
expect "migrate.sh: MIGRATE_CHECK_URL from the environment, unreachable: skip" "$(MIGRATE_CHECK_URL=http://127.0.0.1:1 host)" \
  "skip  GET /rest/v1/funds: Kong unreachable from http://127.0.0.1:1 (set MIGRATE_CHECK_URL to where Kong answers)"
echo "MIGRATE_CHECK_URL=http://127.0.0.1:1" >> "$tmp/repo/deploy/local/.env"
expect "migrate.sh: MIGRATE_CHECK_URL from .env, unreachable: skip" "$(APP_UP=1 FUNDS_CODE=200 host)" \
  "skip  GET /rest/v1/funds: Kong unreachable from http://127.0.0.1:1 (set MIGRATE_CHECK_URL to where Kong answers)"
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
dump_gone() { log_has 'exec -T db rm -f /tmp/restore.dump'; }
staging_dropped() { log_has "rm -rf /var/lib/storage/.restore-staging'?$"; }
expect "restore: succeeds" "$(restore "$all" "")" 0
dump_gone && ok "restore: removes /tmp/restore.dump from the db container after success" || bad "restore: left the dump behind"
log_has '^up -d$' && ok "restore: brings the stack up after success" || bad "restore: no final up -d"
for step in "-f /dev/null" "tar -tzvf" "tar -xzf" "--clean"; do
  expect "restore: fails when '$step' fails" "$(restore "$all" "$step")" 1
  if log_has '^start auth rest storage app scheduler$' && ! log_has '^up -d$'; then
    ok "restore: before the commit, '$step' failing restarts what was running"
  else bad "restore: '$step' failing did not restart the writers"; fi
  dump_gone || bad "restore: left the dump behind after '$step' failed"
  case "$step" in
    "tar -xzf"|--clean) staging_dropped && ok "restore: drops the partial staging copy after '$step' fails" || bad "restore: kept staging after '$step'" ;;
    *) staging_dropped && bad "restore: touched staging before staging began ('$step')" || true ;;
  esac
done
expect "restore: fails when the swap fails" "$(restore "$all" "-s -- /var/lib/storage")" 1
if ! log_has '^(start|up -d$)' && grep -q "RESTORE INCOMPLETE" "$tmp/restore.out" && grep -q ".restore-old" "$tmp/restore.out"; then
  ok "restore: after the commit, a failed swap leaves the writers stopped and says how to finish"
else bad "restore: a failed swap restarted writers or printed no recovery message"; fi
if dump_gone && ! staging_dropped; then ok "restore: after a failed swap, removes the dump but keeps staging (the backup's files)"
else bad "restore: wrong cleanup after a failed swap"; fi

export DB_RELS="funds newer_table"
expect "restore: refuses a stack ahead of the backup" "$(restore "$all" "")" 1
if grep -q newer_table "$tmp/restore.out" && ! log_has '^stop ' && dump_gone; then ok "restore: names the extra relation, stops nothing, removes the dump"
else bad "restore: did not refuse cleanly"; fi
expect "restore: --force restores anyway" "$(restore "$all" "" --force)" 0
export DB_RELS="funds"
for step in "select c.relname" "pg_restore -l /tmp/restore.dump"; do
  expect "restore: aborts when listing relations fails ($step)" "$(restore "$all" "$step")" 1
  log_has '^stop ' && bad "restore: went on to stop writers after '$step' failed (fails open)" || ok "restore: stops nothing after '$step' fails"
done

# ── 3. The swap itself, with real moves ─────────────────────────────────────────────────────────
mkdir -p "$tmp/fake"
cat > "$tmp/fake/mv" <<'EOF2'
#!/bin/sh
# Fails any move of an entry named fail-*; every other move is the real one.
for a in "$@"; do case "${a##*/}" in fail-*) echo "mv: refusing $a (harness)" >&2; exit 1 ;; esac; done
exec /bin/mv "$@"
EOF2
chmod +x "$tmp/fake/mv"
swap() {   # swap <case>: run the real script on $tmp/vol/<case> inside the storage image
  "$real_docker" run --rm -i --label "ao.session=${AO_SESSION:-}" -v "$tmp/vol/$1:/vol" -v "$tmp/fake:/fake:ro" \
    -e PATH=/fake:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin --entrypoint sh \
    supabase/storage-api:v1.74.0 -s -- /vol < "$here/scripts/swap-staged-files.sh" >/dev/null 2>&1 && echo 0 || echo 1
}
layout() {  # layout <case> <live entry> <staged entry>
  mkdir -p "$tmp/vol/$1/stub/$2" "$tmp/vol/$1/.restore-staging/stub/$3" "$tmp/vol/$1/.restore-staging/.dotdir"
  echo old > "$tmp/vol/$1/stub/$2/f"; echo new > "$tmp/vol/$1/.restore-staging/stub/$3/f"
  mkdir -p "$tmp/vol/$1/$2-top" "$tmp/vol/$1/.restore-staging/$3-top"
}
layout ok live new
expect "swap: succeeds" "$(swap ok)" 0
[[ -f "$tmp/vol/ok/stub/new/f" && -d "$tmp/vol/ok/new-top" && -d "$tmp/vol/ok/.dotdir" && ! -e "$tmp/vol/ok/live-top" \
   && ! -e "$tmp/vol/ok/.restore-old" && ! -e "$tmp/vol/ok/.restore-staging" ]] \
  && ok "swap: the backup's files (dotfiles included) replace the live ones, staging cleaned up" || bad "swap: wrong result on success"
layout live fail-live new
expect "swap: a live file that will not move fails it" "$(swap live)" 1
[[ -d "$tmp/vol/live/.restore-old" && -f "$tmp/vol/live/.restore-staging/stub/new/f" && -d "$tmp/vol/live/fail-live-top" ]] \
  && ok "swap: ...and keeps .restore-old, .restore-staging and the unmoved file" || bad "swap: deleted something after a failed live move"
layout staged live fail-new
expect "swap: a staged file that will not move fails it" "$(swap staged)" 1
[[ -f "$tmp/vol/staged/.restore-old/stub/live/f" && -d "$tmp/vol/staged/.restore-staging/fail-new-top" ]] \
  && ok "swap: ...and keeps the previous files in .restore-old and the unmoved backup file in staging" || bad "swap: deleted something after a failed staged move"

# ── 4/5. The resolved compose config (static) ───────────────────────────────────────────────────
config() {
  env POSTGRES_PASSWORD=x JWT_SECRET=x ANON_KEY=x SERVICE_ROLE_KEY=x ENCRYPTION_KEY=x CRON_SECRET=x "$@" \
    "$real_docker" compose -f "$here/docker-compose.yml" --env-file /dev/null config --format json > "$tmp/config.json"
}
cfg() { python3 -c 'import json, sys; s = json.load(open(sys.argv[1]))["services"]; print(eval(sys.argv[2]))' "$tmp/config.json" "$@"; }
config
expect "kong: DNS valid/stale/not-found TTLs keep restarted services reachable (5 0 1)" \
  "$(cfg '" ".join(str(s["kong"]["environment"].get(k)) for k in ("KONG_DNS_VALID_TTL", "KONG_DNS_STALE_TTL", "KONG_DNS_NOT_FOUND_TTL"))')" "5 0 1"

expect "app: waits for migrate to exit 0" "$(cfg 's["app"]["depends_on"]["migrate"]["condition"]')" service_completed_successfully
expect "migrate: one-shot (restart no), the db's image, no ports, no build" \
  "$(cfg 's["migrate"]["restart"], s["migrate"]["image"] == s["db"]["image"], "ports" in s["migrate"], "build" in s["migrate"]')" "('no', True, False, False)"
expect "migrate: waits for db, auth and storage to be healthy" \
  "$(cfg 'sorted((k, v["condition"]) for k, v in s["migrate"]["depends_on"].items())')" \
  "[('auth', 'service_healthy'), ('db', 'service_healthy'), ('storage', 'service_healthy')]"
expect "migrate: mounts exactly supabase/migrations and its script, read-only (never pending-deploy)" \
  "$(cfg 'sorted((v["type"], v["source"].replace(sys.argv[3], ""), v["target"], v.get("read_only")) for v in s["migrate"]["volumes"])' "$(cd "$here/../.." && pwd)")" \
  "[('bind', '/deploy/local/scripts/migrate-inner.sh', '/usr/local/bin/migrate-inner.sh', True), ('bind', '/supabase/migrations', '/migrations', True)]"
expect "migrate: runs migrate-inner.sh with the PG* environment" \
  "$(cfg 's["migrate"]["entrypoint"], sorted(s["migrate"]["environment"].items())')" \
  "(['bash', '/usr/local/bin/migrate-inner.sh'], [('PGDATABASE', 'postgres'), ('PGHOST', 'db'), ('PGPASSWORD', 'x'), ('PGUSER', 'postgres')])"
expect "auth: TOTP MFA enrol and verify on" \
  "$(cfg 's["auth"]["environment"]["GOTRUE_MFA_TOTP_ENROLL_ENABLED"], s["auth"]["environment"]["GOTRUE_MFA_TOTP_VERIFY_ENABLED"]')" "('true', 'true')"
expect "auth: mailer autoconfirm off and no external hosts by default" \
  "$(cfg 's["auth"]["environment"]["GOTRUE_MAILER_AUTOCONFIRM"], s["auth"]["environment"]["GOTRUE_MAILER_EXTERNAL_HOSTS"]')" "('false', '')"
config MAILER_AUTOCONFIRM=true MAILER_EXTERNAL_HOSTS=cap.example.com
expect "auth: MAILER_AUTOCONFIRM and MAILER_EXTERNAL_HOSTS from .env reach GoTrue" \
  "$(cfg 's["auth"]["environment"]["GOTRUE_MAILER_AUTOCONFIRM"], s["auth"]["environment"]["GOTRUE_MAILER_EXTERNAL_HOSTS"]')" "('true', 'cap.example.com')"

echo "$pass passed, $failed failed"
((failed == 0))
