-- The blind round can have a fixed deadline set ahead of time: start_countdown keeps it,
-- reset_countdown leaves it alone, and no blind bids are taken while the main round has no deadline.

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
  set closes_at = v_closes,
      blind_closes_at = case when blind_closes_at > v_closes then blind_closes_at else v_closes + interval '24 hours' end
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

  update public.auction set closes_at = null where id;
end;
$$;

create or replace function blind_round_open(v_auction public.auction)
returns boolean
language sql
stable
set search_path = ''
as $$
  select v_auction.closes_at is not null and v_auction.blind_closes_at is not null
    and clock_timestamp() >= v_auction.closes_at and clock_timestamp() < v_auction.blind_closes_at;
$$;

create or replace function place_blind_bid(p_player_id bigint, p_amount integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
  v_auction public.auction;
  v_budget public.manager_budgets;
begin
  if v_me is null then
    raise exception 'Not signed in';
  end if;
  if p_amount is null or p_amount < 1 then
    raise exception 'Bid must be at least $1';
  end if;

  select * into v_auction from public.auction;
  if not found or not public.blind_round_open(v_auction) then
    raise exception 'Blind round is not open';
  end if;

  select * into v_budget from public.manager_budgets where manager_id = v_me;
  if not found then
    raise exception 'Not a manager in this league';
  end if;
  if not exists (select 1 from public.players where id = p_player_id) then
    raise exception 'Unknown player';
  end if;
  if exists (select 1 from public.current_bids where player_id = p_player_id) then
    raise exception 'Player is already taken';
  end if;
  if v_budget.players_led >= v_auction.roster_size then
    raise exception 'Roster is full';
  end if;
  -- each bid must fit on its own; together they may exceed the balance, resolve_blind skips what no longer fits
  if p_amount > v_budget.max_bid then
    raise exception 'Your balance is $%, your max bid is $%', v_budget.remaining, v_budget.max_bid;
  end if;

  insert into public.blind_bids (player_id, manager_id, amount)
  values (p_player_id, v_me, p_amount)
  on conflict (player_id, manager_id) do update set amount = excluded.amount, created_at = excluded.created_at;
end;
$$;

create or replace function cancel_blind_bid(p_player_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_auction public.auction;
begin
  select * into v_auction from public.auction;
  if not found or not public.blind_round_open(v_auction) then
    raise exception 'Blind round is not open';
  end if;
  delete from public.blind_bids where player_id = p_player_id and manager_id = auth.uid();
end;
$$;

revoke execute on function blind_round_open(public.auction) from public, anon, authenticated;
