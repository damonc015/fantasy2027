-- Blind round: after the main deadline, managers with open spots submit sealed bids on unsold players.
-- Additive only: existing bids rows are untouched.

alter table auction add column blind_closes_at timestamptz;
alter table bids add column blind boolean not null default false;

create table blind_bids (
  player_id bigint not null references players,
  manager_id uuid not null references managers,
  amount integer not null check (amount > 0),
  created_at timestamptz not null default clock_timestamp(),
  primary key (player_id, manager_id)
);

alter table blind_bids enable row level security;
create policy "own blind bids only" on blind_bids for select to authenticated using (manager_id = auth.uid());
grant select on blind_bids to authenticated, service_role;
grant insert, update, delete on blind_bids to service_role;

create function place_blind_bid(p_player_id bigint, p_amount integer)
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
  if not found or v_auction.blind_closes_at is null
    or clock_timestamp() < v_auction.closes_at or clock_timestamp() >= v_auction.blind_closes_at then
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

create function cancel_blind_bid(p_player_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_auction public.auction;
begin
  select * into v_auction from public.auction;
  if not found or v_auction.blind_closes_at is null
    or clock_timestamp() < v_auction.closes_at or clock_timestamp() >= v_auction.blind_closes_at then
    raise exception 'Blind round is not open';
  end if;
  delete from public.blind_bids where player_id = p_player_id and manager_id = auth.uid();
end;
$$;

-- Run once after blind_closes_at: select resolve_blind();
create function resolve_blind()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_auction public.auction;
  v_bid public.blind_bids;
  v_budget public.manager_budgets;
  v_awarded integer := 0;
begin
  select * into v_auction from public.auction;
  if not found or v_auction.blind_closes_at is null or clock_timestamp() < v_auction.blind_closes_at then
    raise exception 'Blind round is still open';
  end if;

  for v_bid in select * from public.blind_bids order by amount desc, created_at, manager_id loop
    continue when exists (select 1 from public.current_bids where player_id = v_bid.player_id);
    select * into v_budget from public.manager_budgets where manager_id = v_bid.manager_id;
    continue when v_budget.players_led >= v_auction.roster_size or v_bid.amount > v_budget.max_bid;
    insert into public.bids (player_id, manager_id, amount, blind)
    values (v_bid.player_id, v_bid.manager_id, v_bid.amount, true);
    v_awarded := v_awarded + 1;
  end loop;
  return v_awarded;
end;
$$;

revoke execute on function place_blind_bid(bigint, integer) from public, anon;
revoke execute on function cancel_blind_bid(bigint) from public, anon;
revoke execute on function resolve_blind() from public, anon, authenticated;
grant execute on function place_blind_bid(bigint, integer) to authenticated;
grant execute on function cancel_blind_bid(bigint) to authenticated;
