-- Device-level limits must count across accounts (one scraper, many accounts), which the per-user row-level
-- security hides. These functions return counts only, never rows.
create or replace function reveals_from_device(dev text, since timestamptz) returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int from contact_reveals where device_id = dev and created_at > since
$$;
grant execute on function reveals_from_device(text, timestamptz) to app_user;
