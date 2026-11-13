-- The prize of the tourist passport (C2 · Paso 3, ADR-058): a voucher only for a passport whose
-- stamps of every published stop carry the municipality's signature; one per passport while
-- not redeemed, never a second prize after redeeming; the shop's key is only a hash and only
-- owners and admins set it; redeeming needs the code and the key, once, before it expires;
-- failures are limited per hour; another municipality, a suspended one or a circuit without a
-- prize give nothing.
begin;
set local client_min_messages to warning;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

\set ta 'aaaaaaaa-0000-4000-8000-000000000001'
\set tb 'bbbbbbbb-0000-4000-8000-000000000001'
\set ownera '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}'
\set editora '{"sub":"00000000-0000-4000-8000-0000000000a2","role":"authenticated","aal":"aal2"}'
\set analysta '{"sub":"00000000-0000-4000-8000-0000000000a3","role":"authenticated","aal":"aal2"}'
\set ownerb '{"sub":"00000000-0000-4000-8000-0000000000b1","role":"authenticated","aal":"aal2"}'
\set p1 'AbCdEfGhIjKlMnOpQrSt_1'
\set p2 'AbCdEfGhIjKlMnOpQrSt_2'

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000a1', 'owner.a@example.test'),
  ('00000000-0000-4000-8000-0000000000a2', 'editor.a@example.test'),
  ('00000000-0000-4000-8000-0000000000a3', 'analyst.a@example.test'),
  ('00000000-0000-4000-8000-0000000000b1', 'owner.b@example.test');
insert into public.tenants (id, slug, display_name, status, default_locale, timezone) values
  (:'ta', 'tenant-a', 'Tenant A', 'provisioning', 'es', 'America/La_Paz'),
  (:'tb', 'tenant-b', 'Tenant B', 'provisioning', 'es', 'America/La_Paz');
insert into public.memberships (tenant_id, user_id, role, status, accepted_at) values
  (:'ta', '00000000-0000-4000-8000-0000000000a1', 'owner', 'active', now()),
  (:'ta', '00000000-0000-4000-8000-0000000000a2', 'editor', 'active', now()),
  (:'ta', '00000000-0000-4000-8000-0000000000a3', 'analyst', 'active', now()),
  (:'tb', '00000000-0000-4000-8000-0000000000b1', 'owner', 'active', now());
update public.tenants set status = 'active';
set constraints all immediate;

create temp table ids (name text primary key, id uuid);
create temp table scratch (v text);
grant select, insert on ids, scratch to authenticated, anon;

set local role authenticated;
set local request.jwt.claims to :'ownera';
insert into ids select 'plaza', content_id from public.create_content_item(:'ta', 'destination', 'plaza', 'Plaza');
insert into ids select 'museo', content_id from public.create_content_item(:'ta', 'destination', 'museo', 'Museo');
reset role;
insert into public.content_revisions (id, tenant_id, content_id, revision_no, state, title, summary, latitude, longitude, sealed_at)
select gen_random_uuid(), i.tenant_id, i.id, 2, 'sealed', initcap(i.slug), 'Texto.', -17.5, -65.9, now()
from public.content_items i where i.id in (select id from ids);
update public.content_items c set published_revision_id = r.id, published_at = now()
from public.content_revisions r where r.content_id = c.id and r.state = 'sealed' and c.id in (select id from ids);

set local role authenticated;
set local request.jwt.claims to :'ownera';
-- «Ruta» with a prize (and later a key); «Otra» with a prize and no key; «Vacia» without a prize.
insert into ids select 'ruta', public.create_passport_circuit(:'ta', 'ruta', 'Ruta');
insert into scratch select public.save_passport_circuit(:'ta', (select id from ids where name = 'ruta'), 1, 'Ruta', '',
  'Una postal.', array[(select id from ids where name = 'plaza'), (select id from ids where name = 'museo')]);
insert into scratch select public.publish_passport_circuit(:'ta', (select id from ids where name = 'ruta'), 2);
insert into ids select 'otra', public.create_passport_circuit(:'ta', 'otra', 'Otra');
insert into scratch select public.save_passport_circuit(:'ta', (select id from ids where name = 'otra'), 1, 'Otra', '',
  'Un llavero.', array[(select id from ids where name = 'museo'), (select id from ids where name = 'plaza')]);
insert into scratch select public.publish_passport_circuit(:'ta', (select id from ids where name = 'otra'), 2);
insert into ids select 'vacia', public.create_passport_circuit(:'ta', 'vacia', 'Vacia');
insert into scratch select public.save_passport_circuit(:'ta', (select id from ids where name = 'vacia'), 1, 'Vacia', '', '',
  array[(select id from ids where name = 'museo'), (select id from ids where name = 'plaza')]);
insert into scratch select public.publish_passport_circuit(:'ta', (select id from ids where name = 'vacia'), 2);
reset role;

-- Stamps collected by two phones: p1 the plaza with location and the museum without; p2 only the plaza.
create temp table stamps (passport text, place text, s jsonb);
grant select on stamps to anon, authenticated;
insert into stamps
select :'p1', 'plaza', public.portal_collect_stamp(:'ta', k.code, :'p1', true)
from public.passport_stamp_codes k where k.content_id = (select id from ids where name = 'plaza');
insert into stamps
select :'p1', 'museo', public.portal_collect_stamp(:'ta', k.code, :'p1', false)
from public.passport_stamp_codes k where k.content_id = (select id from ids where name = 'museo');
insert into stamps
select :'p2', 'plaza', public.portal_collect_stamp(:'ta', k.code, :'p2', false)
from public.passport_stamp_codes k where k.content_id = (select id from ids where name = 'plaza');
create temp view phone as
select passport, jsonb_agg(jsonb_build_object('placeId', s->'id', 'at', s->'at', 'located', s->'located',
                                              'signature', s->'signature')) as stamps
from stamps group by passport;
grant select on phone to anon, authenticated;

select plan(42);

-- ── Asking for the prize ──────────────────────────────────────────────────
set local role anon;
select throws_ok(format('select public.portal_request_voucher(%L, %L, %L, %L)', :'ta', 'ruta', 'corto', '[]'),
  '22023', null, 'an invalid passport id is refused');
select is(public.portal_request_voucher(:'ta', 'ruta', :'p2', (select stamps from phone where passport = :'p2'))->>'status',
  'incomplete', 'with one of two stamps, the circuit is not complete');
select is((public.portal_request_voucher(:'ta', 'ruta', :'p2', (select stamps from phone where passport = :'p2'))->>'missing')::int,
  1, 'and it says how many are missing');
select is(public.portal_request_voucher(:'ta', 'ruta', :'p1',
    (select jsonb_agg(jsonb_set(x, '{located}', 'true')) from phone, jsonb_array_elements(stamps) x where passport = :'p1'))->>'status',
  'incomplete', 'a stamp changed on the phone («sin ubicación» to «con ubicación») does not count');
select is(public.portal_request_voucher(:'ta', 'ruta', :'p2', (select stamps from phone where passport = :'p1'))->>'status',
  'incomplete', 'nor stamps copied from another phone');
select is(public.portal_request_voucher(:'ta', 'ruta', :'p1',
    (select jsonb_agg(jsonb_set(x, '{at}', '"1.5"')) from phone, jsonb_array_elements(stamps) x where passport = :'p1'))->>'status',
  'incomplete', 'nor stamps with a malformed time');
select is(public.portal_request_voucher(:'ta', 'vacia', :'p1', (select stamps from phone where passport = :'p1'))->>'status',
  'no_reward', 'a circuit without a prize gives no voucher');
select is(public.portal_request_voucher(:'tb', 'ruta', :'p1', (select stamps from phone where passport = :'p1'))->>'status',
  'not_found', 'another municipality does not know the circuit');
select is(public.portal_request_voucher(:'ta', 'no-existe', :'p1', (select stamps from phone where passport = :'p1'))->>'status',
  'not_found', 'nor an unknown circuit');

create temp table v1 as
select public.portal_request_voucher(:'ta', 'ruta', :'p1', (select stamps from phone where passport = :'p1')) as v;
select is((select v->>'status' from v1), 'issued', 'a complete passport gets a voucher');
select ok((select v->>'code' ~ '^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$' from v1), 'with an 8-character code');
select is((select (v->>'stampsTotal')::int || '/' || (v->>'stampsLocated')::int from v1), '2/1',
  'saying how many stamps were located');
select is((select (v->>'expiresAt')::timestamptz - (v->>'issuedAt')::timestamptz from v1), interval '30 days',
  'valid 30 days');
select is(public.portal_request_voucher(:'ta', 'ruta', :'p1', (select stamps from phone where passport = :'p1'))->>'code',
  (select v->>'code' from v1), 'asking again gives the same voucher');
select is(public.portal_request_voucher(:'ta', 'ruta', :'p1', (select stamps from phone where passport = :'p1'))->>'status',
  'active', 'marked as the one already given');
select throws_ok('select * from public.passport_vouchers', '42501', null, 'visitors do not read the vouchers');
reset role;
select ok((select passport_hash <> :'p1' and passport_hash ~ '^[0-9a-f]{64}$' from public.passport_vouchers limit 1),
  'the passport id is kept only as a hash');

-- ── The shop's key ────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to :'editora';
select throws_ok(format('select public.set_passport_redeem_pin(%L, %L, %L)', :'ta', (select id from ids where name = 'ruta'), '2468'),
  '42501', null, 'an editor does not set the key');
set local request.jwt.claims to :'ownerb';
select throws_ok(format('select public.set_passport_redeem_pin(%L, %L, %L)', :'ta', (select id from ids where name = 'ruta'), '2468'),
  '42501', null, 'nor another municipality''s owner');
set local request.jwt.claims to :'ownera';
select throws_ok(format('select public.set_passport_redeem_pin(%L, %L, %L)', :'ta', (select id from ids where name = 'ruta'), '12a'),
  '22023', null, 'the key is 4 to 8 digits');
select lives_ok(format('select public.set_passport_redeem_pin(%L, %L, %L)', :'ta', (select id from ids where name = 'ruta'), '2468'),
  'the owner sets the key');
set local request.jwt.claims to :'analysta';
select ok((select e->>'pinSetAt' is not null from jsonb_array_elements(public.tenant_passport_rewards(:'ta')) e
           where e->>'circuitId' = (select id::text from ids where name = 'ruta')), 'any member sees that it has a key');
select ok((select e->>'pinSetAt' is null from jsonb_array_elements(public.tenant_passport_rewards(:'ta')) e
           where e->>'circuitId' = (select id::text from ids where name = 'otra')), 'and which do not');
set local request.jwt.claims to :'ownerb';
select throws_ok(format('select public.tenant_passport_rewards(%L)', :'ta'), '42501', null, 'another municipality does not');
reset role;
select ok((select redeem_pin_hash like '$2a$%' and redeem_pin_hash not like '%2468%' from public.passport_circuits
           where id = (select id from ids where name = 'ruta')), 'only a bcrypt hash is kept');
select is((select count(*)::int from public.audit_events where action = 'passport.redeem_pin_set'), 1, 'setting it is audited');

-- ── Redeeming ─────────────────────────────────────────────────────────────
set local role anon;
select is(public.portal_redeem_voucher(:'ta', (select v->>'code' from v1), '1357', false)->>'status', 'wrong',
  'a wrong key does not check the voucher');
select is(public.portal_redeem_voucher(:'ta', 'ZZZZZZZZ', '2468', false)->>'status', 'wrong', 'nor an unknown code');
select is(public.portal_redeem_voucher(:'tb', (select v->>'code' from v1), '2468', false)->>'status', 'wrong',
  'nor the code in another municipality');
select is(public.portal_redeem_voucher(:'ta', lower(substr((select v->>'code' from v1), 1, 4)) || '-' ||
    substr((select v->>'code' from v1), 5), '2468', false)->>'status', 'valid',
  'the code in lower case and with a dash, and the right key, check it');
select is(public.portal_redeem_voucher(:'ta', (select v->>'code' from v1), '2468', false)->>'reward', 'Una postal.',
  'showing the prize, without redeeming it');
select is(public.portal_redeem_voucher(:'ta', (select v->>'code' from v1), '2468', true)->>'status', 'redeemed',
  'the shop redeems it');
select is(public.portal_redeem_voucher(:'ta', (select v->>'code' from v1), '2468', true)->>'status', 'already_redeemed',
  'only once');
select is(public.portal_request_voucher(:'ta', 'ruta', :'p1', (select stamps from phone where passport = :'p1'))->>'status',
  'redeemed', 'the phone learns it was redeemed, and gets no second prize');
reset role;
select is((select count(*)::int from public.passport_vouchers where circuit_id = (select id from ids where name = 'ruta')), 1,
  'one voucher for that passport and circuit');
select is((select count(*)::int from public.audit_events where action = 'passport.voucher_redeemed'), 1, 'redeeming is audited');

-- A circuit without a key cannot be redeemed; an expired voucher neither, and the phone gets a new one.
set local role anon;
insert into scratch select public.portal_request_voucher(:'ta', 'otra', :'p1', (select stamps from phone where passport = :'p1'))->>'code';
select is(public.portal_redeem_voucher(:'ta', (select v from scratch order by v desc limit 1), '2468', false)->>'status',
  'no_pin', 'a circuit without the shop''s key cannot be redeemed');
reset role;
update public.passport_circuits set redeem_pin_hash = extensions.crypt('9999', extensions.gen_salt('bf', 8)),
  redeem_pin_set_at = now() where id = (select id from ids where name = 'otra');
update public.passport_vouchers set issued_at = now() - interval '31 days', expires_at = now() - interval '1 day'
where circuit_id = (select id from ids where name = 'otra');
create temp table old as select code from public.passport_vouchers where circuit_id = (select id from ids where name = 'otra');
grant select on old to anon;
set local role anon;
select is(public.portal_redeem_voucher(:'ta', (select code from old), '9999', true)->>'status', 'expired',
  'an expired voucher is not redeemed');
select isnt(public.portal_request_voucher(:'ta', 'otra', :'p1', (select stamps from phone where passport = :'p1'))->>'code',
  (select code from old), 'the phone gets a new one after it expired');

-- 30 failures in an hour stop the page for the municipality.
reset role;
insert into private.passport_redeem_failures (tenant_id, hour, failures) values (:'ta', date_trunc('hour', now()), 30)
on conflict (tenant_id, hour) do update set failures = 30;
set local role anon;
select is(public.portal_redeem_voucher(:'ta', (select code from old), '9999', false)->>'status', 'too_many',
  'after 30 failures in an hour, nothing is checked');
reset role;
select throws_ok('set local role anon; select * from private.passport_redeem_failures', '42501', null,
  'nobody reads the failures');
reset role;

-- A suspended municipality gives and redeems nothing.
update public.tenants set status = 'suspended' where id = :'ta';
set local role anon;
select is(public.portal_request_voucher(:'ta', 'ruta', :'p1', (select stamps from phone where passport = :'p1'))->>'status',
  'not_found', 'a suspended municipality gives no voucher');
reset role;

select * from finish();
rollback;
