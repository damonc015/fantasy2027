-- Proxy bidding: each manager sets a private max, the server bids $1 over the competition up to it.
-- Additive only: existing bids rows are untouched.

create table max_bids (
  player_id bigint not null references players,
  manager_id uuid not null references managers,
  amount integer not null check (amount > 0),
  created_at timestamptz not null default clock_timestamp(),
  primary key (player_id, manager_id)
);

alter table max_bids enable row level security;
create policy "own max only" on max_bids for select to authenticated using (manager_id = auth.uid());
grant select on max_bids to authenticated, service_role;
grant insert, update, delete on max_bids to service_role;

-- current leaders keep their visible bid as their max
insert into max_bids (player_id, manager_id, amount, created_at)
select player_id, manager_id, amount, created_at from current_bids;

alter table bids add column auto boolean not null default false;

-- on a tie the leader's auto bid beats the challenger's bid placed just before it
create or replace view current_bids with (security_invoker = true) as
  select distinct on (player_id) player_id, manager_id, amount, created_at
  from bids
  order by player_id, amount desc, auto desc, id;

drop function place_bid(bigint, integer);

create function place_bid(p_player_id bigint, p_amount integer)
returns jsonb
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
  v_leader_max integer;
  v_committed integer;
  v_led integer;
  v_max integer;
  v_price integer;
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
  select coalesce(max(amount), v_high) into v_leader_max
  from public.max_bids where player_id = p_player_id and manager_id = v_leader;

  if v_leader = v_me and p_amount <= v_leader_max then
    raise exception 'Your max is already $%', v_leader_max;
  end if;

  -- full maxes of players I lead are locked, excluding this player so raising my own max credits the old one
  select coalesce(sum(m.amount), 0), count(*) into v_committed, v_led
  from public.current_bids c
  join public.max_bids m on m.player_id = c.player_id and m.manager_id = c.manager_id
  where c.manager_id = v_me and c.player_id <> p_player_id;

  if v_led >= v_auction.roster_size then
    raise exception 'Roster is full';
  end if;
  v_max := v_budget - v_committed - (v_auction.roster_size - v_led - 1);
  if p_amount > v_max then
    raise exception 'Your balance is $%, your max bid is $%', v_budget - v_committed, v_max;
  end if;

  insert into public.max_bids (player_id, manager_id, amount)
  values (p_player_id, v_me, p_amount)
  on conflict (player_id, manager_id) do update set amount = excluded.amount, created_at = excluded.created_at;

  if v_leader = v_me then
    return jsonb_build_object('leading', true, 'price', v_high, 'max', p_amount);
  end if;

  if v_leader is null then
    insert into public.bids (player_id, manager_id, amount) values (p_player_id, v_me, 1);
    return jsonb_build_object('leading', true, 'price', 1, 'max', p_amount);
  end if;

  if p_amount <= v_leader_max then
    v_price := least(v_leader_max, p_amount + 1);
    insert into public.bids (player_id, manager_id, amount) values (p_player_id, v_me, p_amount);
    insert into public.bids (player_id, manager_id, amount, auto) values (p_player_id, v_leader, v_price, true);
    return jsonb_build_object('leading', false, 'price', v_price, 'max', p_amount);
  end if;

  -- shows the old leader's max being used up, so the price jump makes sense in the log
  if v_leader_max > v_high then
    insert into public.bids (player_id, manager_id, amount, auto) values (p_player_id, v_leader, v_leader_max, true);
  end if;
  v_price := least(p_amount, v_leader_max + 1);
  insert into public.bids (player_id, manager_id, amount) values (p_player_id, v_me, v_price);
  perform public.notify_outbid(v_leader, v_me, p_player_id, v_price);
  return jsonb_build_object('leading', true, 'price', v_price, 'max', p_amount);
end;
$$;

revoke execute on function place_bid(bigint, integer) from public, anon;
grant execute on function place_bid(bigint, integer) to authenticated;
