-- Supabase's API blocks UPDATE without a WHERE clause (pg-safeupdate), even inside functions.
-- auction has a single row keyed by id = true. Also reads the clock once, so the blind deadline is exactly 24 hours later.

create or replace function start_countdown()
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_auction public.auction;
  v_closes timestamptz := clock_timestamp() + interval '5 minutes';
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
  set closes_at = v_closes, blind_closes_at = v_closes + interval '24 hours'
  where id;
  return v_closes;
end;
$$;

create or replace function reset_countdown()
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

  update public.auction set closes_at = null, blind_closes_at = null where id;
end;
$$;
