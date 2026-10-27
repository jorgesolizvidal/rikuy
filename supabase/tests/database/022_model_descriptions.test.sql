-- A description for 3D model points (P4 · Paso 6): the text alternative of the portal's 3D
-- viewer. Model points take text like information points (never photos); arrows and "go to
-- another tour" points still take none; a change to the text keeps everything else (RC-01);
-- the sealed manifest carries it to visitors.
begin;
set local client_min_messages to warning;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

\set ta 'aaaaaaaa-0000-4000-8000-000000000001'
\set a1c '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated"}'
\set a3c '{"sub":"00000000-0000-4000-8000-0000000000a3","role":"authenticated"}'
\set a4c '{"sub":"00000000-0000-4000-8000-0000000000a4","role":"authenticated"}'
\set sha '0000000000000000000000000000000000000000000000000000000000000abc'
\set pano '{"version":1,"projection":"equirectangular","source":{"width":4096,"height":2048,"bytes":9000,"mime":"image/jpeg","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"preview":{"file":"preview.webp","width":1024,"height":512,"bytes":18000},"image":{"file":"image.webp","width":4096,"height":2048,"bytes":1400000},"tiles":null}'
\set model '{"version":1,"format":"glb","source":{"bytes":482828,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","triangles":1200,"vertices":800,"materials":1,"textures":0,"generator":"test","extensions":[]},"model":{"file":"model.glb","bytes":250000,"triangles":1200,"geometry":"meshopt","textures":[]},"colors":{"materials":"unchanged","vertexColors":null,"suspects":[]},"weight":"light","poster":{"file":"poster.webp","width":1280,"height":960,"bytes":40000}}'
\set badlink '{"body":[{"type":"paragraph","children":[{"type":"link","href":"http://x.test","children":[{"type":"text","text":"x"}]}]}]}'
\set text '[{"type":"paragraph","children":[{"type":"text","text":"Horno de adobe con boca de arco."}]}]'

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000a1', 'owner.a@example.test'),
  ('00000000-0000-4000-8000-0000000000a3', 'editor.a@example.test'),
  ('00000000-0000-4000-8000-0000000000a4', 'analyst.a@example.test');
insert into public.tenants (id, slug, display_name, status, default_locale, timezone) values
  (:'ta', 'tenant-a', 'Tenant A', 'provisioning', 'es', 'America/La_Paz');
insert into public.memberships (tenant_id, user_id, role, status, accepted_at) values
  (:'ta', '00000000-0000-4000-8000-0000000000a1', 'owner', 'active', now()),
  (:'ta', '00000000-0000-4000-8000-0000000000a3', 'editor', 'active', now()),
  (:'ta', '00000000-0000-4000-8000-0000000000a4', 'analyst', 'active', now());
update public.tenants set status = 'active';
set constraints all immediate;

-- Two public panoramas, a public photo and a public model with its poster.
create temp table media (name text primary key, purpose public.asset_purpose, asset uuid default gen_random_uuid(), version_id uuid default gen_random_uuid());
insert into media (name, purpose) values ('p1', 'panorama'), ('p2', 'panorama'), ('img', 'content'), ('m', 'model');
insert into public.assets (id, tenant_id, purpose) select asset, :'ta', purpose from media;
insert into public.asset_versions (id, tenant_id, asset_id, version, status, declared_mime, declared_bytes, mime, bytes, width, height, sha256, ready_at, published_at, manifest)
select version_id, :'ta', asset, 1, 'ready',
       case when purpose = 'model' then 'model/gltf-binary' else 'image/jpeg' end, 1000,
       case when purpose = 'model' then 'model/gltf-binary' else 'image/jpeg' end, 1000,
       case when purpose <> 'model' then 4096 end, case when purpose <> 'model' then 2048 end,
       :'sha', now(), now(),
       case purpose when 'panorama' then :'pano'::jsonb when 'model' then :'model'::jsonb end
from media;
grant select on media to authenticated;
create temp table ids (name text primary key, id uuid);
grant select, insert on ids to authenticated;

set local role authenticated;
set local request.jwt.claims to :'a3c';
insert into ids select 'museo', content_id from public.create_content_item(:'ta', 'destination', 'museo', 'Museo');
insert into ids select 'plaza', content_id from public.create_content_item(:'ta', 'destination', 'plaza', 'Plaza');
insert into ids select 'tour', tour_id from public.create_tour(:'ta', (select id from ids where name = 'museo'));
insert into ids select 'sala', scene_id from public.add_tour_scene(:'ta', (select id from ids where name = 'tour'), 1, (select version_id from media where name = 'p1'), 'Sala');
insert into ids select 'patio', scene_id from public.add_tour_scene(:'ta', (select id from ids where name = 'tour'), 2, (select version_id from media where name = 'p2'), 'Patio');

create function pg_temp.edit() returns integer language sql as $$
  select edit_count from public.tour_revisions r join public.tours t on t.draft_revision_id = r.id
  where t.id = (select id from ids where name = 'tour')
$$;
create function pg_temp.hot(p_body jsonb) returns uuid language sql as $$
  select hotspot_id from public.add_tour_hotspot(
    'aaaaaaaa-0000-4000-8000-000000000001', (select id from ids where name = 'tour'), pg_temp.edit(),
    (select id from ids where name = 'sala'), p_body)
$$;
create function pg_temp.model_point(p_extra jsonb) returns jsonb language sql as $$
  select jsonb_build_object('kind', 'model', 'title', 'Horno de barro', 'position', '{"yaw":0.3,"pitch":-0.4}'::jsonb,
                            'modelVersionId', (select version_id from media where name = 'm')) || p_extra
$$;
grant execute on function pg_temp.edit() to authenticated;

select plan(11);

-- ── Adding ──────────────────────────────────────────────────────────────────
insert into ids values ('model', pg_temp.hot(pg_temp.model_point(jsonb_build_object('body', :'text'::jsonb))));
select is((select body from public.tour_hotspots where hotspot_id = (select id from ids where name = 'model')), :'text'::jsonb,
  'an editor adds a model point with its description');
insert into ids values ('bare', pg_temp.hot(pg_temp.model_point('{}'::jsonb)));
select is((select body from public.tour_hotspots where hotspot_id = (select id from ids where name = 'bare')), '[]'::jsonb,
  'the description is optional (model points published before keep working)');
select throws_ok(format('select pg_temp.hot(%L::jsonb)', pg_temp.model_point(jsonb_build_object('gallery', '[]'::jsonb))),
  '23514', null, 'a model point takes no photos');
select throws_ok(format('select pg_temp.hot(%L::jsonb)', pg_temp.model_point(:'badlink'::jsonb)),
  '23514', null, 'nor text outside the allowed format (a link without https)');
select throws_ok(format('select pg_temp.hot(%L::jsonb)', jsonb_build_object('kind', 'scene', 'title', 'Al patio',
  'position', '{"yaw":1,"pitch":0}'::jsonb, 'targetSceneId', (select id from ids where name = 'patio'), 'body', :'text'::jsonb)),
  '23514', null, 'an arrow still takes no text');

-- ── Changing only the text (RC-01) ──────────────────────────────────────────
create temp table before_change as
  select model_version_id, yaw, pitch, title from public.tour_hotspots where hotspot_id = (select id from ids where name = 'bare');
select lives_ok(format('select * from public.update_tour_hotspot(%L, %L, %s, %L, %L::jsonb)', :'ta',
  (select id from ids where name = 'tour'), pg_temp.edit(), (select id from ids where name = 'bare'),
  jsonb_build_object('body', :'text'::jsonb)), 'the description is added later');
select ok((select (h.model_version_id, h.yaw, h.pitch, h.title) = (b.model_version_id, b.yaw, b.pitch, b.title) and h.body = :'text'::jsonb
           from public.tour_hotspots h, before_change b where h.hotspot_id = (select id from ids where name = 'bare')),
  'and only the description changes: the model, the position and the name stay');
select throws_ok(format('select * from public.update_tour_hotspot(%L, %L, %s, %L, %L::jsonb)', :'ta',
  (select id from ids where name = 'tour'), pg_temp.edit(), (select id from ids where name = 'bare'), '{"gallery":[]}'),
  '23514', null, 'photos cannot be added to a model point either');

reset role;
set local role authenticated;
set local request.jwt.claims to :'a4c';
select throws_ok(format('select * from public.update_tour_hotspot(%L, %L, %s, %L, %L::jsonb)', :'ta',
  (select id from ids where name = 'tour'), pg_temp.edit(), (select id from ids where name = 'model'), '{"body":[]}'),
  '42501', null, 'an analyst cannot change it');

-- ── Visitors read it in the sealed manifest ─────────────────────────────────
reset role;
set local role authenticated;
set local request.jwt.claims to :'a1c';
select lives_ok(format('select * from public.publish_tour(%L, %L, %s)', :'ta', (select id from ids where name = 'tour'), pg_temp.edit()),
  'the owner publishes the tour');
select is((select h -> 'body' from public.tours t join public.tour_revisions r on r.id = t.published_revision_id,
                  jsonb_array_elements(r.manifest -> 'scenes') sc, jsonb_array_elements(sc -> 'hotspots') h
           where t.id = (select id from ids where name = 'tour') and h ->> 'hotspotId' = (select id::text from ids where name = 'model')),
  :'text'::jsonb, 'the published manifest carries the description');

select * from finish();
rollback;
