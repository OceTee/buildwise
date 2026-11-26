-- Which design idea a person chose from the concepts they were shown (anonymous session hash, no personal data).
-- BuildWise learns small nudges per idea and taste from these (learnIdeaPriors) so the ideas people like come up more.
create table concept_choices (
  id uuid primary key default gen_random_uuid(),
  session text not null,
  chosen text not null,
  shown text[] not null,
  taste text check (taste in ('simple', 'modern', 'tropical', 'grand')),
  priorities text[] not null default '{}',
  purpose text,
  created_at timestamptz not null default now()
);
create index concept_choices_created on concept_choices (created_at);
create index concept_choices_session on concept_choices (session, created_at);
