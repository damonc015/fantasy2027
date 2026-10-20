begin;
create extension if not exists pgtap with schema extensions;
select plan(18);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'a@test.local'),
  ('00000000-0000-0000-0000-00000000000b', 'b@test.local');
insert into managers (id, name, budget, is_admin) values
  ('00000000-0000-0000-0000-00000000000a', 'Admin', 100, true),
  ('00000000-0000-0000-0000-00000000000b', 'B', 100, false);
insert into players (id, name) values (1, 'P1');
insert into auction (closes_at, roster_size) values (null, 2);

create function pg_temp.act_as(manager text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000000' || manager)::text, true);
$$;

select pg_temp.act_as('b');
select lives_ok('select place_bid(1, 5)', 'main round stays open with no deadline');
select throws_ok('select place_blind_bid(1, 5)', 'P0001', 'Blind round is not open', 'no blind round before the countdown');
select throws_ok('select start_countdown()', 'P0001', 'Only the commissioner can do this', 'only the admin can start the countdown');

select pg_temp.act_as('a');
select throws_ok('select reset_countdown()', 'P0001', 'No countdown is running', 'nothing to reset before starting');
select lives_ok('select start_countdown()', 'admin starts the countdown');
select ok(
  (select closes_at between now() + interval '299 seconds' and clock_timestamp() + interval '301 seconds' from auction),
  'main round now closes in 5 minutes');
select is(
  (select blind_closes_at - closes_at from auction),
  interval '24 hours',
  'blind round closes 24 hours after the main round');
select throws_ok('select start_countdown()', 'P0001', 'Countdown is already running', 'cannot start twice');

select pg_temp.act_as('b');
select throws_ok('select reset_countdown()', 'P0001', 'Only the commissioner can do this', 'only the admin can reset');

select pg_temp.act_as('a');
select lives_ok('select reset_countdown()', 'admin resets a false start');
select is((select closes_at from auction), null, 'reset clears the main deadline');
select isnt((select blind_closes_at from auction), null, 'reset keeps the blind deadline');

select pg_temp.act_as('b');
select throws_ok('select place_blind_bid(1, 5)', 'P0001', 'Blind round is not open', 'no blind bids while the main round has no deadline');

select pg_temp.act_as('a');
update auction set blind_closes_at = '2030-01-01 23:59:00+00';
select lives_ok('select start_countdown()', 'admin starts again');
select is((select blind_closes_at from auction), '2030-01-01 23:59:00+00'::timestamptz, 'a preset blind deadline is kept');
select lives_ok('select reset_countdown()', 'admin resets again');

update auction set closes_at = now() - interval '1 second', blind_closes_at = now() + interval '1 day';
select throws_ok('select reset_countdown()', 'P0001', 'Main round is over', 'cannot reopen a finished main round');
select throws_ok('select start_countdown()', 'P0001', 'Main round is over', 'cannot restart a finished main round');

select * from finish();
rollback;
