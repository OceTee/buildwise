-- Public beta, data rights and staff access (migration 017, after 016_rls_marketplace) (spec §7.6, §19.1, §20, §28): exports, complete deletion, phone
-- correction, retention jobs, staff roles granted with dual control, and TOTP as a second factor for staff.

-- ---------------------------------------------------------------- deletion and pseudonymisation (§20.3)
alter table users add column if not exists deleted_at timestamptz;
alter table users add column if not exists pseudonymised_at timestamptz;
-- Name, phone and email of a deleted account, held for the retention window (fraud and disputes), then erased.
alter table users add column if not exists erasure_snapshot jsonb;

-- A business whose only owner deleted their account stops trading.
alter table organizations add column if not exists closed_at timestamptz;

-- Chats of deleted users are redacted after the retention window; the thread stays as a record for the other party.
alter table messages add column if not exists redacted_at timestamptz;
alter table quote_requests add column if not exists redacted_at timestamptz;

-- ---------------------------------------------------------------- phone correction
-- A code sent to a new number when a signed-in person changes theirs; sign-in never accepts it.
alter table otp_codes add column if not exists purpose text not null default 'sign_in';
alter table otp_codes drop constraint if exists otp_codes_purpose_check;
alter table otp_codes add constraint otp_codes_purpose_check check (purpose in ('sign_in', 'phone_change'));
alter table otp_codes add column if not exists user_id uuid references users(id);

-- ---------------------------------------------------------------- exports
create table if not exists data_exports (
  id uuid primary key,
  user_id uuid not null references users(id),
  storage_key text not null,
  bytes int not null,
  sha256 text not null,
  created_at timestamptz not null default now(),
  purged_at timestamptz
);
create index if not exists data_exports_user on data_exports (user_id, created_at desc);
alter table data_exports enable row level security;
drop policy if exists dx_self on data_exports;
create policy dx_self on data_exports for all to app_user using (user_id = app_user_id()) with check (user_id = app_user_id());

-- ---------------------------------------------------------------- staff second factor (§19.1)
alter table sessions add column if not exists mfa_at timestamptz;

create table if not exists staff_mfa (
  user_id uuid primary key references users(id),
  secret_enc text not null,
  confirmed_at timestamptz,
  -- The last 30-second step accepted, so a code is never accepted twice.
  last_step bigint not null default 0,
  -- Wrong codes in a row; after too many the factor locks for a while (kept even though the request fails).
  failed_attempts int not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now()
);
alter table staff_mfa enable row level security;
drop policy if exists smfa_self on staff_mfa;
create policy smfa_self on staff_mfa for all to app_user using (user_id = app_user_id()) with check (user_id = app_user_id());

create table if not exists staff_recovery_codes (
  id uuid primary key,
  user_id uuid not null references users(id),
  code_hash text not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists staff_recovery_codes_user on staff_recovery_codes (user_id);
alter table staff_recovery_codes enable row level security;
drop policy if exists src_self on staff_recovery_codes;
create policy src_self on staff_recovery_codes for all to app_user using (user_id = app_user_id()) with check (user_id = app_user_id());

-- Staff powers through row-level security need a session verified by the second factor: the API sets
-- app.staff_verified only for such sessions (or where the second factor is switched off in development).
create or replace function app_is_staff() returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(current_setting('app.staff_verified', true), '') = 'on'
     and coalesce((select is_staff from users where id = app_user_id() and status = 'active'), false)
$$;

-- ---------------------------------------------------------------- staff roles, with dual control (§7.6)
create table if not exists staff_role_changes (
  id uuid primary key,
  target_user_id uuid not null references users(id),
  action text not null check (action in ('grant', 'revoke')),
  role text check (role in ('moderator', 'ops_admin', 'qs_reviewer', 'support')),
  previous_role text,
  reason text not null check (length(trim(reason)) >= 5),
  -- Null only for the command-line bootstrap of the first operations admins.
  requested_by uuid references users(id),
  via text not null default 'staff_screen' check (via in ('staff_screen', 'cli')),
  status text not null check (status in ('pending', 'applied', 'rejected', 'cancelled')),
  decided_by uuid references users(id),
  decision_note text,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  check (action = 'revoke' or role is not null),
  -- Granting ops_admin from the staff screen is applied only by a second operations admin.
  check (not (status = 'applied' and action = 'grant' and role = 'ops_admin' and via = 'staff_screen')
         or (decided_by is not null and requested_by is not null and decided_by <> requested_by)),
  check (requested_by is null or requested_by <> target_user_id)
);
create index if not exists staff_role_changes_pending on staff_role_changes (status, created_at) where status = 'pending';
create unique index if not exists staff_role_changes_one_pending on staff_role_changes (target_user_id) where status = 'pending';

-- ---------------------------------------------------------------- access (016_rls_marketplace style)
-- Signed-in requests run as app_user with row-level security. A person reads and creates their own export records
-- (the worker and account deletion purge them in system context); a staff member reads and updates their own second
-- factor. Role changes are server-only: the staff routes, account deletion and the bootstrap script use system context.
revoke all on data_exports from app_user;
grant select, insert on data_exports to app_user;
revoke all on staff_mfa, staff_recovery_codes from app_user;
grant select, insert, update on staff_mfa to app_user;
grant select, insert, update, delete on staff_recovery_codes to app_user;
alter table staff_role_changes enable row level security;
revoke all on staff_role_changes from app_user;
