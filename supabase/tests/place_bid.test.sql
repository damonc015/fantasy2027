begin;
create extension if not exists pgtap with schema extensions;
select plan(19);

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
select lives_ok('select place_bid(1, 10)', 'first bid on a player is accepted');
select throws_ok('select place_bid(1, 0)', 'P0001', 'Bid must be at least $1', 'zero bid is rejected');
select throws_ok('select place_bid(99, 5)', 'P0001', 'Unknown player', 'unknown player is rejected');

select pg_temp.act_as('b');
select throws_ok('select place_bid(1, 10)', 'P0001', 'Bid must exceed current high bid of $10', 'tie loses to the earlier bid');
select lives_ok('select place_bid(1, 11)', 'higher bid is accepted');
select is(
  (select manager_id from current_bids where player_id = 1),
  '00000000-0000-0000-0000-00000000000b'::uuid,
  'higher bidder becomes leader');
select lives_ok('select place_bid(1, 198)', 'raising own bid credits the previous amount');

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
  $$values (200, 3, 0)$$,
  'budget view matches leading bids');

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

select * from finish();
rollback;
