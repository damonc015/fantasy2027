create or replace function place_bid(p_player_id bigint, p_amount integer)
returns bids
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
  v_budget integer;
  v_auction public.auction;
  v_leader uuid;
  v_high integer;
  v_committed integer;
  v_led integer;
  v_max integer;
  v_bid public.bids;
begin
  if v_me is null then
    raise exception 'Not signed in';
  end if;
  if p_amount is null or p_amount < 1 then
    raise exception 'Bid must be at least $1';
  end if;

  -- ponytail: global lock serializes every bid, per-manager locks if throughput matters
  perform pg_advisory_xact_lock(2027);

  select budget into v_budget from public.managers where id = v_me;
  if not found then
    raise exception 'Not a manager in this league';
  end if;
  if not exists (select 1 from public.players where id = p_player_id) then
    raise exception 'Unknown player';
  end if;

  select * into v_auction from public.auction;
  if not found or clock_timestamp() >= v_auction.closes_at then
    raise exception 'Auction is closed';
  end if;

  select manager_id, amount into v_leader, v_high
  from public.current_bids where player_id = p_player_id;
  if v_high is not null and p_amount <= v_high then
    raise exception 'Bid must exceed current high bid of $%', v_high;
  end if;

  -- excludes this player, so raising an own leading bid credits the old amount
  select coalesce(sum(amount), 0), count(*) into v_committed, v_led
  from public.current_bids
  where manager_id = v_me and player_id <> p_player_id;

  if v_led >= v_auction.roster_size then
    raise exception 'Roster is full';
  end if;
  v_max := v_budget - v_committed - (v_auction.roster_size - v_led - 1);
  if p_amount > v_max then
    raise exception 'Your balance is $%, your max bid is $%', v_budget - v_committed, v_max;
  end if;

  insert into public.bids (player_id, manager_id, amount)
  values (p_player_id, v_me, p_amount)
  returning * into v_bid;

  if v_leader is not null and v_leader <> v_me then
    perform public.notify_outbid(v_leader, v_me, p_player_id, p_amount);
  end if;

  return v_bid;
end;
$$;
