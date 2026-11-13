-- The Copilot's recommendations (C1 · Paso 4, ADR-054): any member generates and reads them,
-- only the latest set is kept, every recommendation cites known facts and every number it
-- writes is in the facts it cites (checked again here), the targets are of this
-- municipality, and the model's request behind them is this person's, here, in the last
-- hour. Another municipality sees and saves nothing; nobody reads the table directly.
begin;
set local client_min_messages to warning;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

\set ta 'aaaaaaaa-0000-4000-8000-000000000001'
\set tb 'bbbbbbbb-0000-4000-8000-000000000001'
\set ownera '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}'
\set ownera1 '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal1"}'
\set editora '{"sub":"00000000-0000-4000-8000-0000000000a2","role":"authenticated","aal":"aal2"}'
\set analysta '{"sub":"00000000-0000-4000-8000-0000000000a3","role":"authenticated","aal":"aal2"}'
\set ownerb '{"sub":"00000000-0000-4000-8000-0000000000b1","role":"authenticated","aal":"aal2"}'
\set req 'cccccccc-0000-4000-8000-000000000001'
\set req_owner 'cccccccc-0000-4000-8000-000000000002'
\set req_old 'cccccccc-0000-4000-8000-000000000003'
\set req_probe 'cccccccc-0000-4000-8000-000000000004'
\set req_b 'cccccccc-0000-4000-8000-000000000005'
\set req_open 'cccccccc-0000-4000-8000-000000000006'
\set from '2026-10-13'
\set to '2026-11-11'

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

insert into public.ai_requests (id, tenant_id, profile, status, outcome, actor_id, created_at, finished_at) values
  (:'req', :'ta', 'copilot', 'completed', 'answered', '00000000-0000-4000-8000-0000000000a3', now(), now()),
  (:'req_owner', :'ta', 'copilot', 'completed', 'answered', '00000000-0000-4000-8000-0000000000a1', now(), now()),
  (:'req_old', :'ta', 'copilot', 'completed', 'answered', '00000000-0000-4000-8000-0000000000a3', now() - interval '2 hours', now() - interval '2 hours'),
  (:'req_probe', :'ta', 'probe', 'completed', 'answered', '00000000-0000-4000-8000-0000000000a3', now(), now()),
  (:'req_b', :'tb', 'copilot', 'completed', 'answered', '00000000-0000-4000-8000-0000000000b1', now(), now());
insert into public.ai_requests (id, tenant_id, profile, status, outcome, actor_id, created_at, finished_at) values
  (:'req_open', :'ta', 'copilot', 'failed', 'provider_error', '00000000-0000-4000-8000-0000000000a3', now(), now());

create temp table ids (name text primary key, id uuid);
grant select, insert on ids to authenticated;

set local role authenticated;
set local request.jwt.claims to :'ownera';
insert into ids select 'museo', content_id from public.create_content_item(:'ta', 'destination', 'museo', 'Museo');
insert into ids select 'feria', content_id from public.create_content_item(:'ta', 'event', 'feria', 'Feria');
insert into ids select 'tour', tour_id from public.create_tour(:'ta', (select id from ids where name = 'museo'));
set local request.jwt.claims to :'ownerb';
insert into ids select 'ajeno', content_id from public.create_content_item(:'tb', 'destination', 'museo', 'Museo B');
reset role;

-- The facts every case starts from.
create temp table f (facts jsonb, items jsonb);
insert into f values (
  jsonb_build_array(
    jsonb_build_object('id', 'H1', 'source', 'visits', 'text',
      'Portal, del 13 oct al 11 nov de 2026 (últimos 30 días): 1.234 vistas y 456 visitantes.', 'target', null),
    jsonb_build_object('id', 'H2', 'source', 'visits', 'text', 'Destino «Museo»: 15 vistas y 3 «Cómo llegar».',
      'target', jsonb_build_object('type', 'content', 'kind', 'destination', 'contentId', (select id from ids where name = 'museo'), 'proposable', true)),
    jsonb_build_object('id', 'H3', 'source', 'questions', 'text', 'Pregunta sin respuesta «¿hay cajero?»: 4 veces, 2 personas.',
      'target', jsonb_build_object('type', 'question', 'question', '¿hay cajero?')),
    jsonb_build_object('id', 'H4', 'source', 'review', 'text', 'Escena «Sala» del tour de «Museo» sin descripción.',
      'target', jsonb_build_object('type', 'scene', 'kind', 'destination', 'contentId', (select id from ids where name = 'museo'),
        'tourId', (select id from ids where name = 'tour'), 'sceneId', gen_random_uuid())),
    jsonb_build_object('id', 'H5', 'source', 'agenda', 'text', 'La agenda no tiene eventos próximos publicados.',
      'target', jsonb_build_object('type', 'agenda'))
  ),
  '[{"title":"Responde la pregunta del cajero","why":"Se preguntó 4 veces, por 2 personas (H3).","facts":["H3"]},
    {"title":"Completa el museo y su tour 360°","why":"Tuvo 15 vistas y 3 «Cómo llegar» en 1234 vistas del portal.","facts":["H2","H1"]}]'
);
grant select on f to authenticated;

select plan(38);

-- ── Numbers ────────────────────────────────────────────────────────────────
select is(private.recommendation_numbers('1.234 vistas, 09 escaneos, H3 y el tour 360°; 12,5 %'),
  array['1234', '125', '9'], 'figures are normalized; a fact label and «360°» are not figures');
select is(private.recommendation_numbers('Sin cifras'), '{}'::text[], 'a text without figures has none');

-- ── Saving and reading ─────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to :'analysta';
insert into ids select 'first', public.save_copilot_recommendations(:'ta', :'req', :'from', :'to', (select facts from f), (select items from f));
select ok((select id from ids where name = 'first') is not null, 'an analyst saves recommendations backed by her own copilot request');
select is(public.latest_copilot_recommendations(:'ta') ->> 'id', (select id::text from ids where name = 'first'), 'and reads them back');
select is(jsonb_array_length(public.latest_copilot_recommendations(:'ta') -> 'items'), 2, 'with their recommendations');
select is(jsonb_array_length(public.latest_copilot_recommendations(:'ta') -> 'facts'), 5, 'and the facts they rest on');
select is(public.latest_copilot_recommendations(:'ta') ->> 'from', '2026-10-13', 'and the period of the visits');
select is((public.latest_copilot_recommendations(:'ta') ->> 'mine')::boolean, true, 'she made them');
set local request.jwt.claims to :'editora';
select is((public.latest_copilot_recommendations(:'ta') ->> 'mine')::boolean, false, 'an editor reads them too (not his)');
set local request.jwt.claims to :'ownerb';
select is(public.latest_copilot_recommendations(:'tb'), null::jsonb, 'B has no recommendations');
select throws_ok(format('select public.latest_copilot_recommendations(%L)', :'ta'), '42501', null,
  'another municipality cannot read them');
select throws_ok(format('select public.save_copilot_recommendations(%L, %L, %L, %L, %L, %L)', :'ta', :'req_b', :'from', :'to',
  (select facts from f), (select items from f)), '42501', null, 'nor save them');
set local request.jwt.claims to :'ownera1';
select throws_ok(format('select public.latest_copilot_recommendations(%L)', :'ta'), '42501', null,
  'an owner without her second factor cannot read them (ADR-043)');
select throws_ok('select * from public.copilot_recommendations', '42501', null, 'nobody reads the table directly');
reset role;
set local role anon;
select throws_ok(format('select public.latest_copilot_recommendations(%L)', :'ta'), '42501', null, 'a visitor cannot call it');
reset role;

-- ── What is refused ────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to :'analysta';
select throws_ok(format('select public.save_copilot_recommendations(%L, %L, %L, %L, %L, %L)', :'ta', :'req', :'from', :'to',
  (select facts from f), '[{"title":"Sube las visitas","why":"El museo tuvo 16 vistas.","facts":["H2"]}]'),
  '23514', null, 'a number that its facts do not have is refused');
select throws_ok(format('select public.save_copilot_recommendations(%L, %L, %L, %L, %L, %L)', :'ta', :'req', :'from', :'to',
  (select facts from f), '[{"title":"Sube las visitas","why":"El portal tuvo 1234 vistas.","facts":["H2"]}]'),
  '23514', null, 'so is a number of a fact it does not cite');
select throws_ok(format('select public.save_copilot_recommendations(%L, %L, %L, %L, %L, %L)', :'ta', :'req', :'from', :'to',
  (select facts from f), '[{"title":"Revisa el portal","why":"Hay algo que mirar.","facts":["H9"]}]'),
  '23514', null, 'a recommendation citing an unknown fact is refused');
select throws_ok(format('select public.save_copilot_recommendations(%L, %L, %L, %L, %L, %L)', :'ta', :'req', :'from', :'to',
  (select facts from f), '[{"title":"Revisa el portal","why":"Hay algo que mirar.","facts":[]}]'),
  '23514', null, 'and one citing no fact');
select throws_ok(format('select public.save_copilot_recommendations(%L, %L, %L, %L, %L, %L)', :'ta', :'req', :'from', :'to',
  (select facts from f), '[]'), '23514', null, 'an empty set is refused');
select throws_ok(format('select public.save_copilot_recommendations(%L, %L, %L, %L, %L, %L)', :'ta', :'req', :'from', :'to',
  (select facts from f), (select jsonb_agg(x) from (select (items -> 0) x from f, generate_series(1, 7)) s)),
  '23514', null, 'and more than six');
select throws_ok(format('select public.save_copilot_recommendations(%L, %L, %L, %L, %L, %L)', :'ta', :'req', :'from', :'to',
  (select facts from f), '[{"title":"Mira esto","why":"Entra a https://ejemplo.bo","facts":["H5"]}]'),
  '23514', null, 'a link is refused');
select throws_ok(format('select public.save_copilot_recommendations(%L, %L, %L, %L, %L, %L)', :'ta', :'req', :'from', :'to',
  (select facts from f), jsonb_build_array(jsonb_build_object('title', E'Una\nlínea', 'why', 'Sin eventos.', 'facts', jsonb_build_array('H5')))),
  '23514', null, 'a line break is refused');
select throws_ok(format('select public.save_copilot_recommendations(%L, %L, %L, %L, %L, %L)', :'ta', :'req', :'from', :'to',
  (select facts || jsonb_build_array(facts -> 0) from f), (select items from f)),
  '23514', null, 'a repeated fact label is refused');
select throws_ok(format('select public.save_copilot_recommendations(%L, %L, %L, %L, %L, %L)', :'ta', :'req', :'from', :'to',
  (select jsonb_set(facts, '{1,target,contentId}', to_jsonb((select id from ids where name = 'ajeno'))) from f), (select items from f)),
  '23514', null, 'a fact pointing at content of another municipality is refused');
select throws_ok(format('select public.save_copilot_recommendations(%L, %L, %L, %L, %L, %L)', :'ta', :'req', :'from', :'to',
  (select jsonb_set(facts, '{1,target,contentId}', '"no-es-un-id"') from f), (select items from f)),
  '23514', null, 'a target whose id is not an id is refused as invalid (never a cast error)');
select throws_ok(format('select public.save_copilot_recommendations(%L, %L, %L, %L, %L, %L)', :'ta', :'req', :'from', :'to',
  (select jsonb_set(facts, '{1,target,kind}', '"event"') from f), (select items from f)),
  '23514', null, 'and one with the wrong kind');
select throws_ok(format('select public.save_copilot_recommendations(%L, %L, %L, %L, %L, %L)', :'ta', :'req', :'from', :'to',
  (select jsonb_set(facts, '{3,target,contentId}', to_jsonb((select id from ids where name = 'feria'))) from f), (select items from f)),
  '23514', null, 'a scene of a tour that is not of that content is refused');
select throws_ok(format('select public.save_copilot_recommendations(%L, %L, %L, %L, %L, %L)', :'ta', :'req', :'from', :'to',
  (select jsonb_set(facts, '{4,target}', '{"type":"publish"}') from f), (select items from f)),
  '23514', null, 'an unknown kind of target is refused');
select throws_ok(format('select public.save_copilot_recommendations(%L, %L, %L, %L, %L, %L)', :'ta', :'req', :'to', :'from',
  (select facts from f), (select items from f)), '22023', null, 'a period that ends before it starts is refused');
select throws_ok(format('select public.save_copilot_recommendations(%L, %L, %L, %L, %L, %L)', :'ta', :'req_owner', :'from', :'to',
  (select facts from f), (select items from f)), '23514', null, 'another person''s copilot request is refused');
select throws_ok(format('select public.save_copilot_recommendations(%L, %L, %L, %L, %L, %L)', :'ta', :'req_old', :'from', :'to',
  (select facts from f), (select items from f)), '23514', null, 'so is one of more than an hour ago');
select throws_ok(format('select public.save_copilot_recommendations(%L, %L, %L, %L, %L, %L)', :'ta', :'req_probe', :'from', :'to',
  (select facts from f), (select items from f)), '23514', null, 'and a request that is not of the Copilot');
select throws_ok(format('select public.save_copilot_recommendations(%L, %L, %L, %L, %L, %L)', :'ta', :'req_open', :'from', :'to',
  (select facts from f), (select items from f)), '23514', null, 'and one the model did not answer');

-- ── Only the latest is kept ────────────────────────────────────────────────
set local request.jwt.claims to :'ownera';
insert into ids select 'second', public.save_copilot_recommendations(:'ta', :'req_owner', :'from', :'to', (select facts from f),
  '[{"title":"Agrega eventos a la agenda","why":"La agenda no tiene eventos próximos publicados.","facts":["H5"]}]');
select is(public.latest_copilot_recommendations(:'ta') ->> 'id', (select id::text from ids where name = 'second'),
  'a new set replaces the previous one');
reset role;
select is((select count(*) from public.copilot_recommendations where tenant_id = :'ta')::int, 1, 'only the latest is kept');
select is(
  (select array_agg(action) from public.audit_events where tenant_id = :'ta' and action like 'copilot.%'),
  array['copilot.recommendations_generated', 'copilot.recommendations_generated'], 'each set is audited');
delete from public.ai_requests where id = :'req_owner';
select is((select count(*) from public.copilot_recommendations where tenant_id = :'ta')::int, 0,
  'they are forgotten with the AI request behind them');

select * from finish();
rollback;
