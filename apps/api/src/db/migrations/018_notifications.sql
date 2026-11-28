-- Public beta, workstream C: people hear about things on time (spec §16, §21.1).

-- Outbox events are claimed before they are sent, so the dispatch right after a request and the scheduled one never
-- send the same event twice. A claim is a lease: an instance that dies mid-send leaves it to be retried later.
alter table outbox add column claimed_at timestamptz;

-- Coalesced notifications: at most one unread notification per (person, group), e.g. one per chat thread,
-- counting what it stands for.
alter table notifications add column group_key text;
alter table notifications add column count int not null default 1;
create unique index notifications_unread_group on notifications (user_id, group_key) where read_at is null and group_key is not null;

-- What a person wants copied to email or SMS, per topic; missing keys take the defaults (see @bw/domain notifications).
alter table users add column notification_prefs jsonb not null default '{}';
-- People change their own preferences (users is column-limited for app_user since 016_rls_marketplace).
grant update (notification_prefs) on users to app_user;

-- SMS sent per day, in total ('all') and per destination calling code ('+234'), for the market pack's caps.
-- Incremented in the sending transaction with a conditional upsert, so two sends never both take the last unit.
create table sms_usage (
  day date not null,
  scope text not null,
  sent int not null default 0,
  refused int not null default 0,
  warned_at timestamptz,
  capped_at timestamptz,
  primary key (day, scope)
);
-- Server-only, like otp_codes: every SMS is counted in system context (sign-in routes and the outbox dispatcher).
alter table sms_usage enable row level security;
revoke all on sms_usage from app_user;

-- Coalescing writes to another person's notification row, which row-level security (nt_self) does not let app_user
-- update or read back; this narrow function does exactly the upsert. '{n}' in the second title becomes the count.
create or replace function app_notify_coalesced(p_id uuid, p_user uuid, p_kind text, p_title text, p_title_many text, p_body text, p_link text, p_group text)
returns int language sql security definer set search_path = public as $$
  insert into notifications (id, user_id, kind, title, body, link, group_key) values (p_id, p_user, p_kind, p_title, p_body, p_link, p_group)
  on conflict (user_id, group_key) where read_at is null and group_key is not null
  do update set count = notifications.count + 1, title = replace(p_title_many, '{n}', (notifications.count + 1)::text),
                body = excluded.body, link = excluded.link, created_at = now()
  returning count
$$;
grant execute on function app_notify_coalesced(uuid, uuid, text, text, text, text, text, text) to app_user;
