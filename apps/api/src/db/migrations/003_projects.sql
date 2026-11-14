-- Release 2: projects, documents, RFIs, catalog and rates, estimates and review, record-only payments (spec §7–§12, §14.1).

alter table users drop constraint if exists users_staff_role_check;
alter table users add constraint users_staff_role_check check (staff_role in ('moderator', 'ops_admin', 'qs_reviewer', 'support'));

-- ---------------------------------------------------------------- projects and access (§7)
create table projects (
  id uuid primary key,
  owner_org_id uuid not null references organizations(id),
  name text not null,
  building_use text,
  class_code text,
  area_code text,
  region_code text,
  brief jsonb not null default '{}',
  currency text not null,
  currency_locked boolean not null default false,
  status text not null default 'active' check (status in ('active', 'archived')),
  version int not null default 1,
  created_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table project_members (
  project_id uuid not null references projects(id),
  user_id uuid not null references users(id),
  role text not null check (role in ('owner', 'manager', 'collaborator', 'viewer', 'reviewer')),
  added_by uuid references users(id),
  created_at timestamptz not null default now(),
  primary key (project_id, user_id)
);

create table project_invitations (
  id uuid primary key,
  project_id uuid not null references projects(id),
  phone_e164 text not null,
  role text not null check (role in ('manager', 'collaborator', 'viewer')),
  invited_by uuid not null references users(id),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'revoked', 'expired')),
  expires_at timestamptz not null,
  accepted_by uuid references users(id),
  created_at timestamptz not null default now()
);

-- Reason-coded, time-boxed staff access (§7.6).
create table staff_access_sessions (
  id uuid primary key,
  user_id uuid not null references users(id),
  project_id uuid not null references projects(id),
  reason_code text not null,
  ticket text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table reviewer_qualifications (
  id uuid primary key,
  user_id uuid not null references users(id),
  class_code text not null,
  credential text not null,
  valid_until date,
  recorded_by uuid not null references users(id),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- documents (§10.2, §12)
create table documents (
  id uuid primary key,
  project_id uuid not null references projects(id),
  doc_type text not null,
  discipline text not null,
  number text,
  title text not null,
  current_revision_id uuid,
  restricted boolean not null default false,   -- owner/manager only (DocumentAccessPolicy, §7.2)
  created_by uuid not null references users(id),
  created_at timestamptz not null default now()
);

create table document_revisions (
  id uuid primary key,
  document_id uuid not null references documents(id),
  project_id uuid not null references projects(id),
  revision_label text not null,
  issued_date date,
  status_label text,
  status_set_by uuid references users(id),
  status_basis text,
  storage_key text not null,
  original_name text not null,
  declared_type text,
  detected_type text,
  bytes bigint,
  sha256 text,
  pages int,
  page_sizes jsonb,
  state text not null default 'awaiting_upload' check (state in ('awaiting_upload', 'quarantined', 'scanning', 'processing', 'available', 'failed', 'rejected')),
  state_detail text,
  attempts int not null default 0,
  supersedes_revision_id uuid references document_revisions(id),
  superseded_by_revision_id uuid references document_revisions(id),
  uploaded_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  available_at timestamptz
);
create index document_revisions_doc on document_revisions (document_id, created_at);
create index document_revisions_hash on document_revisions (project_id, sha256);

create table calibrations (
  id uuid primary key,
  revision_id uuid not null references document_revisions(id),
  project_id uuid not null references projects(id),
  page int not null,
  data jsonb not null,
  created_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  current boolean not null default true
);

create table measurements (
  id uuid primary key,
  project_id uuid not null references projects(id),
  revision_id uuid not null references document_revisions(id),
  page int not null,
  kind text not null check (kind in ('count', 'linear', 'perimeter', 'area', 'volume', 'manual')),
  label text not null,
  layer text not null default 'architectural',
  geometry jsonb not null default '{}',
  value numeric(18,6) not null,
  unit text not null,
  derivation text not null,
  calibration_id uuid references calibrations(id),
  potentially_affected boolean not null default false,
  confirmed boolean not null default false,
  author uuid not null references users(id),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index measurements_rev on measurements (revision_id, page);

create table rfis (
  id uuid primary key,
  project_id uuid not null references projects(id),
  number int not null,
  subject text not null,
  revision_id uuid references document_revisions(id),
  page int,
  measurement_id uuid references measurements(id),
  estimate_line_id uuid,
  assignee_user_id uuid references users(id),
  due_date date,
  status text not null default 'open' check (status in ('open', 'answered', 'closed')),
  created_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  unique (project_id, number)
);

-- Questions, responses and decisions are immutable history (§10.2 step 5).
create table rfi_entries (
  id uuid primary key,
  rfi_id uuid not null references rfis(id),
  project_id uuid not null references projects(id),
  kind text not null check (kind in ('question', 'response', 'decision', 'note')),
  body text not null,
  author uuid not null references users(id),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- catalog and rates (§11.3)
create table catalog_items (
  id uuid primary key,
  code text not null unique,
  name text not null,
  section text not null,
  unit text not null,
  rate_category text not null check (rate_category in ('volatile', 'general', 'labour')),
  specification text,
  status text not null default 'active' check (status in ('active', 'retired')),
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);

create table rate_observations (
  id uuid primary key,
  catalog_item_id uuid not null references catalog_items(id),
  region_code text not null,
  unit text not null,
  source_class text not null,
  rate_minor numeric(20,6) not null check (rate_minor >= 0),
  currency text not null,
  observed_at timestamptz not null,
  valid_until timestamptz,
  includes_delivery boolean not null default false,
  includes_tax boolean not null default false,
  reference text not null,
  recorded_by uuid references users(id),
  created_at timestamptz not null default now()
);
create index rate_observations_item on rate_observations (catalog_item_id, region_code, unit);

-- ---------------------------------------------------------------- estimates (§9.1, §10.3, §11)
create table estimates (
  id uuid primary key,
  project_id uuid not null references projects(id),
  maturity text not null check (maturity in ('indicative', 'client_specified', 'reviewed_cost_plan')),
  title text not null,
  current_version_id uuid,
  created_by uuid not null references users(id),
  created_at timestamptz not null default now()
);

create table estimate_versions (
  id uuid primary key,
  estimate_id uuid not null references estimates(id),
  project_id uuid not null references projects(id),
  number int not null,
  state text not null,
  contingency_pct numeric(6,3) not null default 0,
  assumptions jsonb not null default '[]',
  exclusions jsonb not null default '[]',
  change_reason text,
  valid_until timestamptz,
  currency text not null,
  totals jsonb,
  calculation_version text,
  jurisdiction_pack_version text not null,
  indicative jsonb,
  snapshot jsonb,
  snapshot_hash text,
  reviewer_user_id uuid references users(id),
  second_reviewer_user_id uuid references users(id),
  second_review_done boolean not null default false,
  reviewed_at timestamptz,
  issued_at timestamptz,
  accepted_at timestamptz,
  accepted_by uuid references users(id),
  created_from_version_id uuid references estimate_versions(id),
  version int not null default 1,
  created_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (estimate_id, number)
);

create table estimate_lines (
  id uuid primary key,
  version_id uuid not null references estimate_versions(id),
  project_id uuid not null references projects(id),
  line_key uuid not null,           -- stable across versions, for the change summary
  position int not null,
  section text not null,
  description text not null,
  specification text,
  unit text not null,
  original_unit text,
  gross numeric(18,6) not null default 0,
  deductions numeric(18,6) not null default 0,
  waste_pct numeric(6,3) not null default 0,
  rates jsonb not null default '{}',
  tax_rate_pct numeric(6,3) not null default 0,
  status text not null default 'measured' check (status in ('measured', 'provisional', 'excluded', 'clarification_required')),
  quantity_source text check (quantity_source in ('measurement', 'client_entered', 'imported', 'provisional_sum')),
  rate_source jsonb,
  rate_category text not null default 'general' check (rate_category in ('volatile', 'general', 'labour')),
  catalog_item_id uuid references catalog_items(id),
  measurement_ids uuid[] not null default '{}',
  notes text,
  row_version int not null default 1,
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);
create index estimate_lines_version on estimate_lines (version_id, position);

create table review_assignments (
  id uuid primary key,
  version_id uuid not null references estimate_versions(id),
  project_id uuid not null references projects(id),
  reviewer_user_id uuid not null references users(id),
  kind text not null check (kind in ('primary', 'second')),
  status text not null default 'active' check (status in ('active', 'completed', 'released')),
  assigned_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table qa_acknowledgements (
  version_id uuid not null references estimate_versions(id),
  code text not null,
  line_id uuid,
  reason text not null,
  acknowledged_by uuid not null references users(id),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- record-only payments (§14.1)
create table payment_records (
  id uuid primary key,
  project_id uuid not null references projects(id),
  payee text not null,
  description text not null,
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null,
  paid_on date not null,
  method text not null,
  reference text,
  proof_revision_id uuid references document_revisions(id),
  recorded_by uuid not null references users(id),
  acknowledged_by uuid references users(id),
  acknowledged_at timestamptz,
  voided_at timestamptz,
  void_reason text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- row-level security (§7.5): projects are visible to members
-- and to staff holding a live, reason-coded access session.
create or replace function app_user_projects() returns setof uuid language sql stable security definer set search_path = public as $$
  select project_id from project_members where user_id = app_user_id()
  union
  select project_id from staff_access_sessions where user_id = app_user_id() and expires_at > now()
$$;

alter table projects enable row level security;
create policy pj_member on projects for all to app_user
  using (id in (select app_user_projects()))
  with check (owner_org_id in (select app_user_orgs()) or id in (select app_user_projects()));

do $$
declare t text;
begin
  foreach t in array array['project_members', 'documents', 'document_revisions', 'calibrations', 'measurements', 'rfis', 'rfi_entries', 'estimates', 'estimate_versions', 'estimate_lines', 'review_assignments', 'payment_records', 'project_invitations'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy %I on %I for all to app_user using (project_id in (select app_user_projects())) with check (project_id in (select app_user_projects()))', t || '_member', t);
  end loop;
end $$;

alter table staff_access_sessions enable row level security;
create policy sas_self on staff_access_sessions for all to app_user using (user_id = app_user_id()) with check (user_id = app_user_id());

-- A new owner adds themself as the first member before membership exists.
create or replace function app_created_project(pid uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from projects where id = pid and created_by = app_user_id())
    and not exists (select 1 from project_members where project_id = pid)
$$;
create policy project_members_bootstrap on project_members for insert to app_user
  with check (user_id = app_user_id() and role = 'owner' and app_created_project(project_id));

-- Invitations are addressed to a phone number: the invitee is not a member yet, so these two narrow functions
-- read and answer only invitations for the caller's own verified number.
create or replace function my_project_invitations() returns table (id uuid, project_name text, role text, invited_by_name text, expires_at timestamptz)
language sql stable security definer set search_path = public as $$
  select i.id, p.name, i.role, u.display_name, i.expires_at
    from project_invitations i join projects p on p.id = i.project_id join users u on u.id = i.invited_by
   where i.status = 'pending' and i.expires_at > now() and p.status = 'active'
     and i.phone_e164 = (select phone_e164 from users where id = app_user_id() and phone_verified_at is not null)
$$;

create or replace function respond_project_invitation(inv uuid, accept boolean) returns uuid
language plpgsql security definer set search_path = public as $$
declare r record; me uuid := app_user_id();
begin
  select i.* into r from project_invitations i
   where i.id = inv and i.status = 'pending' and i.expires_at > now()
     and i.phone_e164 = (select phone_e164 from users where id = me and phone_verified_at is not null)
   for update;
  if not found then return null; end if;
  update project_invitations set status = case when accept then 'accepted' else 'revoked' end, accepted_by = case when accept then me end where id = inv;
  if accept then
    insert into project_members (project_id, user_id, role, added_by) values (r.project_id, me, r.role, r.invited_by)
      on conflict (project_id, user_id) do nothing;
  end if;
  return r.project_id;
end $$;

grant execute on function my_project_invitations() to app_user;
grant execute on function respond_project_invitation(uuid, boolean) to app_user;
grant select, insert, update, delete on all tables in schema public to app_user;
revoke update, delete on rfi_entries from app_user;
revoke all on project_invitations from app_user;
grant select, insert, update on project_invitations to app_user;
