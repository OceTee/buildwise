-- Release 3, third slice: trust and marketplace quality (spec §9.10, §13.3, §13.4, §13.1.2, §25).
-- Supplier cases (a contested discrepancy or a disputed order becomes a case with severity, response target,
-- evidence, a communication log, a decision and one appeal decided by a different staff member), two-sided
-- transaction reviews, provider performance inputs and worker reminders.

-- ---------------------------------------------------------------- cases (§9.10, §13.3)
create sequence case_number_seq;

create table cases (
  id uuid primary key,
  number int not null unique default nextval('case_number_seq'),
  type text not null check (type in ('identity_fraud', 'substandard_product', 'non_delivery', 'damage', 'unsafe_work', 'workmanship_defect', 'non_payment', 'harassment', 'platform_abuse', 'review_manipulation', 'data_privacy')),
  severity text not null check (severity in ('S1', 'S2', 'S3', 'S4')),
  state text not null default 'open' check (state in ('open', 'triaged', 'awaiting_party', 'under_investigation', 'proposed_resolution', 'resolved', 'appealed', 'under_appeal_review', 'final')),
  source text not null check (source in ('discrepancy', 'order')),
  order_id uuid not null references orders(id),
  discrepancy_id uuid references delivery_discrepancies(id),
  project_id uuid not null references projects(id),
  provider_org_id uuid not null references organizations(id),
  raised_by uuid not null references users(id),
  raised_side text not null check (raised_side in ('client', 'provider')),
  summary text not null,
  -- Safety (S1) cases skip the triage queue and page the on-call safety owner.
  safety boolean not null default false,
  paged_at timestamptz,
  response_due_at timestamptz not null,
  first_response_at timestamptz,
  response_reminded_at timestamptz,
  triaged_by uuid references users(id),
  triaged_at timestamptz,
  assigned_to uuid references users(id),
  awaiting_side text check (awaiting_side in ('client', 'provider', 'both')),
  awaiting_since timestamptz,
  party_reminded_at timestamptz,
  proposed_resolution text,
  proposed_by uuid references users(id),
  proposed_at timestamptz,
  outcome text check (outcome in ('client_upheld', 'provider_upheld', 'shared', 'no_finding', 'referred')),
  decision_note text,
  decided_by uuid references users(id),
  decided_at timestamptz,
  appeal_statement text,
  appealed_by uuid references users(id),
  appealed_side text check (appealed_side in ('client', 'provider')),
  appealed_at timestamptz,
  appeal_reviewer uuid references users(id),
  appeal_taken_at timestamptz,
  appeal_outcome text check (appeal_outcome in ('upheld', 'overturned')),
  appeal_new_outcome text check (appeal_new_outcome in ('client_upheld', 'provider_upheld', 'shared', 'no_finding', 'referred')),
  appeal_note text,
  appeal_decided_at timestamptz,
  final_at timestamptz,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Independent review: whoever decided the case never reviews its appeal.
  check (appeal_reviewer is null or decided_by is null or appeal_reviewer <> decided_by)
);
create unique index cases_one_per_discrepancy on cases (discrepancy_id) where discrepancy_id is not null;
create unique index cases_one_open_per_order on cases (order_id) where source = 'order' and state in ('open', 'triaged', 'awaiting_party', 'under_investigation', 'proposed_resolution');
create index cases_queue on cases (state, severity, response_due_at);
create index cases_order on cases (order_id);

-- A decision, an appeal and an appeal decision are fixed once recorded.
create or replace function case_decision_guard() returns trigger language plpgsql as $$
begin
  if old.decided_at is not null and row(new.outcome, new.decision_note, new.decided_by, new.decided_at) is distinct from row(old.outcome, old.decision_note, old.decided_by, old.decided_at) then
    raise exception 'the decision on case % is recorded and cannot be changed', old.id using errcode = 'P0001';
  end if;
  if old.appealed_at is not null and row(new.appeal_statement, new.appealed_by, new.appealed_side, new.appealed_at) is distinct from row(old.appeal_statement, old.appealed_by, old.appealed_side, old.appealed_at) then
    raise exception 'case % has already been appealed', old.id using errcode = 'P0001';
  end if;
  if old.appeal_decided_at is not null and row(new.appeal_outcome, new.appeal_new_outcome, new.appeal_note, new.appeal_decided_at, new.appeal_reviewer) is distinct from row(old.appeal_outcome, old.appeal_new_outcome, old.appeal_note, old.appeal_decided_at, old.appeal_reviewer) then
    raise exception 'the appeal on case % is decided and cannot be changed', old.id using errcode = 'P0001';
  end if;
  if row(new.order_id, new.project_id, new.provider_org_id, new.raised_by, new.raised_side, new.source, new.discrepancy_id) is distinct from row(old.order_id, old.project_id, old.provider_org_id, old.raised_by, old.raised_side, old.source, old.discrepancy_id) then
    raise exception 'the parties to case % cannot be changed', old.id using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger cases_decision_immutable before update on cases for each row execute function case_decision_guard();

-- The communication log: party messages, staff messages, staff-only notes and state changes. Never edited.
create table case_messages (
  id uuid primary key,
  case_id uuid not null references cases(id),
  project_id uuid not null references projects(id),
  provider_org_id uuid not null references organizations(id),
  author_user_id uuid references users(id),
  author_role text not null check (author_role in ('client', 'provider', 'staff', 'system')),
  body text not null,
  internal boolean not null default false,
  created_at timestamptz not null default now()
);
create index case_messages_case on case_messages (case_id, created_at);

-- Evidence: project document revisions (hashed, scanned) attached to the case.
create table case_evidence (
  id uuid primary key,
  case_id uuid not null references cases(id),
  project_id uuid not null references projects(id),
  provider_org_id uuid not null references organizations(id),
  document_revision_id uuid not null references document_revisions(id),
  -- Copied when attached, so the supplier (who cannot read project documents) still sees what was attached.
  document_title text not null,
  revision_label text not null,
  file_name text not null,
  sha256 text,
  added_by uuid not null references users(id),
  added_side text not null check (added_side in ('client', 'provider', 'staff')),
  note text,
  created_at timestamptz not null default now(),
  unique (case_id, document_revision_id)
);

-- ---------------------------------------------------------------- transaction reviews (§13.4)
create table transaction_reviews (
  id uuid primary key,
  order_id uuid not null references orders(id),
  project_id uuid not null references projects(id),
  provider_org_id uuid not null references organizations(id),
  author_user_id uuid not null references users(id),
  author_side text not null check (author_side in ('client', 'provider')),
  -- Kept on the review so a public provider profile never needs the RFQ or the project.
  category_slug text not null,
  area_code text not null,
  ratings jsonb not null,
  overall numeric(3,1) not null check (overall between 1 and 5),
  body text not null,
  status text not null default 'published' check (status in ('pending', 'published', 'removed')),
  hold_reasons jsonb not null default '[]',
  removed_reason text check (removed_reason in ('abuse', 'personal_data', 'not_about_transaction', 'conflict_of_interest', 'manipulation')),
  removed_note text,
  decided_by uuid references users(id),
  decided_at timestamptz,
  reply_body text,
  reply_by uuid references users(id),
  reply_at timestamptz,
  window_closes_at timestamptz not null,
  created_at timestamptz not null default now(),
  -- One review per side per transaction.
  unique (order_id, author_side),
  check (status <> 'removed' or removed_reason is not null)
);
create index transaction_reviews_provider on transaction_reviews (provider_org_id, status, created_at desc);

create or replace function transaction_review_guard() returns trigger language plpgsql as $$
begin
  if row(new.order_id, new.author_user_id, new.author_side, new.ratings, new.overall, new.body, new.created_at) is distinct from row(old.order_id, old.author_user_id, old.author_side, old.ratings, old.overall, old.body, old.created_at) then
    raise exception 'review % cannot be edited', old.id using errcode = 'P0001';
  end if;
  if old.reply_at is not null and row(new.reply_body, new.reply_by, new.reply_at) is distinct from row(old.reply_body, old.reply_by, old.reply_at) then
    raise exception 'the reply to review % cannot be changed', old.id using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger transaction_reviews_immutable before update on transaction_reviews for each row execute function transaction_review_guard();

-- Reports can now target a transaction review.
alter table reports drop constraint reports_target_type_check;
alter table reports add constraint reports_target_type_check check (target_type in ('listing', 'seller', 'message', 'review', 'transaction_review'));

-- ---------------------------------------------------------------- worker reminders
alter table deliveries add column inspection_reminded_at timestamptz;

-- ---------------------------------------------------------------- provider performance inputs (§13.1.2, §26.4)
-- The minimum per-record facts the performance rules read, across every client's orders. No prices, no project
-- details: dates, states and counts only. Narrow security definer so a client's matching run can rank providers.
create or replace function provider_performance_inputs(orgs uuid[], window_days int)
returns table (org_id uuid, deliveries jsonb, invoices jsonb, invitations jsonb, quotes jsonb)
language sql stable security definer set search_path = public as $$
  select o.id,
    coalesce((select jsonb_agg(jsonb_build_object('scheduledDate', d.scheduled_date, 'state', d.state, 'arrivedAt', d.arrived_at, 'inspected', d.inspected_at is not null,
        'discrepancies', (select count(*) from delivery_discrepancies x where x.delivery_id = d.id)))
      from deliveries d where d.provider_org_id = o.id and d.created_at > now() - make_interval(days => window_days)), '[]'::jsonb),
    coalesce((select jsonb_agg(jsonb_build_object('state', i.state, 'matchStatus', i.match_status))
      from supplier_invoices i where i.provider_org_id = o.id and i.created_at > now() - make_interval(days => window_days)), '[]'::jsonb),
    coalesce((select jsonb_agg(jsonb_build_object('invitedAt', i.created_at, 'respondedAt', i.responded_at, 'state', i.state))
      from rfq_invitations i where i.provider_org_id = o.id and i.state <> 'revoked' and i.created_at > now() - make_interval(days => window_days)), '[]'::jsonb),
    coalesce((select jsonb_agg(jsonb_build_object('state', v.state, 'withdrawn', v.state = 'withdrawn', 'validUntil', v.valid_until, 'rfqDeadline', r.deadline))
      from quotes q
      join lateral (select vv.state, vv.valid_until from quote_versions vv where vv.quote_id = q.id and vv.submitted_at is not null order by vv.number desc limit 1) v on true
      join rfqs r on r.id = q.rfq_id
      where q.provider_org_id = o.id and q.created_at > now() - make_interval(days => window_days)), '[]'::jsonb)
  from organizations o where o.id = any(orgs)
$$;

-- ---------------------------------------------------------------- row-level security
-- Parties: members of the order's project (client side, incl. audited staff sessions) and the awarded organization.
-- Staff work cases from the moderation area in system context.
alter table cases enable row level security;
create policy cs_party on cases for select to app_user using (project_id in (select app_user_projects()) or provider_org_id in (select app_user_orgs()));
create policy cs_party_insert on cases for insert to app_user
  with check (raised_by = app_user_id() and ((raised_side = 'client' and project_id in (select app_user_projects())) or (raised_side = 'provider' and provider_org_id in (select app_user_orgs()))));
create policy cs_party_update on cases for update to app_user
  using (project_id in (select app_user_projects()) or provider_org_id in (select app_user_orgs()))
  with check (project_id in (select app_user_projects()) or provider_org_id in (select app_user_orgs()));

-- Parties never see staff-only notes.
alter table case_messages enable row level security;
create policy cm_party on case_messages for select to app_user using (not internal and (project_id in (select app_user_projects()) or provider_org_id in (select app_user_orgs())));
create policy cm_party_insert on case_messages for insert to app_user
  with check (not internal and (project_id in (select app_user_projects()) or provider_org_id in (select app_user_orgs())) and (author_user_id = app_user_id() or author_role = 'system'));

-- Evidence comes from the project's documents, so only the client side attaches it; both sides see what was attached.
alter table case_evidence enable row level security;
create policy ce_party on case_evidence for select to app_user using (project_id in (select app_user_projects()) or provider_org_id in (select app_user_orgs()));
create policy ce_client_insert on case_evidence for insert to app_user with check (added_by = app_user_id() and project_id in (select app_user_projects()));

-- Published reviews are public; the parties also see their own pending ones.
alter table transaction_reviews enable row level security;
create policy tr_public on transaction_reviews for select to app_user
  using (status = 'published' or author_user_id = app_user_id() or project_id in (select app_user_projects()) or provider_org_id in (select app_user_orgs()) or app_is_staff());
create policy tr_author_insert on transaction_reviews for insert to app_user
  with check (author_user_id = app_user_id() and ((author_side = 'client' and project_id in (select app_user_projects())) or (author_side = 'provider' and provider_org_id in (select app_user_orgs()))));
-- Parties add a reply; staff publish or remove (reports are decided in the user's own context).
create policy tr_party_update on transaction_reviews for update to app_user
  using (project_id in (select app_user_projects()) or provider_org_id in (select app_user_orgs()) or app_is_staff())
  with check (project_id in (select app_user_projects()) or provider_org_id in (select app_user_orgs()) or app_is_staff());

grant execute on function provider_performance_inputs(uuid[], int) to app_user;
grant usage, select on sequence case_number_seq to app_user;
grant select, insert, update on cases, transaction_reviews to app_user;
grant select, insert on case_messages, case_evidence to app_user;
