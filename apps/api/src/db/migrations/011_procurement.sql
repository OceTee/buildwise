-- Release 3, first slice: structured procurement (spec §3.17, §9.2–§9.4, §10.4 steps 1–7, §13.1, §14.1).
-- Provider profiles derived from seller storefronts, RFQs with versions and invitations, immutable quote versions,
-- clarifications and record-only orders. Numbered 011 so it never collides with 010 on the builder-ai branch.

-- ---------------------------------------------------------------- provider profile (§3.17: storefront → provider profile)
-- Everything else on a provider profile (categories, service areas, checks, performance) is derived from the
-- organization's live listings, verification checks and history; this row only holds the provider's own settings.
create table provider_profiles (
  org_id uuid primary key references organizations(id),
  accepts_rfqs boolean not null default true,
  capacity_note text,
  updated_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- RFQs (§9.2)
create table rfqs (
  id uuid primary key,
  project_id uuid not null references projects(id),
  number int not null,
  title text not null,
  rfq_type text not null check (rfq_type in ('material', 'trade', 'service', 'logistics')),
  category_slug text not null references categories(slug),
  area_code text not null,
  region_code text not null,
  sourcing_mode text not null check (sourcing_mode in ('open', 'invited')),
  sealed boolean not null,
  state text not null default 'draft' check (state in ('draft', 'published', 'closed', 'awarded', 'cancelled', 'no_award')),
  current_version_id uuid,
  current_version_number int not null default 1,
  deadline timestamptz not null,
  needed_by date,
  notes text,
  scope_maturity text not null check (scope_maturity in ('client_specified', 'reviewed_cost_plan')),
  source_estimate_id uuid references estimates(id),
  source_estimate_version_id uuid references estimate_versions(id),
  source_quote_request_id uuid references quote_requests(id),
  currency text not null,
  assisted_sourcing_requested_at timestamptz,
  assisted_sourcing_note text,
  awarded_quote_version_id uuid,
  order_id uuid,
  close_reason text,
  published_at timestamptz,
  closed_at timestamptz,
  version int not null default 1,
  created_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, number)
);
create index rfqs_deadline on rfqs (state, deadline);

-- Each change to a published RFQ creates a new version; versions and their lines never change afterwards.
create table rfq_versions (
  id uuid primary key,
  rfq_id uuid not null references rfqs(id),
  project_id uuid not null references projects(id),
  number int not null,
  change_reason text,
  changes jsonb not null default '[]',
  deadline timestamptz not null,
  notes text,
  snapshot_hash text,
  created_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  unique (rfq_id, number)
);

create table rfq_lines (
  id uuid primary key,
  rfq_version_id uuid not null references rfq_versions(id),
  rfq_id uuid not null references rfqs(id),
  project_id uuid not null references projects(id),
  line_key uuid not null,
  position int not null,
  section text not null,
  description text not null,
  specification text,
  unit text not null,
  quantity numeric(18,6) not null check (quantity > 0),
  pack_value numeric,
  pack_unit text,
  provenance jsonb not null
);
create index rfq_lines_version on rfq_lines (rfq_version_id, position);

-- Every match run keeps the eligibility reasons, factors and weights that produced it (§13.1.3).
create table rfq_match_runs (
  id uuid primary key,
  rfq_id uuid not null references rfqs(id),
  project_id uuid not null references projects(id),
  ranking_version text not null,
  deadline timestamptz not null,
  result jsonb not null,
  created_by uuid not null references users(id),
  created_at timestamptz not null default now()
);

create table rfq_invitations (
  id uuid primary key,
  rfq_id uuid not null references rfqs(id),
  project_id uuid not null references projects(id),
  provider_org_id uuid not null references organizations(id),
  state text not null default 'invited' check (state in ('invited', 'viewed', 'quoted', 'declined', 'revoked')),
  source text not null check (source in ('matched', 'quote_request')),
  quote_request_id uuid references quote_requests(id),
  match_run_id uuid references rfq_match_runs(id),
  match jsonb,
  decline_reason text,
  invited_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  viewed_at timestamptz,
  responded_at timestamptz,
  unique (rfq_id, provider_org_id)
);
create index rfq_invitations_provider on rfq_invitations (provider_org_id, created_at desc);

-- ---------------------------------------------------------------- quotes (§9.3)
create table quotes (
  id uuid primary key,
  rfq_id uuid not null references rfqs(id),
  project_id uuid not null references projects(id),
  provider_org_id uuid not null references organizations(id),
  invitation_id uuid not null references rfq_invitations(id),
  current_version_id uuid,
  -- Mirrors the state of the newest non-draft version, so a sealed RFQ can show count and status without prices.
  status text not null default 'draft',
  created_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (rfq_id, provider_org_id)
);

create table quote_versions (
  id uuid primary key,
  quote_id uuid not null references quotes(id),
  rfq_id uuid not null references rfqs(id),
  project_id uuid not null references projects(id),
  provider_org_id uuid not null references organizations(id),
  number int not null,
  rfq_version_number int not null,
  state text not null default 'draft' check (state in ('draft', 'submitted', 'needs_revision', 'revised', 'withdrawn', 'expired', 'rejected', 'accepted')),
  currency text not null,
  delivery_minor bigint not null default 0 check (delivery_minor >= 0),
  delivery_tax_rate_pct numeric(6,3) not null default 0,
  valid_until date,
  payment_terms text,
  warranty text,
  lead_time_days int,
  exclusions jsonb not null default '[]',
  notes text,
  totals jsonb,
  snapshot jsonb,
  snapshot_hash text,
  submitted_at timestamptz,
  submitted_by uuid references users(id),
  version int not null default 1,
  created_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (quote_id, number)
);

create table quote_lines (
  id uuid primary key,
  quote_version_id uuid not null references quote_versions(id),
  quote_id uuid not null references quotes(id),
  project_id uuid not null references projects(id),
  provider_org_id uuid not null references organizations(id),
  rfq_line_key uuid not null,
  position int not null,
  status text not null check (status in ('priced', 'excluded')),
  offered text,
  is_substitution boolean not null default false,
  substitution_note text,
  unit text not null,
  quantity numeric(18,6) not null default 0,
  pack_value numeric,
  pack_unit text,
  unit_price_minor bigint not null default 0 check (unit_price_minor >= 0),
  tax_rate_pct numeric(6,3) not null default 0,
  availability text,
  lead_time_days int,
  unique (quote_version_id, rfq_line_key)
);

-- A submitted quote version is immutable (§9.3, §8.6): its terms, lines and snapshot never change; only its state moves.
create or replace function quote_version_guard() returns trigger language plpgsql as $$
begin
  if old.state <> 'draft' and (
       row(new.delivery_minor, new.delivery_tax_rate_pct, new.valid_until, new.payment_terms, new.warranty, new.lead_time_days, new.exclusions, new.notes, new.totals, new.snapshot, new.snapshot_hash, new.submitted_at, new.rfq_version_number, new.number, new.quote_id)
       is distinct from
       row(old.delivery_minor, old.delivery_tax_rate_pct, old.valid_until, old.payment_terms, old.warranty, old.lead_time_days, old.exclusions, old.notes, old.totals, old.snapshot, old.snapshot_hash, old.submitted_at, old.rfq_version_number, old.number, old.quote_id)) then
    raise exception 'quote version % is submitted and cannot be changed; create a new version', old.id using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger quote_versions_immutable before update on quote_versions for each row execute function quote_version_guard();

create or replace function quote_line_guard() returns trigger language plpgsql as $$
declare st text;
begin
  select state into st from quote_versions where id = coalesce(new.quote_version_id, old.quote_version_id);
  if st is distinct from 'draft' then
    raise exception 'quote lines of a submitted version cannot be changed' using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end $$;
create trigger quote_lines_immutable before insert or update or delete on quote_lines for each row execute function quote_line_guard();

-- Clarifications attach to the quote and are append-only (§10.4 step 5).
create table quote_clarifications (
  id uuid primary key,
  quote_id uuid not null references quotes(id),
  rfq_id uuid not null references rfqs(id),
  project_id uuid not null references projects(id),
  provider_org_id uuid not null references organizations(id),
  side text not null check (side in ('client', 'provider')),
  body text not null,
  author_user_id uuid not null references users(id),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- orders (§9.4), record-only payment (§14.1)
create table orders (
  id uuid primary key,
  project_id uuid not null references projects(id),
  number int not null,
  rfq_id uuid not null references rfqs(id),
  quote_id uuid not null references quotes(id),
  quote_version_id uuid not null unique references quote_versions(id),
  provider_org_id uuid not null references organizations(id),
  state text not null default 'placed' check (state in ('placed', 'confirmed', 'partially_fulfilled', 'fulfilled', 'closed', 'cancelled', 'disputed')),
  currency text not null,
  total_minor bigint not null,
  -- The exact QuoteVersion snapshot the order came from, and its hash.
  terms jsonb not null,
  terms_hash text not null,
  payment_mode text not null default 'record_only' check (payment_mode = 'record_only'),
  award_reason text,
  awarded_by uuid not null references users(id),
  confirmed_at timestamptz,
  confirmed_by uuid references users(id),
  cancel_reason text,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, number)
);

-- ---------------------------------------------------------------- row-level security
-- Client side: project members (and audited staff sessions) through app_user_projects().
-- Provider side: organizations invited to the RFQ, through app_user_orgs(). Providers never see the project row,
-- only the RFQ's coarse area (§7.3). Drafts stay with the provider; sealed prices stay hidden until the RFQ closes.
create or replace function app_provider_rfqs() returns setof uuid language sql stable security definer set search_path = public as $$
  select rfq_id from rfq_invitations where provider_org_id in (select app_user_orgs()) and state <> 'revoked'
$$;
create or replace function app_rfq_prices_open(rid uuid) returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select not sealed or state <> 'published' or deadline <= now() from rfqs where id = rid), false)
$$;

alter table provider_profiles enable row level security;
create policy pp_read on provider_profiles for select to app_user using (true);
create policy pp_write on provider_profiles for insert to app_user with check (org_id in (select app_user_orgs()));
create policy pp_update on provider_profiles for update to app_user using (org_id in (select app_user_orgs())) with check (org_id in (select app_user_orgs()));

alter table rfqs enable row level security;
create policy rfq_member on rfqs for all to app_user using (project_id in (select app_user_projects())) with check (project_id in (select app_user_projects()));
create policy rfq_provider on rfqs for select to app_user using (id in (select app_provider_rfqs()));

alter table rfq_versions enable row level security;
create policy rfqv_member on rfq_versions for all to app_user using (project_id in (select app_user_projects())) with check (project_id in (select app_user_projects()));
create policy rfqv_provider on rfq_versions for select to app_user using (rfq_id in (select app_provider_rfqs()));

alter table rfq_lines enable row level security;
create policy rfql_member on rfq_lines for all to app_user using (project_id in (select app_user_projects())) with check (project_id in (select app_user_projects()));
create policy rfql_provider on rfq_lines for select to app_user using (rfq_id in (select app_provider_rfqs()));

alter table rfq_match_runs enable row level security;
create policy rfqm_member on rfq_match_runs for all to app_user using (project_id in (select app_user_projects())) with check (project_id in (select app_user_projects()));

alter table rfq_invitations enable row level security;
create policy inv_member on rfq_invitations for all to app_user using (project_id in (select app_user_projects())) with check (project_id in (select app_user_projects()));
create policy inv_provider on rfq_invitations for select to app_user using (provider_org_id in (select app_user_orgs()));
create policy inv_provider_update on rfq_invitations for update to app_user using (provider_org_id in (select app_user_orgs())) with check (provider_org_id in (select app_user_orgs()));

alter table quotes enable row level security;
create policy q_member on quotes for select to app_user using (project_id in (select app_user_projects()));
create policy q_member_update on quotes for update to app_user using (project_id in (select app_user_projects())) with check (project_id in (select app_user_projects()));
create policy q_provider on quotes for all to app_user using (provider_org_id in (select app_user_orgs()))
  with check (provider_org_id in (select app_user_orgs()) and rfq_id in (select app_provider_rfqs()));

alter table quote_versions enable row level security;
create policy qv_member on quote_versions for select to app_user
  using (project_id in (select app_user_projects()) and state <> 'draft' and app_rfq_prices_open(rfq_id));
create policy qv_member_update on quote_versions for update to app_user
  using (project_id in (select app_user_projects()) and state <> 'draft' and app_rfq_prices_open(rfq_id))
  with check (project_id in (select app_user_projects()));
create policy qv_provider on quote_versions for all to app_user using (provider_org_id in (select app_user_orgs()))
  with check (provider_org_id in (select app_user_orgs()) and rfq_id in (select app_provider_rfqs()));

alter table quote_lines enable row level security;
create policy ql_member on quote_lines for select to app_user using (project_id in (select app_user_projects()) and quote_version_id in (select id from quote_versions));
create policy ql_provider on quote_lines for all to app_user using (provider_org_id in (select app_user_orgs())) with check (provider_org_id in (select app_user_orgs()));

alter table quote_clarifications enable row level security;
create policy qc_party on quote_clarifications for select to app_user using (project_id in (select app_user_projects()) or provider_org_id in (select app_user_orgs()));
create policy qc_write on quote_clarifications for insert to app_user with check (author_user_id = app_user_id() and (
  (side = 'client' and project_id in (select app_user_projects())) or (side = 'provider' and provider_org_id in (select app_user_orgs()))));

alter table orders enable row level security;
create policy ord_member on orders for all to app_user using (project_id in (select app_user_projects())) with check (project_id in (select app_user_projects()));
create policy ord_provider on orders for select to app_user using (provider_org_id in (select app_user_orgs()));
create policy ord_provider_update on orders for update to app_user using (provider_org_id in (select app_user_orgs())) with check (provider_org_id in (select app_user_orgs()));

-- A change to a published RFQ marks every live quote as needing revision, including sealed ones the client cannot
-- read. Only a member of the RFQ's project may call it, and it touches nothing but the state.
create or replace function rfq_mark_needs_revision(rid uuid) returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not exists (select 1 from rfqs where id = rid and project_id in (select app_user_projects())) then return 0; end if;
  update quote_versions set state = 'needs_revision', updated_at = now(), version = version + 1 where rfq_id = rid and state = 'submitted';
  get diagnostics n = row_count;
  update quotes set status = 'needs_revision', updated_at = now() where rfq_id = rid and status = 'submitted';
  return n;
end $$;

-- Aggregates for matching that read across parties (chat reply history, RFQ responses) without exposing rows.
create or replace function provider_match_stats(orgs uuid[], window_days int, reply_hours int)
returns table (org_id uuid, invitations int, responses int, awards int, threads int, replied int, review_count int, review_avg double precision)
language sql stable security definer set search_path = public as $$
  select o.id,
    (select count(*)::int from rfq_invitations i where i.provider_org_id = o.id and i.state <> 'revoked' and i.created_at < now() - interval '1 day'),
    (select count(*)::int from rfq_invitations i where i.provider_org_id = o.id and i.state in ('quoted', 'declined')),
    (select count(*)::int from orders d where d.provider_org_id = o.id and d.state <> 'cancelled'),
    (select count(*)::int from threads t where t.seller_org_id = o.id and t.created_at > now() - make_interval(days => window_days)),
    (select count(*)::int from threads t where t.seller_org_id = o.id and t.created_at > now() - make_interval(days => window_days)
       and t.first_seller_reply_at is not null and t.first_seller_reply_at <= t.created_at + make_interval(hours => reply_hours)),
    (select count(*)::int from reviews r where r.seller_org_id = o.id and r.status = 'published'),
    (select avg(r.rating)::float from reviews r where r.seller_org_id = o.id and r.status = 'published')
  from organizations o where o.id = any(orgs)
$$;

grant execute on function app_provider_rfqs() to app_user;
grant execute on function app_rfq_prices_open(uuid) to app_user;
grant execute on function rfq_mark_needs_revision(uuid) to app_user;
grant execute on function provider_match_stats(uuid[], int, int) to app_user;
grant select, insert, update, delete on provider_profiles, rfqs, rfq_versions, rfq_lines, rfq_match_runs, rfq_invitations, quotes, quote_versions, quote_lines, quote_clarifications, orders to app_user;
revoke update, delete on rfq_versions, rfq_lines, rfq_match_runs, quote_clarifications from app_user;
revoke delete on quote_versions, orders, rfq_invitations, quotes from app_user;
