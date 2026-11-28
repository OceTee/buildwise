-- Row-level security for the marketplace (Release 1) and the remaining server tables (spec §19, §28): a second layer
-- behind the handlers. Signed-in requests run as app_user with app.user_id set; the worker, anonymous requests and
-- system-context routes run as the owner and are not affected. Staff moderation routes run as app_user, so staff
-- writes are allowed explicitly (app_is_staff()). Cross-party side effects (counters, report thresholds, risk inputs
-- that read other sellers' rows) go through the narrow security-definer functions below instead of broad policies.

-- ---------------------------------------------------------------- helpers
-- Owner or admin of an organization (seller settings, team members).
create or replace function app_org_admin(oid uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from org_members where org_id = oid and user_id = app_user_id() and role in ('owner', 'admin'))
$$;

-- The creator of a new organization adds themself as its first owner before any membership exists.
create or replace function app_created_org(oid uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from organizations where id = oid and created_by = app_user_id())
    and not exists (select 1 from org_members where org_id = oid)
$$;

-- Listings the caller has a buyer relationship with (a chat, a favourite, a quote request, a phone reveal). They stay
-- readable after the listing leaves live (in review, blocked), so threads and saved items keep their titles.
create or replace function app_buyer_listings() returns setof uuid language sql stable security definer set search_path = public as $$
  select listing_id from threads where buyer_user_id = app_user_id()
  union select listing_id from favourites where user_id = app_user_id()
  union select listing_id from quote_requests where buyer_user_id = app_user_id()
  union select listing_id from contact_reveals where viewer_user_id = app_user_id()
$$;

-- ---------------------------------------------------------------- users
-- Display names are joined everywhere (chat, reviews, RFIs, cases, orders, staff lists) and phone numbers are read
-- across accounts by design (phone reveal, adding a team member or project member by phone), so rows stay readable to
-- signed-in users; a narrower row rule would silently drop rows from those joins. What RLS adds here: no account is
-- created or changed from user context except the caller's own row (staff may update any), and only these columns
-- can be written, so nobody can make themself staff.
alter table users enable row level security;
create policy us_read on users for select to app_user using (true);
create policy us_self_update on users for update to app_user using (id = app_user_id() or app_is_staff()) with check (id = app_user_id() or app_is_staff());
revoke insert, update, delete on users from app_user;
grant update (display_name, email, status, phone_e164, phone_verified_at, last_seen_at) on users to app_user;

-- ---------------------------------------------------------------- organizations and members
-- Storefronts are public (name, handle, area; the address is shown only when published, which the handler decides).
-- A user creates organizations as themself; owners/admins change their own; staff reserve verified names.
alter table organizations enable row level security;
create policy org_read on organizations for select to app_user using (true);
create policy org_create on organizations for insert to app_user with check (created_by = app_user_id());
create policy org_admin_update on organizations for update to app_user using (app_org_admin(id) or app_is_staff()) with check (app_org_admin(id) or app_is_staff());
revoke delete on organizations from app_user;

-- Only staff change the reserved name, kind, handle or creator of an organization.
create or replace function organizations_guard() returns trigger language plpgsql as $$
begin
  if current_user = 'app_user' and not app_is_staff() and (new.reserved_name is distinct from old.reserved_name or new.kind is distinct from old.kind
     or new.handle is distinct from old.handle or new.created_by is distinct from old.created_by) then
    raise exception 'Only staff can change this organization field.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger organizations_guard before update on organizations for each row execute function organizations_guard();

-- Memberships are read across organizations on purpose: notifying the other party of an order, the conflict-of-interest
-- check on supplier lists, "owners active" in provider matching. They hold no contact details. Writes: the creator's
-- first owner row, then owners/admins of that organization; anyone may leave.
alter table org_members enable row level security;
create policy om_read on org_members for select to app_user using (true);
create policy om_bootstrap on org_members for insert to app_user with check (user_id = app_user_id() and role = 'owner' and app_created_org(org_id));
create policy om_admin_insert on org_members for insert to app_user with check (app_org_admin(org_id));
create policy om_admin_update on org_members for update to app_user using (app_org_admin(org_id)) with check (app_org_admin(org_id));
create policy om_delete on org_members for delete to app_user using (app_org_admin(org_id) or user_id = app_user_id());

-- ---------------------------------------------------------------- server-only tables (no app_user access at all)
-- One-time codes, provider webhooks, rate-limit counters and the AI caches and models are read and written only in
-- system context (sign-in routes, webhooks, the limiter, the worker and the AI routes).
do $$
declare t text;
begin
  foreach t in array array['otp_codes', 'payment_webhook_events', 'rate_limit_windows', 'assistant_models', 'assistant_knowledge', 'assistant_messages',
                           'architect_reviews', 'ai_usage', 'ai_designs', 'concept_choices'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on %I from app_user', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- platform: outbox, audit, idempotency
-- Business transactions append events; only the worker (system) reads and dispatches them.
alter table outbox enable row level security;
create policy ob_append on outbox for insert to app_user with check (true);
revoke select, update, delete on outbox from app_user;

-- Users append audit entries as themselves (or as the system); only staff read the log. The hash chain needs the last
-- hash, which audit_last_hash() returns without exposing any row.
alter table audit_events enable row level security;
create policy ae_append on audit_events for insert to app_user with check (actor_user_id is null or actor_user_id = app_user_id());
create policy ae_staff_read on audit_events for select to app_user using (app_is_staff());
create or replace function audit_last_hash() returns text language sql stable security definer set search_path = public as $$
  select hash from audit_events order by seq desc limit 1
$$;
grant execute on function audit_last_hash() to app_user;

alter table idempotency_keys enable row level security;
create policy ik_self on idempotency_keys for all to app_user using (user_id = app_user_id()) with check (user_id = app_user_id());

-- ---------------------------------------------------------------- categories and verification (public configuration)
alter table categories enable row level security;
create policy cat_read on categories for select to app_user using (true);
create policy cat_staff on categories for all to app_user using (app_is_staff()) with check (app_is_staff());

alter table category_versions enable row level security;
create policy catv_read on category_versions for select to app_user using (true);
create policy catv_staff on category_versions for all to app_user using (app_is_staff()) with check (app_is_staff());

-- Verification results are shown on seller and provider profiles and used for matching; staff record them.
alter table verification_checks enable row level security;
create policy vc_read on verification_checks for select to app_user using (true);
create policy vc_staff on verification_checks for all to app_user using (app_is_staff()) with check (app_is_staff());

-- ---------------------------------------------------------------- listings
-- Readable: live, expired and closed listings (the public page answers unavailable / 410 for those), the seller's own
-- (drafts, in review, rejected, blocked), listings the caller has a buyer relationship with, and staff. Writes: the
-- seller's members and staff. Buyers' counters go through listing_count_view / listing_count_contact.
alter table listings enable row level security;
create policy li_read on listings for select to app_user
  using (status in ('live', 'expired', 'closed') or seller_org_id in (select app_user_orgs()) or app_is_staff() or id in (select app_buyer_listings()));
create policy li_seller_insert on listings for insert to app_user with check (seller_org_id in (select app_user_orgs()) and created_by = app_user_id());
create policy li_seller_update on listings for update to app_user
  using (seller_org_id in (select app_user_orgs()) or app_is_staff()) with check (seller_org_id in (select app_user_orgs()) or app_is_staff());
revoke delete on listings from app_user;

create or replace function listing_count_view(lid uuid) returns void language sql volatile security definer set search_path = public as $$
  update listings set views = views + 1 where id = lid and status = 'live'
$$;
create or replace function listing_count_contact(lid uuid) returns void language sql volatile security definer set search_path = public as $$
  update listings set contacts = contacts + 1 where id = lid and status = 'live'
$$;
grant execute on function listing_count_view(uuid) to app_user;
grant execute on function listing_count_contact(uuid) to app_user;

-- Versions, status history and moderation decisions: the seller's members and staff.
alter table listing_versions enable row level security;
create policy lv_seller on listing_versions for select to app_user
  using (app_is_staff() or exists (select 1 from listings l where l.id = listing_id and l.seller_org_id in (select app_user_orgs())));
create policy lv_seller_insert on listing_versions for insert to app_user
  with check (created_by = app_user_id() and (app_is_staff() or exists (select 1 from listings l where l.id = listing_id and l.seller_org_id in (select app_user_orgs()))));
revoke update, delete on listing_versions from app_user;

alter table listing_status_events enable row level security;
create policy lse_read on listing_status_events for select to app_user
  using (actor_user_id = app_user_id() or app_is_staff() or exists (select 1 from listings l where l.id = listing_id and l.seller_org_id in (select app_user_orgs())));
create policy lse_insert on listing_status_events for insert to app_user
  with check (app_is_staff() or exists (select 1 from listings l where l.id = listing_id and l.seller_org_id in (select app_user_orgs())));
revoke update, delete on listing_status_events from app_user;

-- Photos: the owning organization and staff; others see photos of listings they can read (their own drafts stay private).
alter table listing_photos enable row level security;
create policy lp_read on listing_photos for select to app_user
  using (owner_org_id in (select app_user_orgs()) or app_is_staff() or (listing_id is not null and exists (select 1 from listings l where l.id = listing_id)));
create policy lp_owner_insert on listing_photos for insert to app_user with check (owner_org_id in (select app_user_orgs()) and uploaded_by = app_user_id());
create policy lp_owner_update on listing_photos for update to app_user
  using (owner_org_id in (select app_user_orgs()) or app_is_staff()) with check (owner_org_id in (select app_user_orgs()) or app_is_staff());
revoke delete on listing_photos from app_user;

alter table moderation_decisions enable row level security;
create policy md_read on moderation_decisions for select to app_user
  using (app_is_staff() or exists (select 1 from listings l where l.id = listing_id and l.seller_org_id in (select app_user_orgs())));
create policy md_staff_insert on moderation_decisions for insert to app_user with check (app_is_staff() and moderator_user_id = app_user_id());
revoke update, delete on moderation_decisions from app_user;

-- Submission checks compare a seller's photos with every other seller's (reused photos, §3.8), including listings in
-- review and blocked ones, and count open reports against the seller. These return hashes and counts for the
-- caller's own organization only.
create or replace function listing_photo_hashes_except(oid uuid) returns table (dhash text, listing_id uuid)
language sql stable security definer set search_path = public as $$
  select p.dhash, p.listing_id from listing_photos p
   where p.owner_org_id <> oid and p.status = 'ready' and p.listing_id is not null and p.created_at > now() - interval '365 days'
     and (app_is_staff() or exists (select 1 from org_members m where m.org_id = oid and m.user_id = app_user_id()))
$$;
create or replace function org_open_report_count(oid uuid) returns int language sql stable security definer set search_path = public as $$
  select case when app_is_staff() or exists (select 1 from org_members m where m.org_id = oid and m.user_id = app_user_id()) then
    (select count(*)::int from reports r where r.status = 'open' and ((r.target_type = 'seller' and r.target_id = oid)
        or (r.target_type = 'listing' and r.target_id in (select id from listings where seller_org_id = oid))))
  end
$$;
-- Reply-time reputation on the public seller card is computed from all of a seller's threads, not just the viewer's.
create or replace function seller_thread_times(oid uuid, window_days int) returns table (created_at timestamptz, first_seller_reply_at timestamptz)
language sql stable security definer set search_path = public as $$
  select t.created_at, t.first_seller_reply_at from threads t where t.seller_org_id = oid and t.created_at > now() - make_interval(days => window_days)
$$;
grant execute on function listing_photo_hashes_except(uuid) to app_user;
grant execute on function org_open_report_count(uuid) to app_user;
grant execute on function seller_thread_times(uuid, int) to app_user;

-- ---------------------------------------------------------------- chat and quote requests (001): staff writes
-- Staff release held messages and quote requests lapse when moderation takes a listing down; the 001 policies only
-- let the parties write, so those staff updates failed their WITH CHECK.
create policy msg_staff_update on messages for update to app_user using (app_is_staff()) with check (app_is_staff());
create policy qr_staff_update on quote_requests for update to app_user using (app_is_staff()) with check (app_is_staff());

-- ---------------------------------------------------------------- reviews, reports, restrictions, appeals
-- Published reviews are public; the author and the seller also see pending/removed ones. The author writes and may
-- remove their own (account deletion), the seller replies, staff publish or remove.
alter table reviews enable row level security;
create policy rv_read on reviews for select to app_user
  using (status = 'published' or author_user_id = app_user_id() or seller_org_id in (select app_user_orgs()) or app_is_staff());
create policy rv_author_insert on reviews for insert to app_user with check (author_user_id = app_user_id() and status in ('pending', 'published'));
create policy rv_update on reviews for update to app_user
  using (author_user_id = app_user_id() or seller_org_id in (select app_user_orgs()) or app_is_staff())
  with check (author_user_id = app_user_id() or seller_org_id in (select app_user_orgs()) or app_is_staff());
revoke delete on reviews from app_user;

-- Reports: the reporter sees their own; staff see and decide all. The threshold that sends a live listing back to
-- review needs every reporter's count, so it runs in report_flag_listing.
alter table reports enable row level security;
create policy rp_read on reports for select to app_user using (reporter_user_id = app_user_id() or app_is_staff());
create policy rp_insert on reports for insert to app_user with check (reporter_user_id = app_user_id());
create policy rp_staff_update on reports for update to app_user using (app_is_staff()) with check (app_is_staff());
revoke delete on reports from app_user;

-- A reporter's report pushes a live listing back to review once enough independent people reported it (§3.8 flag).
-- The same effects as applyListingStatus(..., 'in_review', null, 'flag'): status event, running promotions paused,
-- pending quote requests lapse, the seller's members are told. Runs only for a caller with an open report on it.
create or replace function report_flag_listing(lid uuid, threshold int) returns boolean
language plpgsql volatile security definer set search_path = public as $$
declare l record; n int; p record; left_s int;
begin
  if not exists (select 1 from reports where target_type = 'listing' and target_id = lid and status = 'open' and reporter_user_id = app_user_id()) then return false; end if;
  select id, status, seller_org_id, title into l from listings where id = lid for update;
  if not found or l.status <> 'live' then return false; end if;
  select count(distinct reporter_user_id)::int into n from reports where target_type = 'listing' and target_id = lid and status = 'open';
  if n < threshold then return false; end if;
  insert into listing_status_events (id, listing_id, from_status, to_status, command, actor_user_id, reason_code, note)
    values (gen_random_uuid(), lid, l.status, 'in_review', 'flag', null, 'scam_signals', 'Report threshold reached');
  for p in select id, active_since, remaining_seconds from promotion_purchases where listing_id = lid and status = 'active' for update loop
    left_s := greatest(0, p.remaining_seconds - coalesce(floor(extract(epoch from now() - p.active_since))::int, 0));
    update promotion_purchases set status = 'paused', remaining_seconds = left_s, active_since = null, ends_at = null where id = p.id;
    insert into outbox (event_id, event_type, payload) values (gen_random_uuid(), 'PromotionPaused', jsonb_build_object('purchaseId', p.id, 'listingId', lid, 'to', 'in_review'));
  end loop;
  update quote_requests set status = 'listing_unavailable' where listing_id = lid and status in ('sent', 'viewed');
  update listings set status = 'in_review', updated_at = now() where id = lid;
  insert into notifications (id, user_id, kind, title, body, link)
    select gen_random_uuid(), m.user_id, 'listing_review', 'Your listing is being reviewed', l.title || ' will be checked by a moderator.', '/my-ads'
      from org_members m where m.org_id = l.seller_org_id;
  return true;
end $$;
grant execute on function report_flag_listing(uuid, int) to app_user;

-- Restrictions: the restricted organization's members and staff. Active suspensions are also readable by everyone,
-- because provider matching (procurement) must keep suspended sellers out of the eligible list.
alter table seller_restrictions enable row level security;
create policy sr_read on seller_restrictions for select to app_user
  using (org_id in (select app_user_orgs()) or app_is_staff() or (status = 'active' and kind in ('listing_suspension', 'account_suspension')));
create policy sr_staff on seller_restrictions for all to app_user using (app_is_staff()) with check (app_is_staff());

-- Appeals: the appealing organization's members and staff; a member appeals as themself; staff decide.
alter table appeals enable row level security;
create policy ap_read on appeals for select to app_user using (seller_org_id in (select app_user_orgs()) or submitted_by = app_user_id() or app_is_staff());
create policy ap_insert on appeals for insert to app_user with check (submitted_by = app_user_id() and seller_org_id in (select app_user_orgs()));
create policy ap_staff_update on appeals for update to app_user using (app_is_staff()) with check (app_is_staff());
revoke delete on appeals from app_user;

-- ---------------------------------------------------------------- promotions (the only payments in R1)
-- Purchases: the paying organization and staff. Active promotions are labelled publicly, so active rows are readable
-- by everyone (search slots and the "promoted" label in provider matching read them in the viewer's context).
-- Only a verified webhook (system context) marks a purchase paid: see promotion_purchases_guard.
alter table promotion_purchases enable row level security;
create policy pp_read on promotion_purchases for select to app_user using (org_id in (select app_user_orgs()) or app_is_staff() or status = 'active');
create policy pp_org_insert on promotion_purchases for insert to app_user with check (org_id in (select app_user_orgs()) and created_by = app_user_id());
create policy pp_update on promotion_purchases for update to app_user
  using (org_id in (select app_user_orgs()) or app_is_staff()) with check (org_id in (select app_user_orgs()) or app_is_staff());
revoke delete on promotion_purchases from app_user;

-- From user context (other than staff) a purchase starts unpaid, or is paid for by one of the organization's unused
-- credits (zero amount, the credit's seconds); later changes are lifecycle moves only: never into paid, never out of
-- pending payment except to cancelled, no change of price, product, listing or reference, no extra time.
create or replace function promotion_purchases_guard() returns trigger language plpgsql as $$
begin
  if current_user <> 'app_user' or app_is_staff() then return new; end if;
  if tg_op = 'INSERT' then
    if new.status = 'pending_payment' and new.paid_at is null then return new; end if;
    if new.status = 'paid' and new.gross_minor = 0 and new.checkout_ref is null
       and exists (select 1 from promotion_credits c where c.org_id = new.org_id and c.used_by_purchase_id is null and c.seconds = new.remaining_seconds) then return new; end if;
    raise exception 'Promotions are paid through checkout.' using errcode = '42501';
  end if;
  if new.org_id <> old.org_id or new.listing_id <> old.listing_id or new.product_code <> old.product_code or new.kind <> old.kind
     or new.net_minor <> old.net_minor or new.tax_minor <> old.tax_minor or new.gross_minor <> old.gross_minor or new.currency <> old.currency
     or new.checkout_ref is distinct from old.checkout_ref or new.slot_weight <> old.slot_weight or new.paid_at is distinct from old.paid_at
     or new.created_by <> old.created_by or new.remaining_seconds > old.remaining_seconds
     or (new.status = 'paid' and old.status <> 'paid')
     or (old.status = 'pending_payment' and new.status not in ('pending_payment', 'cancelled')) then
    raise exception 'This promotion change is not allowed.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger promotion_purchases_guard before insert or update on promotion_purchases for each row execute function promotion_purchases_guard();

-- Credits: the organization and staff; staff (moderation) issue them; the organization uses each one once.
alter table promotion_credits enable row level security;
create policy pc_read on promotion_credits for select to app_user using (org_id in (select app_user_orgs()) or app_is_staff());
create policy pc_staff_insert on promotion_credits for insert to app_user with check (app_is_staff());
create policy pc_update on promotion_credits for update to app_user
  using (org_id in (select app_user_orgs()) or app_is_staff()) with check (org_id in (select app_user_orgs()) or app_is_staff());
revoke delete on promotion_credits from app_user;

create or replace function promotion_credits_guard() returns trigger language plpgsql as $$
begin
  if current_user <> 'app_user' or app_is_staff() then return new; end if;
  if old.used_by_purchase_id is not null or new.used_by_purchase_id is null or new.org_id <> old.org_id or new.seconds <> old.seconds
     or new.kind <> old.kind or new.source_purchase_id <> old.source_purchase_id then
    raise exception 'A promotion credit is used once, as issued.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger promotion_credits_guard before update on promotion_credits for each row execute function promotion_credits_guard();

-- Invoices: the billed organization and staff; issued only by the payment webhook (system context).
alter table platform_fees enable row level security;
create policy pf_read on platform_fees for select to app_user using (org_id in (select app_user_orgs()) or app_is_staff());
revoke insert, update, delete on platform_fees from app_user;

-- ---------------------------------------------------------------- catalog, rates and reviewer records (R2)
-- The catalog and rate evidence are reference data every project member prices against; staff maintain them.
alter table catalog_items enable row level security;
create policy ci_read on catalog_items for select to app_user using (true);
create policy ci_staff on catalog_items for all to app_user using (app_is_staff()) with check (app_is_staff());

alter table rate_observations enable row level security;
create policy ro_read on rate_observations for select to app_user using (true);
create policy ro_staff on rate_observations for all to app_user using (app_is_staff()) with check (app_is_staff());

-- A reviewer reads their own qualifications; staff record them.
alter table reviewer_qualifications enable row level security;
create policy rq_self on reviewer_qualifications for select to app_user using (user_id = app_user_id() or app_is_staff());
create policy rq_staff on reviewer_qualifications for all to app_user using (app_is_staff()) with check (app_is_staff());

-- QA acknowledgements belong to an estimate version: whoever can see the version (project members, assigned reviewers).
alter table qa_acknowledgements enable row level security;
create policy qa_member on qa_acknowledgements for select to app_user using (version_id in (select id from estimate_versions));
create policy qa_member_insert on qa_acknowledgements for insert to app_user
  with check (acknowledged_by = app_user_id() and version_id in (select id from estimate_versions));
revoke update, delete on qa_acknowledgements from app_user;
