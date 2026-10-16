-- From github.com/supabase/supabase/docker/volumes/db/jwt.sql.
\set jwt_exp `echo "$JWT_EXP"`

ALTER DATABASE postgres SET "app.settings.jwt_exp" TO :'jwt_exp';
