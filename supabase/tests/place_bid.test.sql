begin;
create extension if not exists pgtap with schema extensions;
select plan(32);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'a@test.local'),
  ('00000000-0000-0000-0000-00000000000b', 'b@test.local');
insert into managers (id, name, budget) values
  ('00000000-0000-0000-0000-00000000000a', 'A', 200),
  ('00000000-0000-0000-0000-00000000000b', 'B', 200);
insert into players (id, name) values (1, 'P1'), (2, 'P2'), (3, 'P3'), (4, 'P4'), (5, 'P5');
insert into auction (closes_at, roster_size) values (now() + interval '1 day', 3);

create function pg_temp.act_as(manager text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    case when manager is null then ''
         else json_build_object('sub', '00000000-0000-0000-0000-00000000000' || manager)::text end,
    true);
$$;

select pg_temp.act_as(null);
select throws_ok('select place_bid(1, 10)', 'P0001', 'Not signed in', 'anonymous caller is rejected');

select pg_temp.act_as('a');
select is(place_bid(1, 10), '{"leading": true, "price": 1, "max": 10}', 'first max bid opens at $1');
select throws_ok('select place_bid(1, 0)', 'P0001', 'Bid must be at least $1', 'zero bid is rejected');
select throws_ok('select place_bid(99, 5)', 'P0001', 'Unknown player', 'unknown player is rejected');

select pg_temp.act_as('b');
select is(place_bid(1, 10), '{"leading": false, "price": 10, "max": 10}', 'tie loses to the earlier max');
select lives_ok('select place_bid(1, 11)', 'higher bid is accepted');
select is(
  (select manager_id from current_bids where player_id = 1),
  '00000000-0000-0000-0000-00000000000b'::uuid,
  'higher bidder becomes leader');
select lives_ok('select place_bid(1, 198)', 'raising own max credits the previous max');

select pg_temp.act_as('a');
select is((select committed from manager_budgets where name = 'A'), 0, 'outbid manager gets budget back');
select throws_ok('select place_bid(2, 199)', 'P0001', 'Your balance is $200, your max bid is $198', '$1 is reserved per remaining empty roster spot');
select lives_ok('select place_bid(2, 198)', 'bid at the max is accepted');
select throws_ok('select place_bid(3, 2)', 'P0001', 'Your balance is $2, your max bid is $1', 'leading bids lock budget');
select lives_ok('select place_bid(3, 1)', 'second roster spot at $1');
select lives_ok('select place_bid(4, 1)', 'last roster spot at $1');
select throws_ok('select place_bid(5, 1)', 'P0001', 'Roster is full', 'cannot lead more players than roster size');
select results_eq(
  $$select committed, players_led, remaining from manager_budgets where name = 'A'$$,
  $$values (3, 3, 197)$$,
  'budget view shows visible prices, not private maxes');

update auction set closes_at = now() - interval '1 second';
select pg_temp.act_as('b');
select throws_ok('select place_bid(5, 1)', 'P0001', 'Auction is closed', 'bids after the deadline are rejected');

update auction set closes_at = now() + interval '1 day';
set local role authenticated;
select throws_ok(
  $$insert into bids (player_id, manager_id, amount) values (5, '00000000-0000-0000-0000-00000000000b', 1)$$,
  '42501', null, 'direct insert into bids is blocked');
reset role;

insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000000c', 'c@test.local');
insert into managers (id, name) values ('00000000-0000-0000-0000-00000000000c', 'C');
select is((select budget from managers where name = 'C'), 20000, 'default budget is 20000');


insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000d', 'd@test.local'),
  ('00000000-0000-0000-0000-00000000000e', 'e@test.local');
insert into managers (id, name, budget) values
  ('00000000-0000-0000-0000-00000000000d', 'D', 200),
  ('00000000-0000-0000-0000-00000000000e', 'E', 200);
insert into players (id, name) values (6, 'P6'), (7, 'P7');

select pg_temp.act_as('d');
select is(place_bid(6, 50), '{"leading": true, "price": 1, "max": 50}', 'max bid leads at $1');

select pg_temp.act_as('e');
select is(place_bid(6, 30), '{"leading": false, "price": 31, "max": 30}', 'lower max loses right away');
select ok(
  exists(select 1 from bids where player_id = 6 and manager_id = '00000000-0000-0000-0000-00000000000d' and amount = 31 and auto),
  'leader max auto-bids $1 over the challenger');
select is(place_bid(6, 50), '{"leading": false, "price": 50, "max": 50}', 'equal max loses to the earlier max');
select is(
  (select manager_id from current_bids where player_id = 6),
  '00000000-0000-0000-0000-00000000000d'::uuid,
  'earlier max keeps the lead on a tie');
select is(place_bid(6, 80), '{"leading": true, "price": 51, "max": 80}', 'higher max leads at $1 over the old max');
select is((select committed from manager_budgets where name = 'D'), 0, 'outbid max frees the budget');
select is(place_bid(6, 90), '{"leading": true, "price": 51, "max": 90}', 'leader raises own max without moving the price');
select is((select count(*)::integer from bids where player_id = 6), 6, 'raising own max adds no public bid');
select throws_ok('select place_bid(6, 85)', 'P0001', 'Your max is already $90', 'a max cannot be lowered');
select throws_ok('select place_bid(7, 110)', 'P0001', 'Your balance is $110, your max bid is $109', 'budget check locks the full max');

set local role authenticated;
select is(
  (select count(*)::integer from max_bids where manager_id = '00000000-0000-0000-0000-00000000000d'),
  0, 'other managers cannot read a max');
select is(
  (select amount from max_bids where player_id = 6),
  90, 'a manager can read their own max');
reset role;

select * from finish();
rollback;
