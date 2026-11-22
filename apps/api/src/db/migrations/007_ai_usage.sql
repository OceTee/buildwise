-- Daily count of paid AI calls, so a per-day ceiling holds across every API instance. Server-only.
create table ai_usage (
  day date not null,
  kind text not null,
  n integer not null default 0,
  primary key (day, kind)
);
