-- Design Studio: the design behind a house-plans listing (an AI-layout file plus the brief and plot it was drawn on),
-- so a buyer can open it on their own plot. One file per listing; it goes when the listing goes.
create table design_files (
  listing_id uuid primary key references listings(id) on delete cascade,
  org_id uuid not null references organizations(id),
  layout jsonb not null,
  brief jsonb not null,
  plot jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index design_files_org on design_files (org_id);

-- Signed-in users see and write only their own organisations' files (staff can read them for moderation).
-- Files of live listings are public, but only through system-context routes (GET /v1/studio/designs/:id).
alter table design_files enable row level security;
create policy df_owner on design_files for all to app_user
  using (org_id in (select app_user_orgs()) or app_is_staff())
  with check (org_id in (select app_user_orgs()));
grant select, insert, update, delete on design_files to app_user;

-- Whether a listing has a design file, without exposing the file itself (the public listing page asks this).
create or replace function listing_has_design_file(lid uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from design_files where listing_id = lid)
$$;
grant execute on function listing_has_design_file(uuid) to app_user;
