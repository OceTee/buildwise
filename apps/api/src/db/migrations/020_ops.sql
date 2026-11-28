-- Observability (spec §21.4). Each outbox event keeps the correlation id of the request or worker cycle that
-- wrote it, so one id follows a problem from the API log to the event and the error report. app_user keeps its
-- insert-only access to outbox (016_rls_marketplace: policy ob_append); the new column needs nothing more.
alter table outbox add column correlation_id text;

-- Heartbeats read by the health checks: the last worker cycle (`worker_cycle`) and the last success and failure
-- of each AI job (`ai:<kind>:ok`, `ai:<kind>:fail`), shared by every serverless instance. Server-only, like the other
-- operational tables in 016: written and read in system context, no app_user access at all.
create table ops_heartbeats (
  name text primary key,
  at timestamptz not null default now(),
  detail jsonb not null default '{}'
);
alter table ops_heartbeats enable row level security;
revoke all on ops_heartbeats from app_user;
