-- Public-beta feedback and bug reports (anyone, signed in or not), triaged by staff in /moderation/feedback.
-- The message is stored with phone numbers and emails removed; `contact` holds a reply address only when the
-- person ticked "you may contact me". IP and device are kept as hashes, for the hourly limits only.
create table feedback (
  id uuid primary key,
  category text not null check (category in ('bug', 'idea', 'other')),
  message text not null check (char_length(message) between 1 and 2000),
  page_path text check (page_path is null or char_length(page_path) <= 300),
  flags text[] not null default '{}',
  user_id uuid references users(id) on delete set null,
  contact_ok boolean not null default false,
  contact text check (contact is null or char_length(contact) <= 120),
  ip_hash text not null,
  device_hash text,
  status text not null default 'open' check (status in ('open', 'triaged', 'closed')),
  staff_note text check (staff_note is null or char_length(staff_note) <= 1000),
  updated_by uuid references users(id),
  updated_at timestamptz,
  created_at timestamptz not null default now(),
  check (contact is null or contact_ok)
);
create index feedback_status on feedback (status, created_at);
create index feedback_ip on feedback (ip_hash, created_at);
create index feedback_device on feedback (device_hash, created_at) where device_hash is not null;

-- RLS in the 016 style. The public form inserts in system context (its hourly limits count other senders' rows), so
-- app_user never inserts or deletes. Staff routes run as app_user: staff read every row and change only the triage
-- columns; a signed-in person reads their own.
alter table feedback enable row level security;
create policy fb_read on feedback for select to app_user using (user_id = app_user_id() or app_is_staff());
create policy fb_staff_update on feedback for update to app_user using (app_is_staff()) with check (app_is_staff());
revoke all on feedback from app_user;
grant select on feedback to app_user;
grant update (status, staff_note, updated_by, updated_at) on feedback to app_user;
