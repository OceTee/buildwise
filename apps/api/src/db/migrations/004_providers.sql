-- Release 2.1: shared rate-limit counters (serverless instances do not share memory).
create table rate_limit_windows (
  key text not null,
  window_start timestamptz not null,
  n integer not null,
  primary key (key, window_start)
);
create index rate_limit_windows_start on rate_limit_windows (window_start);
