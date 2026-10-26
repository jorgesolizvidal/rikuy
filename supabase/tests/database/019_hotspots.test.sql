-- Hotspots (P4 · Paso 2): four kinds with exactly their own target, partial changes that
-- keep every relation they were not asked to change (RC-01), no foreign selections,
-- copies with stable ids in a new draft, and what publishing requires.
begin;
set local client_min_messages to warning;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

\set ta 'aaaaaaaa-0000-4000-8000-000000000001'
\set tb 'bbbbbbbb-0000-4000-8000-000000000001'
\set a1c '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated"}'
\set a3c '{"sub":"00000000-0000-4000-8000-0000000000a3","role":"authenticated"}'
\set a4c '{"sub":"00000000-0000-4000-8000-0000000000a4","role":"authenticated"}'
\set b1c '{"sub":"00000000-0000-4000-8000-0000000000b1","role":"authenticated"}'
\set sha '0000000000000000000000000000000000000000000000000000000000000abc'
\set pano '{"version":1,"projection":"equirectangular","source":{"width":8192,"height":4096,"bytes":9000000,"mime":"image/jpeg","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"preview":{"file":"preview.webp","width":1024,"height":512,"bytes":18000},"image":{"file":"image.webp","width":4096,"height":2048,"bytes":1400000},"tiles":null}'
\set model '{"version":1,"format":"glb","source":{"bytes":482828,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","triangles":15177,"vertices":4612,"materials":4,"textures":11,"generator":"Blender","extensions":[]},"model":{"file":"model.glb","bytes":1250000,"triangles":15177,"geometry":"meshopt","textures":[]},"colors":{"materials":"unchanged","vertexColors":null,"suspects":[]},"weight":"light","poster":null}'

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000a1', 'owner.a@example.test'),
  ('00000000-0000-4000-8000-0000000000a3', 'editor.a@example.test'),
  ('00000000-0000-4000-8000-0000000000a4', 'analyst.a@example.test'),
  ('00000000-0000-4000-8000-0000000000b1', 'owner.b@example.test');
insert into public.tenants (id, slug, display_name, status, default_locale, timezone) values
  (:'ta', 'tenant-a', 'Tenant A', 'provisioning', 'es', 'America/La_Paz'),
  (:'tb', 'tenant-b', 'Tenant B', 'provisioning', 'es', 'America/La_Paz');
insert into public.memberships (tenant_id, user_id, role, status, accepted_at) values
  (:'ta', '00000000-0000-4000-8000-0000000000a1', 'owner', 'active', now()),
  (:'ta', '00000000-0000-4000-8000-0000000000a3', 'editor', 'active', now()),
  (:'ta', '00000000-0000-4000-8000-0000000000a4', 'analyst', 'active', now()),
  (:'tb', '00000000-0000-4000-8000-0000000000b1', 'owner', 'active', now());
update public.tenants set status = 'active';
set constraints all immediate;

-- Media: panoramas p1..p3 of A, a photo (img) and a model (m) of A, a model still
-- processing (mp), and B's photo (imgb) and model (mb).
create temp table media (name text primary key, tenant uuid, purpose public.asset_purpose, status public.asset_version_status, asset uuid default gen_random_uuid(), version_id uuid default gen_random_uuid());
insert into media (name, tenant, purpose, status) values
  ('p1', :'ta', 'panorama', 'ready'), ('p2', :'ta', 'panorama', 'ready'), ('p3', :'ta', 'panorama', 'ready'),
  ('img', :'ta', 'content', 'ready'), ('m', :'ta', 'model', 'ready'), ('mp', :'ta', 'model', 'processing'),
  ('imgb', :'tb', 'content', 'ready'), ('mb', :'tb', 'model', 'ready');
insert into public.assets (id, tenant_id, purpose) select asset, tenant, purpose from media;
insert into public.asset_versions (id, tenant_id, asset_id, version, status, declared_mime, declared_bytes, mime, bytes, width, height, sha256, ready_at, manifest)
select version_id, tenant, asset, 1, status,
       case when purpose = 'model' then 'model/gltf-binary' else 'image/jpeg' end, 1000,
       case when status = 'ready' then case when purpose = 'model' then 'model/gltf-binary' else 'image/jpeg' end end,
       case when status = 'ready' then 1000 end,
       case when status = 'ready' and purpose <> 'model' then 2048 end,
       case when status = 'ready' and purpose <> 'model' then 1024 end,
       case when status = 'ready' then :'sha' end,
       case when status = 'ready' then now() end,
       case when status <> 'ready' then null when purpose = 'panorama' then :'pano'::jsonb when purpose = 'model' then :'model'::jsonb end
from media;
-- Ready media counts as public here: publishing it is the server's job (020_tour_publication).
update public.asset_versions set published_at = now() where status = 'ready';
grant select on media to authenticated;
create temp table ids (name text primary key, id uuid);
grant select, insert on ids to authenticated;
create temp table s (name text primary key, id uuid);
grant select, insert on s to authenticated;

-- A has a museum (with a tour of three scenes) and a plaza; B has a viewpoint.
set local role authenticated;
set local request.jwt.claims to :'a1c';
insert into ids select 'museo', content_id from public.create_content_item(:'ta', 'destination', 'museo', 'Museo');
insert into ids select 'plaza', content_id from public.create_content_item(:'ta', 'destination', 'plaza', 'Plaza');
insert into ids select 'tour', tour_id from public.create_tour(:'ta', (select id from ids where name = 'museo'));
insert into ids select 'ptour', tour_id from public.create_tour(:'ta', (select id from ids where name = 'plaza'));
set local request.jwt.claims to :'b1c';
insert into ids select 'mirador', content_id from public.create_content_item(:'tb', 'destination', 'mirador', 'Mirador');
set local request.jwt.claims to :'a3c';
insert into s select 'entrada', scene_id from public.add_tour_scene(:'ta', (select id from ids where name = 'tour'), 1, (select version_id from media where name = 'p1'), 'Entrada');
insert into s select 'sala', scene_id from public.add_tour_scene(:'ta', (select id from ids where name = 'tour'), 2, (select version_id from media where name = 'p2'), 'Sala');
insert into s select 'patio', scene_id from public.add_tour_scene(:'ta', (select id from ids where name = 'tour'), 3, (select version_id from media where name = 'p3'), 'Patio');
insert into s select 'otra', scene_id from public.add_tour_scene(:'ta', (select id from ids where name = 'ptour'), 1, (select version_id from media where name = 'p1'), 'Plaza');

create function pg_temp.hot(p_edit integer, p_scene text, p_body jsonb) returns uuid language sql as $$
  select hotspot_id from public.add_tour_hotspot(
    'aaaaaaaa-0000-4000-8000-000000000001', (select id from ids where name = 'tour'), p_edit,
    (select id from s where name = p_scene), p_body)
$$;
create function pg_temp.edit() returns integer language sql as $$
  select edit_count from public.tour_revisions r join public.tours t on t.draft_revision_id = r.id
  where t.id = (select id from ids where name = 'tour')
$$;

select plan(43);

-- ── Structure ───────────────────────────────────────────────────────────────
select ok((select bool_and(relrowsecurity) from pg_class where oid in ('public.tour_hotspots'::regclass, 'public.tour_hotspot_images'::regclass)), 'hotspots and their photos have RLS');
select ok(not has_table_privilege('authenticated', 'public.tour_hotspots', 'insert'), 'no direct writes');
select ok(not has_function_privilege('anon', 'public.add_tour_hotspot(uuid, uuid, integer, uuid, jsonb)', 'execute'), 'visitors cannot add points');

-- ── The four kinds ──────────────────────────────────────────────────────────
insert into ids values ('info', pg_temp.hot(pg_temp.edit(), 'entrada', jsonb_build_object(
  'kind', 'info', 'title', 'Arado de madera', 'position', '{"yaw":0.5,"pitch":-0.2}'::jsonb,
  'body', '[{"type":"paragraph","children":[{"type":"text","text":"Usado hasta 1953."}]}]'::jsonb,
  'gallery', jsonb_build_array(jsonb_build_object('assetId', (select asset from media where name = 'img'), 'version', 1, 'alt', 'El arado de cerca'))
)));
select ok((select id from ids where name = 'info') is not null, 'an editor adds an information point with text and a photo');
insert into ids values ('arrow', pg_temp.hot(pg_temp.edit(), 'entrada', jsonb_build_object(
  'kind', 'scene', 'title', 'A la sala', 'position', '{"yaw":-1.2,"pitch":0}'::jsonb, 'targetSceneId', (select id from s where name = 'sala'))));
insert into ids values ('back', pg_temp.hot(pg_temp.edit(), 'patio', jsonb_build_object(
  'kind', 'scene', 'title', 'Volver a la entrada', 'position', '{"yaw":3,"pitch":0}'::jsonb, 'targetSceneId', (select id from s where name = 'entrada'))));
insert into ids values ('model', pg_temp.hot(pg_temp.edit(), 'sala', jsonb_build_object(
  'kind', 'model', 'title', 'Horno de barro', 'position', '{"yaw":0,"pitch":-0.4}'::jsonb, 'modelVersionId', (select version_id from media where name = 'm'))));
insert into ids values ('jump', pg_temp.hot(pg_temp.edit(), 'entrada', jsonb_build_object(
  'kind', 'tour', 'title', 'Ir a la plaza', 'position', '{"yaw":2,"pitch":0.1}'::jsonb, 'targetContentId', (select id from ids where name = 'plaza'))));
select is((select array_agg(kind::text order by kind) from public.tour_hotspots), array['info', 'scene', 'scene', 'model', 'tour'], 'navigation, model and "go to another tour" points too');

-- ── Refusals: wrong or foreign targets ──────────────────────────────────────
select throws_ok(format('select pg_temp.hot(%s, %L, %L)', pg_temp.edit(), 'entrada', jsonb_build_object('kind', 'scene', 'title', 'Aquí', 'position', '{"yaw":0,"pitch":0}'::jsonb, 'targetSceneId', (select id from s where name = 'entrada'))),
  '23514', null, 'an arrow cannot lead to its own scene');
select throws_ok(format('select pg_temp.hot(%s, %L, %L)', pg_temp.edit(), 'entrada', jsonb_build_object('kind', 'scene', 'title', 'Fuera', 'position', '{"yaw":0,"pitch":0}'::jsonb, 'targetSceneId', (select id from s where name = 'otra'))),
  '23514', null, 'nor to a scene of another tour');
select throws_ok(format('select pg_temp.hot(%s, %L, %L)', pg_temp.edit(), 'sala', jsonb_build_object('kind', 'model', 'title', 'X', 'position', '{"yaw":0,"pitch":0}'::jsonb, 'modelVersionId', (select version_id from media where name = 'mp'))),
  '23514', null, 'a model still processing is refused');
select throws_ok(format('select pg_temp.hot(%s, %L, %L)', pg_temp.edit(), 'sala', jsonb_build_object('kind', 'model', 'title', 'X', 'position', '{"yaw":0,"pitch":0}'::jsonb, 'modelVersionId', (select version_id from media where name = 'mb'))),
  '23514', null, 'another municipality''s model is refused');
select throws_ok(format('select pg_temp.hot(%s, %L, %L)', pg_temp.edit(), 'sala', jsonb_build_object('kind', 'model', 'title', 'X', 'position', '{"yaw":0,"pitch":0}'::jsonb, 'modelVersionId', (select version_id from media where name = 'p2'))),
  '23514', null, 'a panorama is not a model');
select throws_ok(format('select pg_temp.hot(%s, %L, %L)', pg_temp.edit(), 'sala', jsonb_build_object('kind', 'tour', 'title', 'X', 'position', '{"yaw":0,"pitch":0}'::jsonb, 'targetContentId', (select id from ids where name = 'mirador'))),
  '23514', null, '"go to another tour" cannot point at another municipality');
select throws_ok(format('select pg_temp.hot(%s, %L, %L)', pg_temp.edit(), 'sala', jsonb_build_object('kind', 'tour', 'title', 'X', 'position', '{"yaw":0,"pitch":0}'::jsonb, 'targetContentId', (select id from ids where name = 'museo'))),
  '23514', null, 'nor at its own destination');
select throws_ok(format('select pg_temp.hot(%s, %L, %L)', pg_temp.edit(), 'sala', jsonb_build_object('kind', 'info', 'title', 'X', 'position', '{"yaw":0,"pitch":0}'::jsonb, 'gallery', jsonb_build_array(jsonb_build_object('assetId', (select asset from media where name = 'imgb'), 'version', 1, 'alt', 'Ajena')))),
  '23514', null, 'a photo of another municipality is refused');
select throws_ok(format('select pg_temp.hot(%s, %L, %L)', pg_temp.edit(), 'sala', jsonb_build_object('kind', 'info', 'title', 'X', 'position', '{"yaw":0,"pitch":0}'::jsonb, 'body', '[{"type":"script","children":[]}]'::jsonb)),
  '23514', null, 'text outside the allowed rich text is refused');
select throws_ok(format('select pg_temp.hot(%s, %L, %L)', pg_temp.edit(), 'sala', jsonb_build_object('kind', 'scene', 'title', 'X', 'position', '{"yaw":0,"pitch":0}'::jsonb, 'targetSceneId', (select id from s where name = 'patio'), 'body', '[]'::jsonb)),
  '23514', null, 'only information points carry text');
select throws_ok(format('select pg_temp.hot(%s, %L, %L)', pg_temp.edit(), 'sala', jsonb_build_object('kind', 'info', 'title', 'X', 'position', '{"yaw":3.5,"pitch":0}'::jsonb)),
  '23514', null, 'a position outside [-π, π) is refused');
select throws_ok(format('select pg_temp.hot(%s, %L, %L)', pg_temp.edit() - 1, 'sala', '{"kind":"info","title":"Vieja","position":{"yaw":0,"pitch":0}}'),
  'PT409', null, 'an old edit number is refused');
set local request.jwt.claims to :'a4c';
select throws_ok(format('select pg_temp.hot(%s, %L, %L)', 1, 'sala', '{"kind":"info","title":"X","position":{"yaw":0,"pitch":0}}'),
  '42501', null, 'an analyst cannot add points');
set local request.jwt.claims to :'b1c';
select throws_ok(format('select * from public.update_tour_hotspot(%L, %L, 1, %L, %L)', :'ta', (select id from ids where name = 'tour'), (select id from ids where name = 'info'), '{"title":"X"}'),
  '42501', null, 'the owner of B cannot change A''s points');
select is((select count(*)::integer from public.tour_hotspots), 0, 'B sees no point of A');

-- ── RC-01: a change keeps what it was not asked to change ──────────────────
set local request.jwt.claims to :'a3c';
create temp table before_title as select h.*, (select array_agg(alt_text order by position) from public.tour_hotspot_images i where i.hotspot_id = h.hotspot_id) as alts from public.tour_hotspots h;
select lives_ok(format('select * from public.update_tour_hotspot(%L, %L, %s, %L, %L)', :'ta', (select id from ids where name = 'tour'), pg_temp.edit(), (select id from ids where name = 'info'), '{"title":"Arado de madera tallada"}'),
  'the title alone is saved');
select is((select row(h.scene_id, h.kind, h.yaw, h.pitch, h.body, (select array_agg(alt_text order by position) from public.tour_hotspot_images i where i.hotspot_id = h.hotspot_id))::text from public.tour_hotspots h where h.hotspot_id = (select id from ids where name = 'info')),
  (select row(b.scene_id, b.kind, b.yaw, b.pitch, b.body, b.alts)::text from before_title b where b.hotspot_id = (select id from ids where name = 'info')),
  'scene, kind, position, text and photos are kept');
select lives_ok(format('select * from public.update_tour_hotspot(%L, %L, %s, %L, %L)', :'ta', (select id from ids where name = 'tour'), pg_temp.edit(), (select id from ids where name = 'model'), '{"position":{"yaw":0.25,"pitch":-0.5}}'),
  'moving a model point');
select is((select model_version_id from public.tour_hotspots where hotspot_id = (select id from ids where name = 'model')), (select version_id from media where name = 'm'),
  'keeps its model');
select lives_ok(format('select * from public.update_tour_hotspot(%L, %L, %s, %L, %L)', :'ta', (select id from ids where name = 'tour'), pg_temp.edit(), (select id from ids where name = 'arrow'), jsonb_build_object('targetSceneId', (select id from s where name = 'patio'))),
  'an arrow can point at another scene');
select throws_ok(format('select * from public.update_tour_hotspot(%L, %L, %s, %L, %L)', :'ta', (select id from ids where name = 'tour'), pg_temp.edit(), (select id from ids where name = 'arrow'), '{"kind":"info"}'),
  '23514', null, 'the kind never changes');
select throws_ok(format('select * from public.update_tour_hotspot(%L, %L, %s, %L, %L)', :'ta', (select id from ids where name = 'tour'), pg_temp.edit(), (select id from ids where name = 'arrow'), jsonb_build_object('modelVersionId', (select version_id from media where name = 'm'))),
  '23514', null, 'an arrow cannot take a model');
select lives_ok(format('select * from public.update_tour_hotspot(%L, %L, %s, %L, %L)', :'ta', (select id from ids where name = 'tour'), pg_temp.edit(), (select id from ids where name = 'info'), '{"gallery":[]}'),
  'the photos can be removed explicitly');
select is((select count(*)::integer from public.tour_hotspot_images), 0, 'and only then are they gone');

-- ── What a point can lead to ────────────────────────────────────────────────
select is((select array_agg(title || ':' || tour_published) from public.tour_hotspot_targets(:'ta', (select id from ids where name = 'tour'))),
  array['Plaza:false'], 'targets: the other destinations of A, never its own, with whether they have a published tour');

-- ── Publishing ──────────────────────────────────────────────────────────────
set local request.jwt.claims to :'a1c';
select throws_ok(format('select * from public.publish_tour(%L, %L, %s)', :'ta', (select id from ids where name = 'tour'), pg_temp.edit()),
  'PT409', 'a 3D model has no poster yet', 'a model without poster blocks publishing');
reset role;
update public.asset_versions set manifest = jsonb_set(manifest, '{poster}', '{"file":"poster.webp","width":1280,"height":960,"bytes":90000}')
where id = (select version_id from media where name = 'm');
set local role authenticated;
set local request.jwt.claims to :'a1c';
create temp table pub as select * from public.publish_tour(:'ta', (select id from ids where name = 'tour'), pg_temp.edit());
select is((select revision_no from pub), 1, 'with its poster, the tour publishes (a "go to" without a published target does not block)');
reset role;
select throws_ok(format('update public.tour_hotspots set title = %L where tour_revision_id = %L', 'X', (select revision_id from pub)),
  '23514', null, 'points of a sealed revision are immutable');
set local role authenticated;

-- ── A new draft keeps the points with their ids ────────────────────────────
set local request.jwt.claims to :'a3c';
create temp table draft as select * from public.update_tour_hotspot(:'ta', (select id from ids where name = 'tour'), null, (select id from ids where name = 'jump'), '{"title":"Ir a la plaza principal"}');
select is((select array_agg(hotspot_id order by hotspot_id) from public.tour_hotspots where tour_revision_id = (select revision_id from draft)),
  (select array_agg(hotspot_id order by hotspot_id) from public.tour_hotspots where tour_revision_id = (select revision_id from pub)),
  'editing after publishing copies every point with the same id');
select is((select title from public.tour_hotspots where tour_revision_id = (select revision_id from pub) and hotspot_id = (select id from ids where name = 'jump')),
  'Ir a la plaza', 'the published point is untouched');

-- Removing a scene removes its points and the arrows that led to it.
select lives_ok(format('select * from public.remove_tour_scene(%L, %L, %s, %L)', :'ta', (select id from ids where name = 'tour'), pg_temp.edit(), (select id from s where name = 'entrada')),
  'the entry scene is removed');
select is((select array_agg(title order by title) from public.tour_hotspots where tour_revision_id = (select revision_id from draft)),
  array['Horno de barro'], 'its points and the arrow back to it are gone; the others stay');
select lives_ok(format('select * from public.remove_tour_hotspot(%L, %L, %s, %L)', :'ta', (select id from ids where name = 'tour'), pg_temp.edit(), (select id from ids where name = 'model')),
  'a point is removed');
select throws_ok(format('select * from public.remove_tour_hotspot(%L, %L, %s, %L)', :'ta', (select id from ids where name = 'tour'), pg_temp.edit(), (select id from ids where name = 'model')),
  'PT404', null, 'removing it twice says it is not there');

-- The document the editor reads.
select is((select jsonb_array_length(d -> 'scenes' -> 0 -> 'hotspots') from (select public.tour_editor(:'ta', (select id from ids where name = 'tour')) -> 'published' as d) x),
  3, 'the published document lists the entry scene''s points');
select is((select h -> 'target' ->> 'title' from (select public.tour_editor(:'ta', (select id from ids where name = 'tour')) -> 'published' as d) x,
           jsonb_array_elements(d -> 'scenes' -> 0 -> 'hotspots') h where h ->> 'kind' = 'tour'),
  'Plaza', 'with the destination a "go to" leads to');

-- Rolling back keeps the points of the revision.
set local request.jwt.claims to :'a1c';
create temp table pub2 as select * from public.publish_tour(:'ta', (select id from ids where name = 'tour'), pg_temp.edit());
select lives_ok(format('select * from public.restore_tour_revision(%L, %L, %L)', :'ta', (select id from ids where name = 'tour'), (select revision_id from pub)),
  'back to version 1');
select is((select count(*)::integer from public.tour_hotspots h join public.tours t on t.published_revision_id = h.tour_revision_id where t.id = (select id from ids where name = 'tour')),
  5, 'version 1 comes back with its five points');

select * from finish();
rollback;
