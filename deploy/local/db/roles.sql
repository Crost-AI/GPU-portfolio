-- From github.com/supabase/supabase/docker/volumes/db/roles.sql, minus supabase_functions_admin
-- (created by the webhooks init script, which this stack leaves out: no edge functions). An error
-- here aborts the image's own init migrations, so every role named must exist.
\set pgpass `echo "$POSTGRES_PASSWORD"`

ALTER USER authenticator WITH PASSWORD :'pgpass';
ALTER USER pgbouncer WITH PASSWORD :'pgpass';
ALTER USER supabase_auth_admin WITH PASSWORD :'pgpass';
ALTER USER supabase_storage_admin WITH PASSWORD :'pgpass';
