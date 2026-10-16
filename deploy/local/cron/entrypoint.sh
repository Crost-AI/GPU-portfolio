#!/bin/sh
set -eu
: "${CRON_SECRET:?CRON_SECRET is not set}"
umask 077
# run-cron sources this file (crond gives jobs no environment), so each value is single-quoted
# with any ' inside escaped: a secret containing a quote must stay data, not become shell.
q() { printf '%s' "$1" | sed "s/'/'\\\\''/g"; }
printf "CRON_SECRET='%s'\nAPP_URL='%s'\nexport CRON_SECRET APP_URL\n" "$(q "$CRON_SECRET")" "$(q "${APP_URL:-http://app:3000}")" > /run/cron.env
chmod +x /usr/local/bin/run-cron
echo "scheduler: $(grep -c '^[^#]' /etc/crontabs/root) jobs, UTC, calling ${APP_URL:-http://app:3000}"
exec crond -f -l 8 -c /etc/crontabs
