-- Replay detection across a token family. When a refresh token is replayed, every token of that
-- (client, user) pair is marked before the live ones are revoked, and a rotation still minting
-- re-reads the token it claimed after inserting its new pair: marked means a replay happened
-- meanwhile, so it revokes that pair too. revoked_at cannot say this: a token already claimed is
-- skipped by the revoke, and it is often not the token that was replayed.
--
-- Expand-only and safe ahead of the deploy: a nullable column the current release never reads.
-- oauth_tokens is service-role only, so no grant changes.
alter table public.oauth_tokens add column if not exists replayed_at timestamptz;
