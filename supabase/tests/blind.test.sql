begin;
create extension if not exists pgtap with schema extensions;
select plan(20);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'a@test.local'),
  ('00000000-0000-0000-0000-00000000000b', 'b@test.local'),
  ('00000000-0000-0000-0000-00000000000c', 'c@test.local');
insert into managers (id, name, budget) values
  ('00000000-0000-0000-0000-00000000000a', 'A', 100),
  ('00000000-0000-0000-0000-00000000000b', 'B', 100),
  ('00000000-0000-0000-0000-00000000000c', 'C', 100);
insert into players (id, name) values (1, 'P1'), (2, 'P2'), (3, 'P3'), (4, 'P4'), (5, 'P5');
insert into auction (closes_at, blind_closes_at, roster_size) values (now() + interval '1 day', now() + interval '2 days', 2);

create function pg_temp.act_as(manager text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000000' || manager)::text, true);
$$;

-- main round: A wins P1 at $40, C fills both spots
select pg_temp.act_as('a');
select place_bid(1, 40);
select pg_temp.act_as('c');
select place_bid(2, 10);
select place_bid(3, 10);

select pg_temp.act_as('b');
select throws_ok('select place_blind_bid(4, 5)', 'P0001', 'Blind round is not open', 'no blind bids during the main round');

update auction set closes_at = now() - interval '1 second';
select throws_ok('select place_bid(4, 5)', 'P0001', 'Auction is closed', 'main bids stop at the main deadline');

select lives_ok('select place_blind_bid(4, 30)', 'blind bid on an unsold player');
select throws_ok('select place_blind_bid(1, 50)', 'P0001', 'Player is already taken', 'sold players cannot be bid on');
select throws_ok('select place_blind_bid(5, 100)', 'P0001', 'Your balance is $100, your max bid is $99', 'blind bid keeps $1 per other empty spot');
select lives_ok('select place_blind_bid(5, 99)', 'bids may add up to more than your balance');
select throws_ok('select place_blind_bid(99, 5)', 'P0001', 'Unknown player', 'unknown player is rejected');
select throws_ok('select place_blind_bid(4, 0)', 'P0001', 'Bid must be at least $1', 'zero bid is rejected');

select pg_temp.act_as('c');
select throws_ok('select place_blind_bid(4, 5)', 'P0001', 'Roster is full', 'full roster cannot bid');

select pg_temp.act_as('a');
select lives_ok('select place_blind_bid(4, 30)', 'A ties B on P4, later than B');
select lives_ok('select place_blind_bid(5, 20)', 'A bids on P5');
select lives_ok('select cancel_blind_bid(5)', 'a blind bid can be withdrawn');
select is(
  (select count(*)::integer from blind_bids where player_id = 5 and manager_id = '00000000-0000-0000-0000-00000000000a'),
  0, 'withdrawn bid is gone');
select lives_ok('select place_blind_bid(5, 20)', 'A bids on P5 again');

set local role authenticated;
select is((select count(*)::integer from blind_bids), 2, 'a manager sees only their own blind bids');
reset role;

select throws_ok('select resolve_blind()', 'P0001', 'Blind round is still open', 'cannot resolve before the blind deadline');

update auction set blind_closes_at = now() - interval '1 second';
select throws_ok('select place_blind_bid(4, 31)', 'P0001', 'Blind round is not open', 'no blind bids after the blind deadline');

-- B's P5 $99 wins first, leaving B $1, so B's P4 $30 is skipped even though it came before A's.
-- A's P4 $30 wins next. A's P5 $20 is skipped, P5 is taken. A's P1 cost $1 (opened alone at $1).
select resolve_blind();
select results_eq(
  $$select player_id, name, amount from current_bids c join managers m on m.id = c.manager_id where player_id in (4, 5) order by player_id$$,
  $$values (4::bigint, 'A'::text, 30), (5::bigint, 'B'::text, 99)$$,
  'highest bids win, skipping bids the manager can no longer afford');
select results_eq(
  $$select name, players_led, remaining from manager_budgets order by name$$,
  $$values ('A'::text, 2, 69), ('B'::text, 1, 1), ('C'::text, 2, 98)$$,
  'winners pay their own bid');
select ok(
  (select bool_and(blind) from bids where player_id in (4, 5)),
  'blind wins are marked in the log');

select * from finish();
rollback;
