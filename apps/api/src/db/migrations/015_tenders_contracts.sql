-- Release 3, last slice: sealed tenders for trade packages, milestones and variations, sourcing modes, client
-- supplier lists and supplier uploads (spec §10.5, §9.5, §9.6, §10.4 step 2, §13.1.5, §14.1, §19.2).
-- A tender is an RFQ of kind 'tender'. Its bids stay unreadable to the client side (members and audited staff
-- sessions alike) until a bid opening is recorded at or after the deadline; the database enforces both.

-- ---------------------------------------------------------------- RFQ kind, sourcing modes, opening
alter table rfqs add column kind text not null default 'rfq' check (kind in ('rfq', 'tender'));
alter table rfqs add column opened_at timestamptz;
alter table rfqs add column opened_by uuid references users(id);
alter table rfqs add column nominated_org_ids uuid[] not null default '{}';
alter table rfqs drop constraint rfqs_sourcing_mode_check;
alter table rfqs add constraint rfqs_sourcing_mode_check check (sourcing_mode in ('open', 'invited', 'framework', 'nominated'));
alter table rfqs add constraint rfqs_tender_sealed check (kind <> 'tender' or sealed);

-- A tender opens once, never before its deadline, and cannot be closed or decided without an opening.
create or replace function rfq_tender_guard() returns trigger language plpgsql as $$
begin
  if old.kind <> new.kind and old.state <> 'draft' then
    raise exception 'the kind of a published request cannot change' using errcode = 'P0001';
  end if;
  if old.opened_at is not null and new.opened_at is distinct from old.opened_at then
    raise exception 'tender % was already opened', old.id using errcode = 'P0001';
  end if;
  if old.opened_at is null and new.opened_at is not null and (new.kind <> 'tender' or new.deadline > now()) then
    raise exception 'bids stay sealed until the deadline' using errcode = 'P0001';
  end if;
  if new.kind = 'tender' and new.state in ('closed', 'awarded', 'no_award') and new.opened_at is null then
    raise exception 'a tender closes only through its bid opening' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger rfqs_tender_guard before update on rfqs for each row execute function rfq_tender_guard();

-- Prices open for a tender only with its opening record; a sealed RFQ at its deadline or when closed.
create or replace function app_rfq_prices_open(rid uuid) returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select case when kind = 'tender' then opened_at is not null else (not sealed or state <> 'published' or deadline <= now()) end from rfqs where id = rid), false)
$$;

-- ---------------------------------------------------------------- tender package (§10.5 step 1)
create table tender_packages (
  rfq_id uuid primary key references rfqs(id),
  project_id uuid not null references projects(id),
  scope text not null,
  site_visit_required boolean not null default false,
  site_visit_note text,
  start_date date,
  finish_date date,
  conditions text,
  required_checks text[] not null default '{}',
  retention_pct numeric(5,2) not null default 0 check (retention_pct >= 0 and retention_pct <= 100),
  response_fields text[] not null default '{}',
  -- Scope documents: project document revisions, with names and hashes copied so bidders see what was issued.
  documents jsonb not null default '[]',
  updated_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The package is fixed once the tender is published; changes after that are clarifications or a revision.
create or replace function tender_package_guard() returns trigger language plpgsql as $$
begin
  if (select state from rfqs where id = old.rfq_id) <> 'draft' then
    raise exception 'the package of a published tender cannot be edited' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger tender_packages_fixed before update on tender_packages for each row execute function tender_package_guard();

-- Bid opening register: written once, at or after the deadline, with the hash of what was opened.
create table tender_openings (
  id uuid primary key,
  rfq_id uuid not null unique references rfqs(id),
  project_id uuid not null references projects(id),
  opened_at timestamptz not null default now(),
  opened_by uuid references users(id),
  record jsonb not null,
  record_hash text not null
);
create or replace function tender_opening_guard() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from rfqs where id = new.rfq_id and kind = 'tender' and deadline <= now()) then
    raise exception 'bids stay sealed until the deadline' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger tender_openings_at_deadline before insert on tender_openings for each row execute function tender_opening_guard();

-- The structured tender response (programme, staffing, method, inclusions, qualifications, defects terms,
-- exceptions, the bidder's conflict declaration) is part of the immutable submitted version.
alter table quote_versions add column tender_response jsonb;
create or replace function quote_version_guard() returns trigger language plpgsql as $$
begin
  if old.state <> 'draft' and (
       row(new.delivery_minor, new.delivery_tax_rate_pct, new.valid_until, new.payment_terms, new.warranty, new.lead_time_days, new.exclusions, new.notes, new.totals, new.snapshot, new.snapshot_hash, new.submitted_at, new.rfq_version_number, new.number, new.quote_id, new.tender_response)
       is distinct from
       row(old.delivery_minor, old.delivery_tax_rate_pct, old.valid_until, old.payment_terms, old.warranty, old.lead_time_days, old.exclusions, old.notes, old.totals, old.snapshot, old.snapshot_hash, old.submitted_at, old.rfq_version_number, old.number, old.quote_id, old.tender_response)) then
    raise exception 'quote version % is submitted and cannot be changed; create a new version', old.id using errcode = 'P0001';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------- clarifications shared with every bidder (§10.5 step 5)
-- Who asked is kept apart from the question, so other bidders never learn it (not even through the row).
create table tender_clarifications (
  id uuid primary key,
  rfq_id uuid not null references rfqs(id),
  project_id uuid not null references projects(id),
  asked_side text not null check (asked_side in ('client', 'provider')),
  question text not null,
  answer text,
  answered_by uuid references users(id),
  answered_at timestamptz,
  created_at timestamptz not null default now()
);
create index tender_clarifications_rfq on tender_clarifications (rfq_id, created_at);
create table tender_clarification_askers (
  clarification_id uuid primary key references tender_clarifications(id),
  rfq_id uuid not null references rfqs(id),
  project_id uuid not null references projects(id),
  org_id uuid not null references organizations(id),
  user_id uuid not null references users(id)
);
create or replace function tender_clarification_guard() returns trigger language plpgsql as $$
begin
  if new.question is distinct from old.question or new.asked_side is distinct from old.asked_side or new.rfq_id is distinct from old.rfq_id
     or (old.answered_at is not null and row(new.answer, new.answered_by, new.answered_at) is distinct from row(old.answer, old.answered_by, old.answered_at)) then
    raise exception 'a published clarification cannot be changed; publish another one' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger tender_clarifications_fixed before update on tender_clarifications for each row execute function tender_clarification_guard();

-- ---------------------------------------------------------------- evaluation (§10.5 step 4)
-- Evaluators declare their interests before they score; a declared conflict is recorded and keeps them out.
create table tender_declarations (
  id uuid primary key,
  rfq_id uuid not null references rfqs(id),
  project_id uuid not null references projects(id),
  user_id uuid not null references users(id),
  conflict boolean not null,
  details text,
  created_at timestamptz not null default now(),
  unique (rfq_id, user_id)
);
create table tender_scores (
  id uuid primary key,
  rfq_id uuid not null references rfqs(id),
  project_id uuid not null references projects(id),
  quote_id uuid not null references quotes(id),
  evaluator_id uuid not null references users(id),
  criterion text not null,
  score int not null check (score >= 0 and score <= 10),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (rfq_id, quote_id, evaluator_id, criterion)
);
create or replace function tender_score_guard() returns trigger language plpgsql as $$
declare r record;
begin
  select kind, state, opened_at into r from rfqs where id = new.rfq_id;
  if r.opened_at is null then raise exception 'bids are scored after they are opened' using errcode = 'P0001'; end if;
  if r.state <> 'closed' then raise exception 'scores are fixed once the tender is decided' using errcode = 'P0001'; end if;
  if not exists (select 1 from tender_declarations d where d.rfq_id = new.rfq_id and d.user_id = new.evaluator_id and not d.conflict) then
    raise exception 'declare your interests before scoring; a declared conflict keeps you out' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger tender_scores_guard before insert or update on tender_scores for each row execute function tender_score_guard();

-- ---------------------------------------------------------------- client supplier lists (§13.1.5)
create table supplier_lists (
  id uuid primary key,
  owner_org_id uuid not null references organizations(id),
  provider_org_id uuid not null references organizations(id),
  kind text not null check (kind in ('preferred', 'blocked', 'approved', 'conflict')),
  category_slugs text[] not null default '{}',
  valid_from date,
  valid_until date,
  reason text,
  created_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  removed_at timestamptz,
  removed_by uuid references users(id),
  removed_reason text,
  check (owner_org_id <> provider_org_id),
  check (kind not in ('blocked', 'conflict') or reason is not null)
);
create unique index supplier_lists_active on supplier_lists (owner_org_id, provider_org_id, kind) where removed_at is null;
-- Entries are never edited or deleted, only removed (with who and why), so decisions stay traceable.
create or replace function supplier_list_guard() returns trigger language plpgsql as $$
begin
  if old.removed_at is not null or row(new.owner_org_id, new.provider_org_id, new.kind, new.category_slugs, new.valid_from, new.valid_until, new.reason, new.created_by, new.created_at)
     is distinct from row(old.owner_org_id, old.provider_org_id, old.kind, old.category_slugs, old.valid_from, old.valid_until, old.reason, old.created_by, old.created_at) then
    raise exception 'a supplier list entry cannot be changed; remove it and add a new one' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger supplier_lists_fixed before update on supplier_lists for each row execute function supplier_list_guard();

-- ---------------------------------------------------------------- awards: kind, retention, revisions (§9.6, §10.5 step 6)
alter table orders add column kind text not null default 'supply' check (kind in ('supply', 'contract'));
alter table orders add column retention_pct numeric(5,2) not null default 0;
alter table orders add column contract_value_minor bigint;
alter table orders add column revision_number int not null default 1;
update orders set contract_value_minor = total_minor where contract_value_minor is null;
alter table orders alter column contract_value_minor set not null;

create table award_revisions (
  id uuid primary key,
  order_id uuid not null references orders(id),
  project_id uuid not null references projects(id),
  provider_org_id uuid not null references organizations(id),
  number int not null,
  variation_id uuid,
  value_minor bigint not null,
  time_days int not null default 0,
  completion_date date,
  reason text not null,
  snapshot jsonb not null,
  snapshot_hash text not null,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (order_id, number)
);
-- Revision 1 of every existing award is the award itself.
insert into award_revisions (id, order_id, project_id, provider_org_id, number, value_minor, reason, snapshot, snapshot_hash, created_by, created_at)
  select gen_random_uuid(), o.id, o.project_id, o.provider_org_id, 1, o.total_minor, 'Award', jsonb_build_object('kind', 'AwardRevision', 'orderId', o.id, 'number', 1, 'valueMinor', o.total_minor::text, 'termsHash', o.terms_hash), o.terms_hash, o.awarded_by, o.created_at from orders o;

-- ---------------------------------------------------------------- milestones (§9.5)
create table order_milestones (
  id uuid primary key,
  order_id uuid not null references orders(id),
  project_id uuid not null references projects(id),
  provider_org_id uuid not null references organizations(id),
  position int not null,
  title text not null,
  description text,
  amount_minor bigint not null check (amount_minor > 0),
  due_date date,
  state text not null default 'not_started' check (state in ('not_started', 'ready', 'in_progress', 'awaiting_client', 'complete', 'blocked', 'disputed', 'cancelled')),
  evidence_note text,
  claimed_at timestamptz,
  completed_at timestamptz,
  completed_by uuid references users(id),
  version int not null default 1,
  created_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index order_milestones_order on order_milestones (order_id, position);
-- Amounts and titles are settled before work starts; after that only the state moves.
create or replace function milestone_guard() returns trigger language plpgsql as $$
begin
  if old.state <> 'not_started' and row(new.title, new.amount_minor, new.order_id, new.position) is distinct from row(old.title, old.amount_minor, old.order_id, old.position) then
    raise exception 'milestone % has started; its amount and title are fixed', old.id using errcode = 'P0001';
  end if;
  if old.state = 'complete' and new.state <> 'complete' then
    raise exception 'a completed milestone stays complete' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger order_milestones_guard before update on order_milestones for each row execute function milestone_guard();

create table milestone_events (
  id uuid primary key,
  milestone_id uuid not null references order_milestones(id),
  order_id uuid not null references orders(id),
  project_id uuid not null references projects(id),
  provider_org_id uuid not null references organizations(id),
  command text not null,
  from_state text,
  to_state text not null,
  reason text,
  actor_user_id uuid references users(id),
  actor_side text not null check (actor_side in ('client', 'provider', 'system')),
  at timestamptz not null default now()
);

alter table payment_records add column milestone_id uuid references order_milestones(id);

-- ---------------------------------------------------------------- variations (§9.6)
create table variations (
  id uuid primary key,
  order_id uuid not null references orders(id),
  project_id uuid not null references projects(id),
  provider_org_id uuid not null references organizations(id),
  number int not null,
  title text not null,
  description text not null,
  reason text not null,
  proposed_side text not null check (proposed_side in ('client', 'provider')),
  proposed_by uuid not null references users(id),
  cost_impact_minor bigint,
  time_impact_days int,
  lines jsonb not null default '[]',
  state text not null default 'proposed' check (state in ('proposed', 'impact_assessed', 'under_review', 'approved', 'rejected', 'withdrawn', 'instructed', 'executed', 'valued')),
  revision_id uuid references award_revisions(id),
  decided_by uuid references users(id),
  decided_at timestamptz,
  decision_note text,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (order_id, number)
);
alter table award_revisions add constraint award_revisions_variation foreign key (variation_id) references variations(id);
-- The price under review is the price decided: cost and time change only before review, never after a decision.
create or replace function variation_guard() returns trigger language plpgsql as $$
begin
  if old.state not in ('proposed', 'impact_assessed') and row(new.cost_impact_minor, new.time_impact_days, new.lines, new.title, new.description, new.reason)
     is distinct from row(old.cost_impact_minor, old.time_impact_days, old.lines, old.title, old.description, old.reason) then
    raise exception 'variation % is under review or decided; its price is fixed', old.id using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger variations_guard before update on variations for each row execute function variation_guard();

create table variation_events (
  id uuid primary key,
  variation_id uuid not null references variations(id),
  order_id uuid not null references orders(id),
  project_id uuid not null references projects(id),
  provider_org_id uuid not null references organizations(id),
  command text not null,
  from_state text,
  to_state text not null,
  cost_impact_minor bigint,
  time_impact_days int,
  note text,
  actor_user_id uuid not null references users(id),
  actor_side text not null check (actor_side in ('client', 'provider')),
  at timestamptz not null default now()
);

-- ---------------------------------------------------------------- supplier uploads (POD photo, invoice PDF)
create table order_files (
  id uuid primary key,
  order_id uuid not null references orders(id),
  project_id uuid not null references projects(id),
  provider_org_id uuid not null references organizations(id),
  purpose text not null check (purpose in ('pod_photo', 'invoice_pdf')),
  delivery_id uuid references deliveries(id),
  invoice_id uuid references supplier_invoices(id),
  document_id uuid not null references documents(id),
  revision_id uuid not null unique references document_revisions(id),
  uploaded_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  check ((purpose = 'pod_photo' and delivery_id is not null) or (purpose = 'invoice_pdf' and invoice_id is not null))
);
create index order_files_order on order_files (order_id, created_at);

-- The awarded supplier is not a project member: this narrow function creates the project document, its revision
-- and the link, and nothing else. The upload then goes through the same scan, sniff and sharp pipeline.
create or replace function supplier_file_create(fid uuid, did uuid, rid uuid, oid uuid, purp text, del uuid, inv uuid, fname text, nbytes bigint, title text) returns boolean
language plpgsql security definer set search_path = public as $$
declare o record;
begin
  select id, project_id, provider_org_id into o from orders where id = oid and provider_org_id in (select app_user_orgs());
  if o.id is null then return false; end if;
  if purp = 'pod_photo' and not exists (select 1 from deliveries where id = del and order_id = oid and state in ('dispatched', 'arrived', 'received', 'inspected_ok', 'discrepancy_raised', 'resolved')) then return false; end if;
  if purp = 'invoice_pdf' and not exists (select 1 from supplier_invoices where id = inv and order_id = oid and state <> 'withdrawn') then return false; end if;
  insert into documents (id, project_id, doc_type, discipline, title, created_by) values (did, o.project_id, case when purp = 'pod_photo' then 'delivery_proof' else 'supplier_invoice' end, 'other', title, app_user_id());
  insert into document_revisions (id, document_id, project_id, revision_label, storage_key, original_name, bytes, uploaded_by) values (rid, did, o.project_id, 'A', 'active/' || rid, fname, nbytes, app_user_id());
  insert into order_files (id, order_id, project_id, provider_org_id, purpose, delivery_id, invoice_id, document_id, revision_id, uploaded_by) values (fid, oid, o.project_id, o.provider_org_id, purp, del, inv, did, rid, app_user_id());
  return true;
end $$;

-- ---------------------------------------------------------------- row-level security
alter table tender_packages enable row level security;
create policy tp_member on tender_packages for all to app_user using (project_id in (select app_user_projects())) with check (project_id in (select app_user_projects()));
create policy tp_provider on tender_packages for select to app_user using (rfq_id in (select app_provider_rfqs()));

-- The opening register lists every bidder's total: the client side only. Bidders see the opening time on the RFQ.
alter table tender_openings enable row level security;
create policy to_member on tender_openings for all to app_user using (project_id in (select app_user_projects())) with check (project_id in (select app_user_projects()));

alter table tender_clarification_askers enable row level security;
create policy tca_member on tender_clarification_askers for select to app_user using (project_id in (select app_user_projects()));
create policy tca_provider on tender_clarification_askers for select to app_user using (org_id in (select app_user_orgs()));
create policy tca_provider_insert on tender_clarification_askers for insert to app_user with check (org_id in (select app_user_orgs()) and user_id = app_user_id() and rfq_id in (select app_provider_rfqs()));

alter table tender_clarifications enable row level security;
create policy tc_member on tender_clarifications for all to app_user using (project_id in (select app_user_projects())) with check (project_id in (select app_user_projects()));
create policy tc_provider on tender_clarifications for select to app_user using (rfq_id in (select app_provider_rfqs())
  and (answered_at is not null or id in (select clarification_id from tender_clarification_askers where org_id in (select app_user_orgs()))));
create policy tc_provider_insert on tender_clarifications for insert to app_user with check (rfq_id in (select app_provider_rfqs()) and asked_side = 'provider' and answer is null and answered_at is null);

alter table tender_declarations enable row level security;
create policy td_member on tender_declarations for all to app_user using (project_id in (select app_user_projects())) with check (project_id in (select app_user_projects()) and user_id = app_user_id());
alter table tender_scores enable row level security;
create policy ts_member on tender_scores for all to app_user using (project_id in (select app_user_projects())) with check (project_id in (select app_user_projects()) and evaluator_id = app_user_id());

-- Lists belong to the client organization; members of its projects read them, the API decides who may change them.
alter table supplier_lists enable row level security;
create policy sl_owner on supplier_lists for all to app_user
  using (owner_org_id in (select app_user_orgs()) or owner_org_id in (select owner_org_id from projects where id in (select app_user_projects())))
  with check (owner_org_id in (select app_user_orgs()) or owner_org_id in (select owner_org_id from projects where id in (select app_user_projects())));

alter table award_revisions enable row level security;
create policy ar_member on award_revisions for all to app_user using (project_id in (select app_user_projects())) with check (project_id in (select app_user_projects()));
create policy ar_provider on award_revisions for select to app_user using (provider_org_id in (select app_user_orgs()));

alter table order_milestones enable row level security;
create policy om_member on order_milestones for all to app_user using (project_id in (select app_user_projects())) with check (project_id in (select app_user_projects()));
create policy om_provider on order_milestones for select to app_user using (provider_org_id in (select app_user_orgs()));
create policy om_provider_update on order_milestones for update to app_user using (provider_org_id in (select app_user_orgs())) with check (provider_org_id in (select app_user_orgs()));

alter table milestone_events enable row level security;
create policy me_member on milestone_events for all to app_user using (project_id in (select app_user_projects())) with check (project_id in (select app_user_projects()));
create policy me_provider on milestone_events for select to app_user using (provider_org_id in (select app_user_orgs()));
create policy me_provider_insert on milestone_events for insert to app_user with check (provider_org_id in (select app_user_orgs()) and actor_user_id = app_user_id());

alter table variations enable row level security;
create policy va_member on variations for all to app_user using (project_id in (select app_user_projects())) with check (project_id in (select app_user_projects()));
create policy va_provider on variations for select to app_user using (provider_org_id in (select app_user_orgs()));
create policy va_provider_insert on variations for insert to app_user with check (provider_org_id in (select app_user_orgs()) and proposed_side = 'provider'
  and order_id in (select id from orders where provider_org_id in (select app_user_orgs())));
create policy va_provider_update on variations for update to app_user using (provider_org_id in (select app_user_orgs())) with check (provider_org_id in (select app_user_orgs()));

alter table variation_events enable row level security;
create policy ve_member on variation_events for all to app_user using (project_id in (select app_user_projects())) with check (project_id in (select app_user_projects()));
create policy ve_provider on variation_events for select to app_user using (provider_org_id in (select app_user_orgs()));
create policy ve_provider_insert on variation_events for insert to app_user with check (provider_org_id in (select app_user_orgs()) and actor_user_id = app_user_id() and actor_side = 'provider');

alter table order_files enable row level security;
create policy of_member on order_files for select to app_user using (project_id in (select app_user_projects()));
create policy of_provider on order_files for select to app_user using (provider_org_id in (select app_user_orgs()));
-- The supplier reads the documents it uploaded for its order (and nothing else in the project).
create policy documents_supplier on documents for select to app_user using (id in (select document_id from order_files where provider_org_id in (select app_user_orgs())));
create policy document_revisions_supplier on document_revisions for select to app_user using (id in (select revision_id from order_files where provider_org_id in (select app_user_orgs())));

grant execute on function supplier_file_create(uuid, uuid, uuid, uuid, text, uuid, uuid, text, bigint, text) to app_user;
grant select, insert, update on tender_packages, tender_clarifications, tender_scores, supplier_lists, order_milestones, variations to app_user;
grant select, insert on tender_openings, tender_clarification_askers, tender_declarations, award_revisions, milestone_events, variation_events to app_user;
grant select on order_files to app_user;
