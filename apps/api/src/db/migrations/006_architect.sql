-- AI architect reviews of generated designs. Server-only: no grants to app_user; read and written in system context.
-- Cached by plot, brief, design-engine version and model, so the same request is paid for once.
create table architect_reviews (
  cache_key text primary key,
  model text not null,
  review jsonb not null,
  created_at timestamptz not null default now()
);
create index architect_reviews_created on architect_reviews (created_at);
