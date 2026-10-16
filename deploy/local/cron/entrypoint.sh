#!/bin/sh
set -eu
: "${CRON_SECRET:?CRON_SECRET is not set}"
umask 077
printf "CRON_SECRET='%s'\nAPP_URL='%s'\nexport CRON_SECRET APP_URL\n" "$CRON_SECRET" "${APP_URL:-http://app:3000}" > /run/cron.env
chmod +x /usr/local/bin/run-cron
echo "scheduler: $(grep -c '^[^#]' /etc/crontabs/root) jobs, UTC, calling ${APP_URL:-http://app:3000}"
exec crond -f -l 8 -c /etc/crontabs
