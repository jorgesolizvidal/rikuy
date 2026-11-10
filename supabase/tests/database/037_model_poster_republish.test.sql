-- A new poster of a model reaches visitors when the tour is published again (ADR-048, nota de
-- la corrección): each poster has its own name, recording it opens a draft in the published
-- tours that show it (never touching what visitors see), and publishing seals the new image
-- while the earlier revision keeps the old one.
begin;
set local client_min_messages to warning;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

\set ta 'aaaaaaaa-0000-4000-8000-000000000001'
\set tb 'bbbbbbbb-0000-4000-8000-000000000001'
\set a1c '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}'
\set a3c '{"sub":"00000000-0000-4000-8000-0000000000a3","role":"authenticated","aal":"aal2"}'
\set a4c '{"sub":"00000000-0000-4000-8000-0000000000a4","role":"authenticated","aal":"aal2"}'
\set b1c '{"sub":"00000000-0000-4000-8000-0000000000b1","role":"authenticated","aal":"aal2"}'
\set sha '0000000000000000000000000000000000000000000000000000000000000abc'
\set pano '{"version":1,"projection":"equirectangular","source":{"width":8192,"height":4096,"bytes":9000000,"mime":"image/jpeg","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"preview":{"file":"preview.webp","width":1024,"height":512,"bytes":18000},"image":{"file":"image.webp","width":4096,"height":2048,"bytes":1400000},"tiles":null}'
\set model '{"version":1,"format":"glb","source":{"bytes":482828,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","triangles":15177,"vertices":4612,"materials":4,"textures":11,"generator":"Blender","extensions":[]},"model":{"file":"model.glb","bytes":1250000,"triangles":15177,"geometry":"meshopt","textures":[]},"colors":{"materials":"unchanged","vertexColors":null,"suspects":[]},"weight":"light","poster":{"file":"poster.webp","width":1280,"height":960,"bytes":90000}}'
\set newposter '{"file":"poster-0a1b2c3d.webp","width":957,"height":535,"bytes":147808}'

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

-- A's panorama p and model m (both public), a model u no tour uses; B's model mb.
create temp table media (name text primary key, tenant uuid, purpose public.asset_purpose, asset uuid default gen_random_uuid(), version_id uuid default gen_random_uuid());
insert into media (name, tenant, purpose) values
  ('p', :'ta', 'panorama'), ('m', :'ta', 'model'), ('u', :'ta', 'model'), ('mb', :'tb', 'model');
insert into public.assets (id, tenant_id, purpose) select asset, tenant, purpose from media;
insert into public.asset_versions (id, tenant_id, asset_id, version, status, declared_mime, declared_bytes, mime, bytes, width, height, sha256, ready_at, manifest, published_at)
select version_id, tenant, asset, 1, 'ready',
       case when purpose = 'model' then 'model/gltf-binary' else 'image/jpeg' end, 1000,
       case when purpose = 'model' then 'model/gltf-binary' else 'image/jpeg' end, 1000,
       case when purpose = 'model' then null else 2048 end,
       case when purpose = 'model' then null else 1024 end,
       :'sha', now(),
       case when purpose = 'panorama' then :'pano'::jsonb else :'model'::jsonb end, now()
from media;

create temp table ids (name text primary key, id uuid);
grant select, insert on media, ids to authenticated;

-- Two published tours show m: the museum (no draft) and the plaza (with a draft open).
set local role authenticated;
set local request.jwt.claims to :'a1c';
insert into ids select 'museo', content_id from public.create_content_item(:'ta', 'destination', 'museo', 'Museo');
insert into ids select 'plaza', content_id from public.create_content_item(:'ta', 'destination', 'plaza', 'Plaza');
insert into ids select 'tour', tour_id from public.create_tour(:'ta', (select id from ids where name = 'museo'));
insert into ids select 'tour2', tour_id from public.create_tour(:'ta', (select id from ids where name = 'plaza'));
insert into ids select 'scene', scene_id from public.add_tour_scene(:'ta', (select id from ids where name = 'tour'), 1, (select version_id from media where name = 'p'), 'Sala');
insert into ids select 'scene2', scene_id from public.add_tour_scene(:'ta', (select id from ids where name = 'tour2'), 1, (select version_id from media where name = 'p'), 'Plaza');
select * from public.add_tour_hotspot(:'ta', (select id from ids where name = 'tour'), 2,
  (select id from ids where name = 'scene'),
  jsonb_build_object('kind', 'model', 'title', 'Horno', 'position', '{"yaw":0,"pitch":-0.4}'::jsonb,
                     'modelVersionId', (select version_id from media where name = 'm')));
select * from public.add_tour_hotspot(:'ta', (select id from ids where name = 'tour2'), 2,
  (select id from ids where name = 'scene2'),
  jsonb_build_object('kind', 'model', 'title', 'Monumento', 'position', '{"yaw":0,"pitch":0}'::jsonb,
                     'modelVersionId', (select version_id from media where name = 'm')));
select * from public.publish_tour(:'ta', (select id from ids where name = 'tour'), 3);
select * from public.publish_tour(:'ta', (select id from ids where name = 'tour2'), 3);
insert into ids select 'published', published_revision_id from public.tours where id = (select id from ids where name = 'tour');
-- The plaza gets a draft (a new scene title).
select * from public.update_tour_scene(:'ta', (select id from ids where name = 'tour2'), null,
  (select id from ids where name = 'scene2'), '{"title":"Plaza mayor"}'::jsonb);
insert into ids select 'plaza_draft', draft_revision_id from public.tours where id = (select id from ids where name = 'tour2');

select plan(20);

-- ── The poster's name ──────────────────────────────────────────────────────
reset role;
select ok(private.is_valid_model_poster(:'newposter'::jsonb), 'a poster has its own name');
select ok(private.is_valid_model_poster(:'model'::jsonb -> 'poster'), 'poster.webp, saved before, stays valid');
select ok(
  not private.is_valid_model_poster('{"file":"poster-../x.webp","width":957,"height":535,"bytes":1}'::jsonb)
  and not private.is_valid_model_poster('{"file":"poster-0A1B2C3D.webp","width":957,"height":535,"bytes":1}'::jsonb)
  and not private.is_valid_model_poster('{"file":"poster-0a1b2c3d.png","width":957,"height":535,"bytes":1}'::jsonb)
  and not private.is_valid_model_poster('{"file":"model.glb","width":957,"height":535,"bytes":1}'::jsonb),
  'nothing else is a poster name'
);

-- ── Who changes it ─────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to :'a4c';
select throws_ok(
  format($$select * from public.change_model_poster(%L, %L, %L)$$, :'ta', (select version_id from media where name = 'm'), :'newposter'),
  '42501', null, 'an analyst does not change the poster'
);
set local request.jwt.claims to :'b1c';
select throws_ok(
  format($$select * from public.change_model_poster(%L, %L, %L)$$, :'ta', (select version_id from media where name = 'm'), :'newposter'),
  '42501', null, 'nor another municipality'
);
select throws_ok(
  format($$select * from public.change_model_poster(%L, %L, %L)$$, :'tb', (select version_id from media where name = 'm'), :'newposter'),
  'PT404', null, 'nor a model of A seen from B'
);
set local request.jwt.claims to :'a3c';
select throws_ok(
  format($$select * from public.change_model_poster(%L, %L, %L)$$, :'ta', (select version_id from media where name = 'm'), '{"file":"poster-zz.webp","width":957,"height":535,"bytes":1}'),
  '23514', null, 'an invalid poster is refused'
);
select throws_ok(
  format($$select * from public.change_model_poster(%L, %L, %L)$$, :'ta', (select version_id from media where name = 'p'), :'newposter'),
  'PT404', null, 'a panorama has no poster'
);

-- ── Recording it prepares the tours ────────────────────────────────────────
create temp table changed as
select * from public.change_model_poster(:'ta', (select version_id from media where name = 'm'), :'newposter');
select results_eq(
  'select tour_id, opened_draft from changed order by opened_draft',
  format($$values (%L::uuid, false), (%L::uuid, true)$$, (select id from ids where name = 'tour2'), (select id from ids where name = 'tour')),
  'an editor changes the poster: the museum gets a draft, the plaza keeps the one it had'
);
reset role;
select is(
  (select manifest -> 'poster' from public.asset_versions where id = (select version_id from media where name = 'm')),
  :'newposter'::jsonb,
  'the version records the new poster'
);
select is(
  (select draft_revision_id from public.tours where id = (select id from ids where name = 'tour2')),
  (select id from ids where name = 'plaza_draft'),
  'the plaza draft is the same'
);
select is(
  (select t.published_revision_id from public.tours t where t.id = (select id from ids where name = 'tour')),
  (select id from ids where name = 'published'),
  'what visitors see does not change'
);
select is(
  (select h->'model'->'poster'->>'file'
   from public.tour_revisions r, jsonb_array_elements(r.manifest->'scenes') s, jsonb_array_elements(s->'hotspots') h
   where r.id = (select id from ids where name = 'published')),
  'poster.webp',
  'the published revision keeps its poster'
);
select is(
  (select count(*)::int from public.tour_hotspots h
   join public.tours t on t.draft_revision_id = h.tour_revision_id
   where t.id = (select id from ids where name = 'tour')
     and h.model_version_id = (select version_id from media where name = 'm')),
  1,
  'the museum draft has the same model point'
);
select is(
  (select jsonb_agg(x order by x) from public.audit_events e, jsonb_array_elements_text(e.diff -> 'tours') x
   where e.action = 'media.model_poster_set' and e.entity_id = (select version_id from media where name = 'm')),
  (select jsonb_agg(tour_id::text order by tour_id::text) from changed),
  'the change is audited with its tours'
);

-- A second poster: both tours already have a draft, nothing else is opened.
set local role authenticated;
set local request.jwt.claims to :'a1c';
select results_eq(
  format($$select count(*)::int, count(*) filter (where opened_draft)::int from public.change_model_poster(%L, %L, %L)$$,
    :'ta', (select version_id from media where name = 'm'), '{"file":"poster-0a1b2c3e.webp","width":957,"height":535,"bytes":140000}'),
  $$values (2, 0)$$,
  'another poster opens no other draft'
);
select is(
  (select count(*)::int from public.change_model_poster(:'ta', (select version_id from media where name = 'u'), :'newposter')),
  0,
  'a model no tour uses changes only its poster'
);

-- ── Publishing again seals the new image; the old revision keeps the old one ───
select * from public.publish_tour(:'ta', (select id from ids where name = 'tour'),
  (select r.edit_count from public.tours t join public.tour_revisions r on r.id = t.draft_revision_id where t.id = (select id from ids where name = 'tour')));
reset role;
select is(
  (select h->'model'->'poster'->>'file'
   from public.tours t
   join public.tour_revisions r on r.id = t.published_revision_id,
   jsonb_array_elements(r.manifest->'scenes') s, jsonb_array_elements(s->'hotspots') h
   where t.id = (select id from ids where name = 'tour')),
  'poster-0a1b2c3e.webp',
  'the tour published again shows the new poster'
);
select is(
  (select h->'model'->'poster'->>'file'
   from public.tour_revisions r, jsonb_array_elements(r.manifest->'scenes') s, jsonb_array_elements(s->'hotspots') h
   where r.id = (select id from ids where name = 'published')),
  'poster.webp',
  'the earlier revision («Volver a esta versión») keeps its own'
);

-- ── Publishing an already public version measures it again ─────────────────
insert into public.usage_buckets (id, tenant_id, resource, period_start, period_end, limit_amount, consumed)
values ('cccccccc-0000-4000-8000-000000000001', :'ta', 'storage_bytes', '2026-01-01', '2100-01-01', 314572800, 1);
insert into public.usage_reservations (tenant_id, bucket_id, resource, asset_version_id, reserved, consumed, status)
values (:'ta', 'cccccccc-0000-4000-8000-000000000001', 'storage_bytes', (select version_id from media where name = 'm'), 0, 1, 'settled');
create temp table before as select published_at from public.asset_versions where id = (select version_id from media where name = 'm');
select public.media_publish_version(:'ta', (select asset from media where name = 'm'), 1);
select results_eq(
  format($$select r.consumed, b.consumed, v.published_at = (select published_at from before)
           from public.usage_reservations r join public.usage_buckets b on b.id = r.bucket_id
           join public.asset_versions v on v.id = r.asset_version_id
           where r.asset_version_id = %L$$, (select version_id from media where name = 'm')),
  $$values (0::bigint, 0::bigint, true)$$,
  'publishing an already public model again (its new poster) measures it again, keeping its date'
);

select * from finish();
rollback;
