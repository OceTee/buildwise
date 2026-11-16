-- The BuildWise assistant: its trained models, knowledge base, and the (redacted) messages it learns from.
-- Server-only tables: no grants to app_user; the API reads and writes them in system context.
create table assistant_models (
  id bigserial primary key,
  model jsonb not null,
  lexicon jsonb not null default '[]',
  domain_words jsonb not null default '[]',
  metrics jsonb not null,
  promoted boolean not null default false,
  note text,
  trained_at timestamptz not null default now()
);
create index assistant_models_promoted on assistant_models (promoted, id desc);

create table assistant_knowledge (
  id text primary key,
  question text not null,
  answer text not null,
  tags text[] not null default '{}',
  source text not null check (source in ('seed', 'staff', 'platform')),
  active boolean not null default true,
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);

create table assistant_messages (
  id uuid primary key,
  session text not null,
  text text not null,
  intent text not null,
  confidence real not null,
  knowledge_id text,
  unanswered boolean not null default false,
  outcome text check (outcome in ('proceeded', 'shopped', 'abandoned')),
  confirmed_intent text,
  label_source text check (label_source in ('outcome', 'staff')),
  changes jsonb,
  helpful boolean,
  created_at timestamptz not null default now(),
  feedback_at timestamptz
);
create index assistant_messages_created on assistant_messages (created_at);
create index assistant_messages_unanswered on assistant_messages (created_at) where unanswered;
