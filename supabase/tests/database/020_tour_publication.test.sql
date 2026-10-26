-- Tour publication (P4 · Paso 3): media must be public before sealing, the sealed revision
-- keeps an immutable public manifest, and visitors read only published tours of published
-- content of active municipalities, with "go to another tour" resolved when reading.
begin;
set local client_min_messages to warning;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

\set ta 'aaaaaaaa-0000-4000-8000-000000000001'
\set tb 'bbbbbbbb-0000-4000-8000-000000000001'
\set a1c '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated"}'
\set b1c '{"sub":"00000000-0000-4000-8000-0000000000b1","role":"authenticated"}'
\set sha '0000000000000000000000000000000000000000000000000000000000000abc'
\set pano '{"version":1,"projection":"equirectangular","source":{"width":8192,"height":4096,"bytes":9000000,"mime":"image/jpeg","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"preview":{"file":"preview.webp","width":1024,"height":512,"bytes":18000},"image":{"file":"image.webp","width":4096,"height":2048,"bytes":1400000},"tiles":{"tileSize":512,"format":"webp","levels":[{"width":8192,"height":4096,"cols":16,"rows":8,"dir":"tiles/0"}]}}'
\set model '{"version":1,"format":"glb","source":{"bytes":482828,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","triangles":15177,"vertices":4612,"materials":4,"textures":11,"generator":"Blender","extensions":[]},"model":{"file":"model.glb","bytes":1250000,"triangles":15177,"geometry":"meshopt","textures":[]},"colors":{"materials":"unchanged","vertexColors":null,"suspects":[]},"weight":"light","poster":{"file":"poster.webp","width":1280,"height":960,"bytes":90000}}'
\set place '{"title":"%s","summary":"Un lugar","body":[],"location":{"lat":-17.39,"lng":-66.15},"cover":null,"gallery":[]}'

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000a1', 'owner.a@example.test'),
  ('00000000-0000-4000-8000-0000000000b1', 'owner.b@example.test');
insert into public.tenants (id, slug, display_name, status, default_locale, timezone) values
  (:'ta', 'tenant-a', 'Tenant A', 'provisioning', 'es', 'America/La_Paz'),
  (:'tb', 'tenant-b', 'Tenant B', 'provisioning', 'es', 'America/La_Paz');
insert into public.memberships (tenant_id, user_id, role, status, accepted_at) values
  (:'ta', '00000000-0000-4000-8000-0000000000a1', 'owner', 'active', now()),
  (:'tb', '00000000-0000-4000-8000-0000000000b1', 'owner', 'active', now());
update public.tenants set status = 'active';
set constraints all immediate;

create temp table media (name text primary key, tenant uuid, purpose public.asset_purpose, asset uuid default gen_random_uuid(), version_id uuid default gen_random_uuid());
insert into media (name, tenant, purpose) values
  ('p1', :'ta', 'panorama'), ('p2', :'ta', 'panorama'), ('p3', :'ta', 'panorama'),
  ('img', :'ta', 'content'), ('m', :'ta', 'model');
insert into public.assets (id, tenant_id, purpose) select asset, tenant, purpose from media;
insert into public.asset_versions (id, tenant_id, asset_id, version, status, declared_mime, declared_bytes, mime, bytes, width, height, sha256, ready_at, manifest)
select version_id, tenant, asset, 1, 'ready',
       case when purpose = 'model' then 'model/gltf-binary' else 'image/jpeg' end, 1000,
       case when purpose = 'model' then 'model/gltf-binary' else 'image/jpeg' end, 1000,
       case when purpose = 'model' then null when purpose = 'panorama' then 8192 else 2048 end,
       case when purpose = 'model' then null when purpose = 'panorama' then 4096 else 1024 end,
       :'sha', now(),
       case purpose when 'panorama' then :'pano'::jsonb when 'model' then :'model'::jsonb end
from media;
grant select on media to authenticated, anon;
create temp table ids (name text primary key, id uuid);
grant select, insert on ids to authenticated;
grant select on ids to anon;

set local role authenticated;
set local request.jwt.claims to :'a1c';
insert into ids select 'museo', content_id from public.create_content_item(:'ta', 'destination', 'museo', 'Museo');
insert into ids select 'plaza', content_id from public.create_content_item(:'ta', 'destination', 'plaza', 'Plaza');
insert into ids select 'feria', content_id from public.create_content_item(:'ta', 'event', 'feria', 'Feria');
insert into ids select 'tour', tour_id from public.create_tour(:'ta', (select id from ids where name = 'museo'));
insert into ids select 'ptour', tour_id from public.create_tour(:'ta', (select id from ids where name = 'plaza'));
insert into ids select 'ftour', tour_id from public.create_tour(:'ta', (select id from ids where name = 'feria'));
insert into ids select 'sala', scene_id from public.add_tour_scene(:'ta', (select id from ids where name = 'tour'), 1, (select version_id from media where name = 'p1'), 'Sala');
insert into ids select 'patio', scene_id from public.add_tour_scene(:'ta', (select id from ids where name = 'tour'), 2, (select version_id from media where name = 'p2'), 'Patio');
insert into ids select 'pscene', scene_id from public.add_tour_scene(:'ta', (select id from ids where name = 'ptour'), 1, (select version_id from media where name = 'p3'), 'Plaza');
insert into ids select 'fscene', scene_id from public.add_tour_scene(:'ta', (select id from ids where name = 'ftour'), 1, (select version_id from media where name = 'p3'), 'Feria');
select * from public.add_tour_hotspot(:'ta', (select id from ids where name = 'tour'), 3, (select id from ids where name = 'sala'), jsonb_build_object(
  'kind', 'info', 'title', 'Arado', 'position', '{"yaw":0.5,"pitch":0}'::jsonb,
  'gallery', jsonb_build_array(jsonb_build_object('assetId', (select asset from media where name = 'img'), 'version', 1, 'alt', 'El arado'))));
select * from public.add_tour_hotspot(:'ta', (select id from ids where name = 'tour'), 4, (select id from ids where name = 'sala'), jsonb_build_object(
  'kind', 'model', 'title', 'Horno', 'position', '{"yaw":1,"pitch":-0.3}'::jsonb, 'modelVersionId', (select version_id from media where name = 'm')));
select * from public.add_tour_hotspot(:'ta', (select id from ids where name = 'tour'), 5, (select id from ids where name = 'sala'), jsonb_build_object(
  'kind', 'tour', 'title', 'Ir a la plaza', 'position', '{"yaw":2,"pitch":0}'::jsonb, 'targetContentId', (select id from ids where name = 'plaza')));
select * from public.add_tour_hotspot(:'ta', (select id from ids where name = 'tour'), 6, (select id from ids where name = 'sala'), jsonb_build_object(
  'kind', 'scene', 'title', 'Al patio', 'position', '{"yaw":-1,"pitch":0}'::jsonb, 'targetSceneId', (select id from ids where name = 'patio')));

create function pg_temp.publish_media(p_names text[]) returns void language sql as $$
  update public.asset_versions set published_at = now() where id in (select version_id from media where name = any(p_names))
$$;

select plan(30);

-- ── The public bucket serves models too ─────────────────────────────────────
select is((select file_size_limit from storage.buckets where id = 'media-public'), 15728640::bigint, 'public files up to 15 MB (optimized models)');
select ok((select 'model/gltf-binary' = any(allowed_mime_types) from storage.buckets where id = 'media-public'), 'the public bucket accepts GLB');

-- ── Media must be public before sealing ────────────────────────────────────
select is((select (public.tour_editor(:'ta', (select id from ids where name = 'tour')) #>> '{draft,scenes,0,panorama,published}')), 'false',
  'the editor knows a panorama is not public yet');
select throws_ok(format('select * from public.publish_tour(%L, %L, 7)', :'ta', (select id from ids where name = 'tour')),
  'PT409', 'a panorama, photo or model is not public yet', 'ready is not enough: the panoramas must be public');
reset role;
select pg_temp.publish_media(array['p1', 'p2', 'img']);
set local role authenticated;
set local request.jwt.claims to :'a1c';
select throws_ok(format('select * from public.publish_tour(%L, %L, 7)', :'ta', (select id from ids where name = 'tour')),
  'PT409', 'a panorama, photo or model is not public yet', 'and the model too');
reset role;
select pg_temp.publish_media(array['m', 'p3']);
set local role authenticated;
set local request.jwt.claims to :'a1c';
create temp table pub as select * from public.publish_tour(:'ta', (select id from ids where name = 'tour'), 7);
select is((select revision_no from pub), 1, 'with everything public, the tour publishes');

-- ── The sealed manifest ─────────────────────────────────────────────────────
reset role;
create temp table m1 as select manifest from public.tour_revisions where id = (select revision_id from pub);
select is((select manifest ->> 'entrySceneId' from m1), (select id from ids where name = 'sala')::text, 'the manifest names the entry scene');
select is((select manifest #>> '{scenes,0,panorama,folder}' from m1),
  :'ta' || '/' || (select asset from media where name = 'p1') || '/1/panorama/', 'each panorama with its public folder');
select is((select manifest #>> '{scenes,0,panorama,tiles,levels,0,cols}' from m1), '16', 'and its tiles');
select is((select jsonb_array_length(manifest #> '{scenes,0,hotspots}') from m1), 4, 'the scene''s points');
select is((select h #>> '{model,folder}' || (h #>> '{model,file}') from m1, jsonb_array_elements(manifest #> '{scenes,0,hotspots}') h where h ->> 'kind' = 'model'),
  :'ta' || '/' || (select asset from media where name = 'm') || '/1/model/model.glb', 'a model point with its public file and poster');
select is((select h #>> '{gallery,0,width}' from m1, jsonb_array_elements(manifest #> '{scenes,0,hotspots}') h where h ->> 'kind' = 'info'),
  '2048', 'photos with their size (to reserve their space)');
select ok((select not (manifest::text ~ 'editCount|sealedBy|manifest"|declared') from m1), 'nothing of the editor in it');
select throws_ok(format('update public.tour_revisions set manifest = %L where id = %L', '{}', (select revision_id from pub)),
  '23514', null, 'a sealed manifest is immutable');
select throws_ok(format('update public.tour_revisions set manifest = null where id = %L', (select revision_id from pub)),
  '23514', null, 'and cannot be removed');

-- ── Visitors: only published tours of published content ────────────────────
set local role anon;
select is((select count(*)::integer from public.portal_tour(:'ta', 'destination', 'museo')), 0, 'the museum is not published: its tour is not visible');
reset role;
set local role authenticated;
set local request.jwt.claims to :'a1c';
select * from public.save_content_draft(:'ta', (select id from ids where name = 'museo'), format(:'place', 'Museo')::jsonb, 1);
select * from public.publish_content(:'ta', (select id from ids where name = 'museo'), 2);
set local role anon;
select is((select revision_no from public.portal_tour(:'ta', 'destination', 'museo')), 1, 'once the museum is published, visitors read its tour');
select is((select targets from public.portal_tour(:'ta', 'destination', 'museo')), '{}'::jsonb,
  '"go to the plaza" resolves to nothing while the plaza has no visible tour');
select is((select count(*)::integer from public.portal_tour(:'tb', 'destination', 'museo')), 0, 'not under another municipality');
select is((select count(*)::integer from public.portal_tour(:'ta', 'event', 'museo')), 0, 'nor with another kind');

-- The plaza: published content and published tour → the point resolves.
reset role;
set local role authenticated;
set local request.jwt.claims to :'a1c';
select * from public.save_content_draft(:'ta', (select id from ids where name = 'plaza'), format(:'place', 'Plaza')::jsonb, 1);
select * from public.publish_content(:'ta', (select id from ids where name = 'plaza'), 2);
select * from public.publish_tour(:'ta', (select id from ids where name = 'ptour'), 2);
set local role anon;
select is((select targets -> (select id from ids where name = 'plaza')::text from public.portal_tour(:'ta', 'destination', 'museo')),
  '{"kind": "destination", "slug": "plaza", "title": "Plaza"}'::jsonb, 'with the plaza''s tour published, "go to" resolves to it');

-- Draft changes never reach visitors.
reset role;
set local role authenticated;
set local request.jwt.claims to :'a1c';
select * from public.update_tour_scene(:'ta', (select id from ids where name = 'tour'), null, (select id from ids where name = 'sala'), '{"title":"Sala nueva"}');
set local role anon;
select is((select manifest #>> '{scenes,0,title}' from public.portal_tour(:'ta', 'destination', 'museo')), 'Sala', 'a draft does not change what visitors see');

-- ── The general tour's index ────────────────────────────────────────────────
reset role;
set local role authenticated;
set local request.jwt.claims to :'a1c';
select * from public.save_content_draft(:'ta', (select id from ids where name = 'feria'), jsonb_build_object(
  'title', 'Feria', 'summary', 'Ya pasó', 'body', '[]'::jsonb, 'location', '{"lat":-17.39,"lng":-66.15}'::jsonb,
  'cover', null, 'gallery', '[]'::jsonb, 'venueId', null,
  'schedule', jsonb_build_object('allDay', true, 'start', to_char(now() - interval '10 days', 'YYYY-MM-DD'), 'end', to_char(now() - interval '9 days', 'YYYY-MM-DD'))), 1);
select * from public.publish_content(:'ta', (select id from ids where name = 'feria'), 2);
select * from public.publish_tour(:'ta', (select id from ids where name = 'ftour'), 2);
set local role anon;
select is((select array_agg(kind || ':' || slug order by slug) from public.portal_tour_index(:'ta')), array['destination:museo', 'destination:plaza'],
  'the index lists the visible tours; an event that ended is not in it');
select is((select count(*)::integer from public.portal_tour(:'ta', 'event', 'feria')), 1, 'but its tour page stays, like the event''s page');
select is((select row(scenes, entry_title, entry_folder, entry_preview ->> 'file')::text from public.portal_tour_index(:'ta') where slug = 'museo'),
  row(2, 'Sala', :'ta' || '/' || (select asset from media where name = 'p1') || '/1/panorama/', 'preview.webp')::text,
  'with the entry scene''s preview, so only the chosen tour is downloaded');
select is((select count(*)::integer from public.portal_tour_index(:'tb')), 0, 'another municipality''s index is empty');

-- Suspended: nothing.
reset role;
update public.tenants set status = 'suspended' where id = :'ta';
set local role anon;
select is((select count(*)::integer from public.portal_tour_index(:'ta')) + (select count(*)::integer from public.portal_tour(:'ta', 'destination', 'museo')), 0,
  'a suspended municipality shows no tours');
reset role;
update public.tenants set status = 'active' where id = :'ta';

-- ── Rolling back serves the old manifest ────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to :'a1c';
select * from public.publish_tour(:'ta', (select id from ids where name = 'tour'), (select edit_count from public.tour_revisions r join public.tours t on t.draft_revision_id = r.id where t.id = (select id from ids where name = 'tour')));
set local role anon;
select is((select manifest #>> '{scenes,0,title}' from public.portal_tour(:'ta', 'destination', 'museo')), 'Sala nueva', 'version 2 is what visitors read');
reset role;
set local role authenticated;
set local request.jwt.claims to :'a1c';
select * from public.restore_tour_revision(:'ta', (select id from ids where name = 'tour'), (select revision_id from pub));
set local role anon;
select is((select manifest #>> '{scenes,0,title}' from public.portal_tour(:'ta', 'destination', 'museo')), 'Sala', 'back to version 1, its own manifest');
select ok(not has_function_privilege('anon', 'public.tour_editor(uuid, uuid)', 'execute')
          and has_function_privilege('anon', 'public.portal_tour_index(uuid)', 'execute'),
  'visitors use only the portal reads');

select * from finish();
rollback;
