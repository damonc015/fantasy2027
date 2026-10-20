-- The commissioner ends the main round with a 5 minute countdown instead of a fixed deadline.
-- closes_at null means the main round is open with no deadline yet.

alter table auction alter column closes_at drop not null;
alter table managers add column is_admin boolean not null default false;
update managers set is_admin = true where name = 'Damon';

-- pages reload when the countdown starts or resets
alter publication supabase_realtime add table auction;

create function start_countdown()
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_auction public.auction;
begin
  if not exists (select 1 from public.managers where id = auth.uid() and is_admin) then
    raise exception 'Only the commissioner can do this';
  end if;
  select * into v_auction from public.auction for update;
  if v_auction.closes_at is not null and clock_timestamp() >= v_auction.closes_at then
    raise exception 'Main round is over';
  end if;
  if v_auction.closes_at is not null then
    raise exception 'Countdown is already running';
  end if;

  update public.auction
  set closes_at = clock_timestamp() + interval '5 minutes',
      blind_closes_at = clock_timestamp() + interval '5 minutes' + interval '24 hours'
  returning closes_at into v_auction.closes_at;
  return v_auction.closes_at;
end;
$$;

create function reset_countdown()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_auction public.auction;
begin
  if not exists (select 1 from public.managers where id = auth.uid() and is_admin) then
    raise exception 'Only the commissioner can do this';
  end if;
  select * into v_auction from public.auction for update;
  if v_auction.closes_at is null then
    raise exception 'No countdown is running';
  end if;
  if clock_timestamp() >= v_auction.closes_at then
    raise exception 'Main round is over';
  end if;

  update public.auction set closes_at = null, blind_closes_at = null;
end;
$$;

revoke execute on function start_countdown() from public, anon;
revoke execute on function reset_countdown() from public, anon;
grant execute on function start_countdown() to authenticated;
grant execute on function reset_countdown() to authenticated;
