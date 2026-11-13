-- Release 1: construction marketplace website (spec §3).

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'app_user') then create role app_user nologin; end if;
end $$;
grant app_user to current_user;
grant usage on schema public to app_user;

create or replace function app_user_id() returns uuid language sql stable as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;

-- ---------------------------------------------------------------- identity
create table users (
  id uuid primary key,
  phone_e164 text unique,
  phone_verified_at timestamptz,
  display_name text not null,
  email text,
  status text not null default 'active' check (status in ('active', 'suspended', 'deleted')),
  is_staff boolean not null default false,
  staff_role text check (staff_role in ('moderator', 'ops_admin')),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz
);

create table organizations (
  id uuid primary key,
  kind text not null check (kind in ('personal', 'business')),
  name text not null,
  handle text not null unique,
  reserved_name boolean not null default false,
  business_email text,
  area_code text,
  business_address text,           -- published only if publish_address
  publish_address boolean not null default false,
  business_hours text,
  chat_only boolean not null default false,
  created_by uuid not null references users(id),
  created_at timestamptz not null default now()
);

create table org_members (
  org_id uuid not null references organizations(id),
  user_id uuid not null references users(id),
  role text not null check (role in ('owner', 'admin', 'member', 'billing')),
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

create table sessions (
  id uuid primary key,
  user_id uuid not null references users(id),
  device_label text,
  device_id text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table otp_codes (
  id uuid primary key,
  phone_e164 text not null,
  code_hash text not null,
  attempts int not null default 0,
  ip text,
  device_id text,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index otp_codes_phone on otp_codes (phone_e164, created_at desc);

create table verification_checks (
  id uuid primary key,
  org_id uuid not null references organizations(id),
  check_type text not null check (check_type in ('identity_contact', 'business_registration', 'professional_credential', 'trade_reference', 'stock_evidence')),
  state text not null check (state in ('passed', 'failed', 'expired', 'revoked')),
  source text not null,
  checked_by uuid references users(id),
  checked_at timestamptz not null default now(),
  expires_at timestamptz,
  note text
);

-- ---------------------------------------------------------------- categories (configuration, versioned)
create table categories (
  slug text primary key,
  parent_slug text references categories(slug),
  name text not null,
  current_version int not null,
  status text not null default 'active' check (status in ('active', 'retired')),
  sort int not null default 0
);

create table category_versions (
  slug text not null references categories(slug),
  version int not null,
  definition jsonb not null,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  primary key (slug, version)
);

-- ---------------------------------------------------------------- listings
create table listings (
  id uuid primary key,
  short_id text not null unique,
  seller_org_id uuid not null references organizations(id),
  created_by uuid not null references users(id),
  category_slug text not null references categories(slug),
  category_version int not null,
  listing_type text not null,
  status text not null check (status in ('draft', 'in_review', 'live', 'rejected', 'expired', 'closed', 'blocked')),
  title text not null,
  description text not null default '',
  attributes jsonb not null default '{}',
  price_minor bigint,
  currency text not null,
  unit text not null,
  negotiable boolean not null default false,
  quote_on_request boolean not null default false,
  pack_value numeric,
  pack_unit text,
  compare_key text,
  per_base_minor numeric,
  region_code text not null,
  area_code text not null,
  service_areas text[] not null default '{}',
  lat double precision not null,
  lng double precision not null,
  delivery_offered boolean not null default false,
  price_confirmed_at timestamptz not null default now(),
  published_at timestamptz,
  expires_at timestamptz,
  closed_at timestamptz,
  close_reason text,
  rejection_code text,
  rejection_note text,
  risk_score int not null default 0,
  signals jsonb not null default '[]',
  completeness int not null default 0,
  views int not null default 0,
  contacts int not null default 0,
  version int not null default 1,
  search tsvector generated always as (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(jsonb_to_tsvector('simple', attributes, '["string"]'), 'B') ||
    setweight(to_tsvector('simple', coalesce(description, '')), 'C')
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index listings_live on listings (status, category_slug, area_code);
create index listings_search on listings using gin (search);
create index listings_seller on listings (seller_org_id, status);
create index listings_compare on listings (compare_key, region_code) where status = 'live';

create table listing_versions (
  listing_id uuid not null references listings(id),
  version int not null,
  snapshot jsonb not null,
  material boolean not null default false,
  created_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  primary key (listing_id, version)
);

create table listing_photos (
  id uuid primary key,
  listing_id uuid references listings(id),
  owner_org_id uuid not null references organizations(id),
  uploaded_by uuid not null references users(id),
  position int not null default 0,
  status text not null default 'ready' check (status in ('ready', 'rejected', 'removed')),
  width int, height int,
  dhash text not null,
  alt_text text,
  bytes int not null,
  created_at timestamptz not null default now()
);
create index listing_photos_listing on listing_photos (listing_id, position);
create index listing_photos_dhash on listing_photos (dhash);

create table listing_status_events (
  id uuid primary key,
  listing_id uuid not null references listings(id),
  from_status text, to_status text not null, command text not null,
  actor_user_id uuid references users(id),
  reason_code text, note text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- buyer features
create table favourites (
  user_id uuid not null references users(id),
  listing_id uuid not null references listings(id),
  created_at timestamptz not null default now(),
  primary key (user_id, listing_id)
);

create table saved_searches (
  id uuid primary key,
  user_id uuid not null references users(id),
  label text not null,
  query jsonb not null,
  frequency text not null default 'daily' check (frequency in ('instant', 'daily', 'off')),
  last_checked_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table threads (
  id uuid primary key,
  listing_id uuid not null references listings(id),
  listing_version int not null,
  buyer_user_id uuid not null references users(id),
  seller_org_id uuid not null references organizations(id),
  buyer_blocked boolean not null default false,
  seller_blocked boolean not null default false,
  first_seller_reply_at timestamptz,
  created_at timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  unique (listing_id, buyer_user_id)
);

create table messages (
  id uuid primary key,
  thread_id uuid not null references threads(id),
  sender_user_id uuid not null references users(id),
  body text not null,
  safety_flags jsonb not null default '[]',
  held boolean not null default false,
  created_at timestamptz not null default now()
);
create index messages_thread on messages (thread_id, created_at);

create table thread_reads (
  thread_id uuid not null references threads(id),
  user_id uuid not null references users(id),
  read_at timestamptz not null default now(),
  primary key (thread_id, user_id)
);

create table contact_reveals (
  id uuid primary key,
  listing_id uuid not null references listings(id),
  seller_org_id uuid not null references organizations(id),
  viewer_user_id uuid not null references users(id),
  device_id text,
  created_at timestamptz not null default now(),
  prompt_after timestamptz not null,
  confirmed boolean,
  confirmed_at timestamptz
);
create index contact_reveals_viewer on contact_reveals (viewer_user_id, created_at desc);

create table quote_requests (
  id uuid primary key,
  listing_id uuid not null references listings(id),
  listing_version int not null,
  buyer_user_id uuid not null references users(id),
  seller_org_id uuid not null references organizations(id),
  thread_id uuid not null references threads(id),
  quantity numeric not null check (quantity > 0),
  unit text not null,
  delivery_area text not null,
  needed_by date,
  notes text,
  status text not null default 'sent' check (status in ('sent', 'viewed', 'answered', 'declined', 'expired', 'listing_unavailable')),
  answer_price_minor bigint,
  answer_note text,
  answered_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table reviews (
  id uuid primary key,
  seller_org_id uuid not null references organizations(id),
  author_user_id uuid not null references users(id),
  rating int not null check (rating between 1 and 5),
  body text not null,
  basis text not null check (basis in ('chat', 'quote_request', 'contact_reveal')),
  status text not null default 'published' check (status in ('pending', 'published', 'removed')),
  removed_reason text,
  reply_body text,
  reply_at timestamptz,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- moderation and trust
create table reports (
  id uuid primary key,
  target_type text not null check (target_type in ('listing', 'seller', 'message', 'review')),
  target_id uuid not null,
  reason text not null,
  details text,
  priority boolean not null default false,
  reporter_user_id uuid not null references users(id),
  status text not null default 'open' check (status in ('open', 'actioned', 'dismissed')),
  decided_by uuid references users(id),
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz not null default now()
);

create table moderation_decisions (
  id uuid primary key,
  listing_id uuid not null references listings(id),
  listing_version int not null,
  decision text not null check (decision in ('approve', 'reject', 'block', 'overturn', 'uphold')),
  reason_code text,
  note text,
  moderator_user_id uuid not null references users(id),
  qa_sample boolean not null default false,
  created_at timestamptz not null default now()
);

create table seller_restrictions (
  id uuid primary key,
  org_id uuid not null references organizations(id),
  kind text not null check (kind in ('posting_limit', 'chat_limit', 'listing_suspension', 'account_suspension')),
  reason text not null,
  status text not null default 'active' check (status in ('pending_second_approval', 'active', 'expired', 'lifted', 'overturned')),
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  created_by uuid not null references users(id),
  approved_by uuid references users(id),
  created_at timestamptz not null default now()
);

create table appeals (
  id uuid primary key,
  target_type text not null check (target_type in ('moderation_decision', 'restriction')),
  target_id uuid not null unique,         -- one appeal per decision or restriction
  seller_org_id uuid not null references organizations(id),
  submitted_by uuid not null references users(id),
  statement text not null,
  status text not null default 'open' check (status in ('open', 'upheld', 'overturned')),
  original_decider uuid not null references users(id),
  decided_by uuid references users(id),
  decided_at timestamptz,
  note text,
  created_at timestamptz not null default now(),
  check (decided_by is null or decided_by <> original_decider)
);

-- ---------------------------------------------------------------- promotions (the only payments in R1)
create table promotion_purchases (
  id uuid primary key,
  org_id uuid not null references organizations(id),
  listing_id uuid not null references listings(id),
  product_code text not null,
  kind text not null check (kind in ('top', 'package')),
  net_minor bigint not null, tax_minor bigint not null, gross_minor bigint not null, currency text not null,
  status text not null check (status in ('pending_payment', 'paid', 'active', 'paused', 'expired', 'cancelled', 'refunded', 'credited', 'forfeited')),
  remaining_seconds int not null,
  active_since timestamptz,
  ends_at timestamptz,
  slot_weight int not null default 1,
  checkout_ref text unique,
  created_by uuid not null references users(id),
  paid_at timestamptz,
  created_at timestamptz not null default now()
);
create index promotion_active on promotion_purchases (status, listing_id);

create table promotion_credits (
  id uuid primary key,
  org_id uuid not null references organizations(id),
  source_purchase_id uuid not null references promotion_purchases(id),
  seconds int not null,
  kind text not null,
  used_by_purchase_id uuid references promotion_purchases(id),
  created_at timestamptz not null default now()
);

create table platform_fees (
  id uuid primary key,
  purchase_id uuid not null unique references promotion_purchases(id),
  org_id uuid not null references organizations(id),
  invoice_number text not null unique,
  net_minor bigint not null, tax_minor bigint not null, gross_minor bigint not null, currency text not null,
  tax_code text not null, tax_rate_percent numeric not null,
  issued_at timestamptz not null default now()
);

create table payment_webhook_events (
  event_id text primary key,
  provider text not null,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  outcome text
);

-- ---------------------------------------------------------------- platform
create table notifications (
  id uuid primary key,
  user_id uuid not null references users(id),
  kind text not null,
  title text not null,
  body text not null,
  link text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_user on notifications (user_id, created_at desc);

create table outbox (
  event_id uuid primary key,
  event_type text not null,
  payload jsonb not null,
  occurred_at timestamptz not null default now(),
  dispatched_at timestamptz,
  attempts int not null default 0,
  last_error text
);
create index outbox_pending on outbox (occurred_at) where dispatched_at is null;

create table audit_events (
  seq bigserial primary key,
  id uuid not null unique,
  actor_user_id uuid,
  action text not null,
  target_type text not null,
  target_id text not null,
  reason text,
  metadata jsonb not null default '{}',
  prev_hash text not null,
  hash text not null,
  created_at timestamptz not null default now()
);

create table idempotency_keys (
  user_id uuid not null,
  key text not null,
  route text not null,
  request_hash text not null,
  status int not null,
  body jsonb,
  created_at timestamptz not null default now(),
  primary key (user_id, key, route)
);

-- ---------------------------------------------------------------- row-level security for private data
create or replace function app_user_orgs() returns setof uuid language sql stable security definer set search_path = public as $$
  select org_id from org_members where user_id = app_user_id()
$$;
create or replace function app_is_staff() returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select is_staff from users where id = app_user_id()), false)
$$;

alter table threads enable row level security;
create policy th_party on threads for all to app_user
  using (buyer_user_id = app_user_id() or seller_org_id in (select app_user_orgs()) or app_is_staff())
  with check (buyer_user_id = app_user_id() or seller_org_id in (select app_user_orgs()));

alter table messages enable row level security;
create policy msg_party on messages for all to app_user
  using (thread_id in (select id from threads))
  with check (sender_user_id = app_user_id() and thread_id in (select id from threads));

alter table thread_reads enable row level security;
create policy tr_self on thread_reads for all to app_user using (user_id = app_user_id()) with check (user_id = app_user_id());

alter table quote_requests enable row level security;
create policy qr_party on quote_requests for all to app_user
  using (buyer_user_id = app_user_id() or seller_org_id in (select app_user_orgs()) or app_is_staff())
  with check (buyer_user_id = app_user_id() or seller_org_id in (select app_user_orgs()));

alter table contact_reveals enable row level security;
create policy cr_party on contact_reveals for all to app_user
  using (viewer_user_id = app_user_id() or seller_org_id in (select app_user_orgs()) or app_is_staff())
  with check (viewer_user_id = app_user_id());

alter table favourites enable row level security;
create policy fav_self on favourites for all to app_user using (user_id = app_user_id()) with check (user_id = app_user_id());

alter table saved_searches enable row level security;
create policy ss_self on saved_searches for all to app_user using (user_id = app_user_id()) with check (user_id = app_user_id());

alter table notifications enable row level security;
create policy nt_self on notifications for all to app_user using (user_id = app_user_id()) with check (true);

alter table sessions enable row level security;
create policy se_self on sessions for all to app_user using (user_id = app_user_id()) with check (user_id = app_user_id());

grant select, insert, update, delete on all tables in schema public to app_user;
grant usage, select on all sequences in schema public to app_user;
revoke update, delete on audit_events from app_user;
