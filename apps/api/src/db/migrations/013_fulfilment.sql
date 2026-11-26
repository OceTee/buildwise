-- Release 3, second slice: fulfilment (spec §9.4, §10.4 steps 7–9, §14.1, scenario §22.6).
-- Deliveries booked into slots, consignments dispatched by the supplier, proof of delivery, inspection with
-- discrepancies, returns, supplier invoices with a three-way match, and record-only payments linked to an order.
-- Receipt never implies acceptance: proof of delivery is fixed once recorded, and only an inspection accepts goods.

alter table orders add column fulfilled_at timestamptz;
alter table orders add column closed_at timestamptz;
alter table orders add column closed_by uuid references users(id);

-- ---------------------------------------------------------------- deliveries (§9.4)
create table deliveries (
  id uuid primary key,
  order_id uuid not null references orders(id),
  project_id uuid not null references projects(id),
  provider_org_id uuid not null references organizations(id),
  number int not null,
  state text not null default 'scheduled' check (state in ('scheduled', 'dispatched', 'arrived', 'received', 'inspected_ok', 'discrepancy_raised', 'resolved', 'cancelled')),
  scheduled_date date not null,
  slot_code text not null,
  instructions text,
  reschedule_count int not null default 0,
  scheduled_by uuid not null references users(id),
  -- Consignment: what the supplier loaded and how it travels.
  consignment_ref text,
  vehicle text,
  driver_name text,
  dispatch_notes text,
  dispatched_at timestamptz,
  dispatched_by uuid references users(id),
  arrived_at timestamptz,
  arrived_by uuid references users(id),
  -- Proof of delivery: who received it, when, and the hash of what was recorded.
  received_by_name text,
  received_at timestamptz,
  pod_recorded_by uuid references users(id),
  pod_recorded_at timestamptz,
  pod_notes text,
  pod_proof_revision_id uuid references document_revisions(id),
  pod_hash text,
  inspected_at timestamptz,
  inspected_by uuid references users(id),
  inspection_notes text,
  resolved_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (order_id, number)
);
create index deliveries_project on deliveries (project_id, scheduled_date);
create index deliveries_provider on deliveries (provider_org_id, scheduled_date);

create table delivery_lines (
  id uuid primary key,
  delivery_id uuid not null references deliveries(id),
  order_id uuid not null references orders(id),
  project_id uuid not null references projects(id),
  provider_org_id uuid not null references organizations(id),
  line_key uuid not null,
  position int not null,
  description text not null,
  unit text not null,
  scheduled_qty numeric(18,6) not null check (scheduled_qty >= 0),
  dispatched_qty numeric(18,6) check (dispatched_qty >= 0),
  received_qty numeric(18,6) check (received_qty >= 0),
  accepted_qty numeric(18,6) check (accepted_qty >= 0),
  rejected_qty numeric(18,6) check (rejected_qty >= 0),
  unique (delivery_id, line_key)
);

-- Proof of delivery and the inspection result are fixed once recorded (§22.6: receipt is kept when a delivery is
-- disputed; the dispute is a separate discrepancy record).
create or replace function delivery_pod_guard() returns trigger language plpgsql as $$
begin
  if old.received_at is not null and row(new.received_by_name, new.received_at, new.pod_recorded_by, new.pod_recorded_at, new.pod_notes, new.pod_proof_revision_id, new.pod_hash)
     is distinct from row(old.received_by_name, old.received_at, old.pod_recorded_by, old.pod_recorded_at, old.pod_notes, old.pod_proof_revision_id, old.pod_hash) then
    raise exception 'proof of delivery for % is recorded and cannot be changed', old.id using errcode = 'P0001';
  end if;
  if old.inspected_at is not null and row(new.inspected_at, new.inspected_by, new.inspection_notes) is distinct from row(old.inspected_at, old.inspected_by, old.inspection_notes) then
    raise exception 'the inspection of % is recorded and cannot be changed', old.id using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger deliveries_pod_immutable before update on deliveries for each row execute function delivery_pod_guard();

create or replace function delivery_line_guard() returns trigger language plpgsql as $$
begin
  if (old.received_qty is not null and new.received_qty is distinct from old.received_qty)
     or (old.accepted_qty is not null and new.accepted_qty is distinct from old.accepted_qty)
     or (old.rejected_qty is not null and new.rejected_qty is distinct from old.rejected_qty)
     or new.line_key is distinct from old.line_key or new.delivery_id is distinct from old.delivery_id then
    raise exception 'received and inspected quantities cannot be changed' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger delivery_lines_immutable before update on delivery_lines for each row execute function delivery_line_guard();

create table delivery_discrepancies (
  id uuid primary key,
  delivery_id uuid not null references deliveries(id),
  order_id uuid not null references orders(id),
  project_id uuid not null references projects(id),
  provider_org_id uuid not null references organizations(id),
  line_key uuid not null,
  kind text not null check (kind in ('shortage', 'damaged', 'wrong_item', 'wrong_spec', 'quality', 'excess')),
  quantity numeric(18,6) not null check (quantity > 0),
  note text,
  state text not null default 'open' check (state in ('open', 'acknowledged', 'contested', 'resolved')),
  supplier_response text,
  responded_by uuid references users(id),
  responded_at timestamptz,
  resolution text check (resolution in ('replace', 'credit', 'accept_as_is')),
  resolution_note text,
  resolved_by uuid references users(id),
  resolved_at timestamptz,
  raised_by uuid not null references users(id),
  version int not null default 1,
  created_at timestamptz not null default now()
);
create index delivery_discrepancies_order on delivery_discrepancies (order_id);

-- ---------------------------------------------------------------- returns
create table return_requests (
  id uuid primary key,
  order_id uuid not null references orders(id),
  project_id uuid not null references projects(id),
  provider_org_id uuid not null references organizations(id),
  number int not null,
  delivery_id uuid references deliveries(id),
  discrepancy_id uuid references delivery_discrepancies(id),
  state text not null default 'requested' check (state in ('requested', 'approved', 'collected', 'rejected', 'cancelled')),
  reason text not null,
  supplier_note text,
  requested_by uuid not null references users(id),
  decided_by uuid references users(id),
  decided_at timestamptz,
  collected_by uuid references users(id),
  collected_at timestamptz,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (order_id, number)
);

create table return_lines (
  id uuid primary key,
  return_id uuid not null references return_requests(id),
  order_id uuid not null references orders(id),
  project_id uuid not null references projects(id),
  provider_org_id uuid not null references organizations(id),
  line_key uuid not null,
  description text not null,
  unit text not null,
  quantity numeric(18,6) not null check (quantity > 0),
  unique (return_id, line_key)
);

-- ---------------------------------------------------------------- supplier invoices and the three-way match (§10.4 step 9)
create table supplier_invoices (
  id uuid primary key,
  order_id uuid not null references orders(id),
  project_id uuid not null references projects(id),
  provider_org_id uuid not null references organizations(id),
  invoice_number text not null,
  issued_on date not null,
  due_on date,
  currency text not null,
  delivery_minor bigint not null default 0 check (delivery_minor >= 0),
  delivery_tax_rate_pct numeric(6,3) not null default 0,
  stated_total_minor bigint not null check (stated_total_minor > 0),
  totals jsonb not null,
  -- The latest three-way match result; re-run when receipts, inspections or returns change.
  match jsonb not null,
  match_status text not null check (match_status in ('matched', 'variance')),
  matched_at timestamptz not null default now(),
  state text not null default 'submitted' check (state in ('submitted', 'matched', 'awaiting_approval', 'approved', 'rejected', 'withdrawn')),
  notes text,
  snapshot_hash text not null,
  submitted_by uuid not null references users(id),
  decided_by uuid references users(id),
  decided_at timestamptz,
  decision_reason text,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (order_id, invoice_number)
);

create table supplier_invoice_lines (
  id uuid primary key,
  invoice_id uuid not null references supplier_invoices(id),
  order_id uuid not null references orders(id),
  project_id uuid not null references projects(id),
  provider_org_id uuid not null references organizations(id),
  line_key uuid,
  position int not null,
  description text not null,
  unit text not null,
  quantity numeric(18,6) not null check (quantity > 0),
  unit_price_minor bigint not null check (unit_price_minor >= 0),
  tax_rate_pct numeric(6,3) not null default 0
);

-- What the supplier billed never changes: only the decision and the match result move.
create or replace function supplier_invoice_guard() returns trigger language plpgsql as $$
begin
  if row(new.invoice_number, new.issued_on, new.due_on, new.currency, new.delivery_minor, new.delivery_tax_rate_pct, new.stated_total_minor, new.totals, new.snapshot_hash, new.order_id, new.provider_org_id, new.submitted_by)
     is distinct from row(old.invoice_number, old.issued_on, old.due_on, old.currency, old.delivery_minor, old.delivery_tax_rate_pct, old.stated_total_minor, old.totals, old.snapshot_hash, old.order_id, old.provider_org_id, old.submitted_by) then
    raise exception 'supplier invoice % cannot be changed; withdraw it and send a new one', old.id using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger supplier_invoices_immutable before update on supplier_invoices for each row execute function supplier_invoice_guard();

-- ---------------------------------------------------------------- record-only payments against an order (§14.1)
alter table payment_records add column order_id uuid references orders(id);
alter table payment_records add column supplier_invoice_id uuid references supplier_invoices(id);
alter table payment_records add column supplier_acknowledged_by uuid references users(id);
alter table payment_records add column supplier_acknowledged_at timestamptz;
create index payment_records_order on payment_records (order_id) where order_id is not null;

-- ---------------------------------------------------------------- row-level security
-- Client side: members of the order's project (and audited staff sessions). Provider side: the awarded organization.
alter table deliveries enable row level security;
create policy dl_member on deliveries for all to app_user using (project_id in (select app_user_projects())) with check (project_id in (select app_user_projects()));
create policy dl_provider on deliveries for select to app_user using (provider_org_id in (select app_user_orgs()));
create policy dl_provider_update on deliveries for update to app_user using (provider_org_id in (select app_user_orgs())) with check (provider_org_id in (select app_user_orgs()));

alter table delivery_lines enable row level security;
create policy dll_member on delivery_lines for all to app_user using (project_id in (select app_user_projects())) with check (project_id in (select app_user_projects()));
create policy dll_provider on delivery_lines for select to app_user using (provider_org_id in (select app_user_orgs()));
create policy dll_provider_update on delivery_lines for update to app_user using (provider_org_id in (select app_user_orgs())) with check (provider_org_id in (select app_user_orgs()));

alter table delivery_discrepancies enable row level security;
create policy dd_member on delivery_discrepancies for all to app_user using (project_id in (select app_user_projects())) with check (project_id in (select app_user_projects()));
create policy dd_provider on delivery_discrepancies for select to app_user using (provider_org_id in (select app_user_orgs()));
create policy dd_provider_update on delivery_discrepancies for update to app_user using (provider_org_id in (select app_user_orgs())) with check (provider_org_id in (select app_user_orgs()));

alter table return_requests enable row level security;
create policy rr_member on return_requests for all to app_user using (project_id in (select app_user_projects())) with check (project_id in (select app_user_projects()));
create policy rr_provider on return_requests for select to app_user using (provider_org_id in (select app_user_orgs()));
create policy rr_provider_update on return_requests for update to app_user using (provider_org_id in (select app_user_orgs())) with check (provider_org_id in (select app_user_orgs()));

alter table return_lines enable row level security;
create policy rl_member on return_lines for all to app_user using (project_id in (select app_user_projects())) with check (project_id in (select app_user_projects()));
create policy rl_provider on return_lines for select to app_user using (provider_org_id in (select app_user_orgs()));

-- Only the awarded supplier sends invoices for an order; the client reads them and records decisions.
alter table supplier_invoices enable row level security;
create policy si_member on supplier_invoices for select to app_user using (project_id in (select app_user_projects()));
create policy si_member_update on supplier_invoices for update to app_user using (project_id in (select app_user_projects())) with check (project_id in (select app_user_projects()));
create policy si_provider on supplier_invoices for all to app_user using (provider_org_id in (select app_user_orgs()))
  with check (provider_org_id in (select app_user_orgs()) and order_id in (select id from orders where provider_org_id in (select app_user_orgs())));

alter table supplier_invoice_lines enable row level security;
create policy sil_member on supplier_invoice_lines for select to app_user using (project_id in (select app_user_projects()));
create policy sil_provider on supplier_invoice_lines for all to app_user using (provider_org_id in (select app_user_orgs())) with check (provider_org_id in (select app_user_orgs()));

-- The awarded supplier sees the payments the client recorded against its order (never other project payments).
create policy payment_records_supplier on payment_records for select to app_user
  using (order_id is not null and order_id in (select id from orders where provider_org_id in (select app_user_orgs())));

-- The supplier confirms it received a recorded payment (receipt side, Appendix B). Touches nothing but the acknowledgement.
create or replace function order_payment_acknowledge(pid uuid) returns boolean language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update payment_records p set supplier_acknowledged_by = app_user_id(), supplier_acknowledged_at = now()
   where p.id = pid and p.supplier_acknowledged_at is null and p.voided_at is null
     and p.order_id in (select id from orders where provider_org_id in (select app_user_orgs()));
  get diagnostics n = row_count;
  return n > 0;
end $$;

grant execute on function order_payment_acknowledge(uuid) to app_user;
grant select, insert, update on deliveries, delivery_lines, delivery_discrepancies, return_requests, return_lines, supplier_invoices, supplier_invoice_lines to app_user;
revoke update on return_lines, supplier_invoice_lines from app_user;
