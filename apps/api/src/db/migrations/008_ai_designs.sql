-- Layouts composed by the AI designer, after BuildWise's checks passed. Server-only: no grants to app_user.
-- Cached by plot, brief, location, prompt and engine versions and model, so the same request is paid for once.
create table ai_designs (
  cache_key text primary key,
  model text not null,
  layouts jsonb not null,
  created_at timestamptz not null default now()
);
create index ai_designs_created on ai_designs (created_at);
