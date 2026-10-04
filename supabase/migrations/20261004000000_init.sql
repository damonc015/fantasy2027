create extension if not exists pg_net with schema extensions;

create table managers (
  id uuid primary key references auth.users on delete cascade,
  name text not null,
  discord_user_id text,
  budget integer not null default 200 check (budget >= 0)
);

create table players (
  id bigint primary key,
  name text not null,
  team text,
  positions text[] not null default '{}',
  injury_status text,
  projections jsonb not null default '{}'
);

create table auction (
  id boolean primary key default true check (id),
  closes_at timestamptz not null,
  roster_size integer not null default 13 check (roster_size > 0)
);

create table bids (
  id bigint generated always as identity primary key,
  player_id bigint not null references players,
  manager_id uuid not null references managers,
  amount integer not null check (amount > 0),
  created_at timestamptz not null default clock_timestamp()
);
create index bids_player_amount_idx on bids (player_id, amount desc, id);

create view current_bids with (security_invoker = true) as
  select distinct on (player_id) player_id, manager_id, amount, created_at
  from bids
  order by player_id, amount desc, id;

create view manager_budgets with (security_invoker = true) as
  select
    m.id as manager_id,
    m.name,
    m.budget,
    coalesce(sum(c.amount), 0)::integer as committed,
    count(c.player_id)::integer as players_led,
    (m.budget - coalesce(sum(c.amount), 0))::integer as remaining,
    (m.budget - coalesce(sum(c.amount), 0)
      - greatest(a.roster_size - count(c.player_id) - 1, 0))::integer as max_bid
  from managers m
  cross join auction a
  left join current_bids c on c.manager_id = m.id
  group by m.id, a.roster_size;

alter table managers enable row level security;
alter table players enable row level security;
alter table auction enable row level security;
alter table bids enable row level security;

create policy "signed-in read" on managers for select to authenticated using (true);
create policy "signed-in read" on players for select to authenticated using (true);
create policy "signed-in read" on auction for select to authenticated using (true);
create policy "signed-in read" on bids for select to authenticated using (true);

-- explicit, so access does not depend on the project's "expose new tables" setting
grant select on managers, players, auction, bids, current_bids, manager_budgets to authenticated, service_role;
grant insert, update, delete on managers, players, auction, bids to service_role;

alter publication supabase_realtime add table bids;

create function notify_outbid(p_outbid uuid, p_bidder uuid, p_player_id bigint, p_amount integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_mention text;
  v_bidder text;
  v_player text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'discord_webhook_url';
  if v_url is null then
    return;
  end if;
  select coalesce('<@' || discord_user_id || '>', name) into v_mention from public.managers where id = p_outbid;
  select name into v_bidder from public.managers where id = p_bidder;
  select name into v_player from public.players where id = p_player_id;
  perform net.http_post(
    url := v_url,
    body := jsonb_build_object(
      'content', format('%s outbid on **%s**: %s now leads at $%s', v_mention, v_player, v_bidder, p_amount)));
exception when others then
  -- a failed notification must never fail the bid
  raise warning 'notify_outbid failed: %', sqlerrm;
end;
$$;

create function place_bid(p_player_id bigint, p_amount integer)
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
    raise exception 'Max bid is $%', v_max;
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

revoke execute on function notify_outbid(uuid, uuid, bigint, integer) from public, anon, authenticated;
revoke execute on function place_bid(bigint, integer) from public, anon;
grant execute on function place_bid(bigint, integer) to authenticated;
