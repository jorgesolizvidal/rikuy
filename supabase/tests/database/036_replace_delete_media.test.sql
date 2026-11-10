-- Replacing and deleting panoramas and 3D models (ADR-048): a replacement is a new version
-- of the same asset; using it puts it in the draft of each tour (never in what visitors see
-- until publishing); only what no tour revision ever used can be deleted, and deleting frees
-- the quota and hands the files to the runner.
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

-- Media of A: p1 (used by the tour), p2 (never used), pp (still processing), m (a model the
-- tour uses), img (a photo); and B's panorama pb.
create temp table media (name text primary key, tenant uuid, purpose public.asset_purpose, status public.asset_version_status, asset uuid default gen_random_uuid(), version_id uuid default gen_random_uuid());
insert into media (name, tenant, purpose, status) values
  ('p1', :'ta', 'panorama', 'ready'), ('p2', :'ta', 'panorama', 'ready'), ('pp', :'ta', 'panorama', 'processing'),
  ('m', :'ta', 'model', 'ready'), ('img', :'ta', 'content', 'ready'), ('pb', :'tb', 'panorama', 'ready');
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
update public.asset_versions set published_at = now() where status = 'ready';

-- A version that becomes ready the way the pipeline leaves it (not public yet).
create function pg_temp.ready(p_version uuid) returns void language sql as $$
  update public.asset_versions v
  set status = 'ready', mime = v.declared_mime, bytes = 1000, sha256 = repeat('0', 61) || 'abc', ready_at = now(),
      width = case when v.declared_mime = 'model/gltf-binary' then null else 2048 end,
      height = case when v.declared_mime = 'model/gltf-binary' then null else 1024 end,
      manifest = case when v.declared_mime = 'model/gltf-binary'
        then '{"version":1,"format":"glb","source":{"bytes":482828,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","triangles":15177,"vertices":4612,"materials":4,"textures":11,"generator":"Blender","extensions":[]},"model":{"file":"model.glb","bytes":1250000,"triangles":15177,"geometry":"meshopt","textures":[]},"colors":{"materials":"unchanged","vertexColors":null,"suspects":[]},"weight":"light","poster":null}'::jsonb
        else '{"version":1,"projection":"equirectangular","source":{"width":8192,"height":4096,"bytes":9000000,"mime":"image/jpeg","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"preview":{"file":"preview.webp","width":1024,"height":512,"bytes":18000},"image":{"file":"image.webp","width":4096,"height":2048,"bytes":1400000},"tiles":null}'::jsonb end
  where v.id = p_version;
$$;

create temp table ids (name text primary key, id uuid);
grant select, insert on media, ids to authenticated;

-- A museum with a published tour: one scene on p1 and a model point on m.
set local role authenticated;
set local request.jwt.claims to :'a1c';
insert into ids select 'museo', content_id from public.create_content_item(:'ta', 'destination', 'museo', 'Museo');
insert into ids select 'tour', tour_id from public.create_tour(:'ta', (select id from ids where name = 'museo'));
insert into ids select 'scene', scene_id from public.add_tour_scene(:'ta', (select id from ids where name = 'tour'), 1, (select version_id from media where name = 'p1'), 'Sala');
insert into ids select 'point', hotspot_id from public.add_tour_hotspot(:'ta', (select id from ids where name = 'tour'), 2,
  (select id from ids where name = 'scene'),
  jsonb_build_object('kind', 'model', 'title', 'Horno', 'position', '{"yaw":0,"pitch":-0.4}'::jsonb,
                     'modelVersionId', (select version_id from media where name = 'm')));
select * from public.publish_tour(:'ta', (select id from ids where name = 'tour'), 3);

select plan(42);

-- ── Where it is used ───────────────────────────────────────────────────────
select results_eq(
  format($$select asset_id, content_title, scope, version from public.media_asset_uses(%L, 'panorama')$$, :'ta'),
  format($$values (%L::uuid, 'Museo'::text, 'published'::text, 1)$$, (select asset from media where name = 'p1')),
  'the panel learns that the published tour of the museum uses p1, and nothing uses p2'
);
set local request.jwt.claims to :'a4c';
select is(
  (select count(*)::int from public.media_asset_uses(:'ta', 'model')), 1,
  'an analyst sees where the model is used'
);
set local request.jwt.claims to :'b1c';
select throws_ok(
  format($$select * from public.media_asset_uses(%L, 'panorama')$$, :'ta'),
  '42501', null, 'another municipality does not'
);
set local request.jwt.claims to :'a1c';
select throws_ok(
  format($$select * from public.media_asset_uses(%L, 'content')$$, :'ta'),
  '23514', null, 'photos are not tour media'
);

-- ── Replacing ──────────────────────────────────────────────────────────────
set local request.jwt.claims to :'a3c';
insert into ids select 'p1v2', version_id from public.create_media_replacement_upload(:'ta', (select asset from media where name = 'p1'), 'image/jpeg', 5000000);
select is(
  (select version || ' ' || status::text || ' ' || original_path from public.asset_versions where id = (select id from ids where name = 'p1v2')),
  '2 uploading ' || :'ta' || '/' || (select asset from media where name = 'p1') || '/2/original',
  'an editor uploads a new version of the same panorama'
);
select throws_ok(
  format($$select * from public.create_media_replacement_upload(%L, %L, 'image/jpeg', 5000000)$$, :'ta', (select asset from media where name = 'p1')),
  'PT409', 'a replacement is already on its way', 'one replacement at a time'
);
select throws_ok(
  format($$select * from public.create_media_replacement_upload(%L, %L, 'image/jpeg', 5000000)$$, :'ta', (select asset from media where name = 'pp')),
  'PT409', 'a replacement is already on its way', 'not while the panorama is still being processed'
);
select throws_ok(
  format($$select * from public.create_media_replacement_upload(%L, %L, 'model/gltf-binary', 5000000)$$, :'ta', (select asset from media where name = 'p2')),
  '23514', null, 'a panorama is replaced by an image, not a model'
);
select throws_ok(
  format($$select * from public.create_media_replacement_upload(%L, %L, 'image/jpeg', 60000000)$$, :'ta', (select asset from media where name = 'p2')),
  '23514', null, 'up to 50 MB'
);
select throws_ok(
  format($$select * from public.create_media_replacement_upload(%L, %L, 'image/jpeg', 5000)$$, :'ta', (select asset from media where name = 'img')),
  'PT404', null, 'photos are not replaced here'
);
select throws_ok(
  format($$select * from public.create_media_replacement_upload(%L, %L, 'image/jpeg', 5000)$$, :'ta', (select asset from media where name = 'pb')),
  'PT404', null, 'nor another municipality''s panorama through this one'
);
set local request.jwt.claims to :'a4c';
select throws_ok(
  format($$select * from public.create_media_replacement_upload(%L, %L, 'image/jpeg', 5000)$$, :'ta', (select asset from media where name = 'p2')),
  '42501', null, 'an analyst cannot replace'
);

-- Not ready yet: nothing to use.
set local request.jwt.claims to :'a3c';
select throws_ok(
  format('select * from public.apply_media_replacement(%L, %L)', :'ta', (select id from ids where name = 'p1v2')),
  'PT409', 'the new version is not ready', 'a version still uploading cannot be used'
);
reset role;
select pg_temp.ready((select id from ids where name = 'p1v2'));
set local role authenticated;

set local request.jwt.claims to :'a4c';
select throws_ok(
  format('select * from public.apply_media_replacement(%L, %L)', :'ta', (select id from ids where name = 'p1v2')),
  '42501', null, 'an analyst cannot use it in the tours'
);
set local request.jwt.claims to :'b1c';
select throws_ok(
  format('select * from public.apply_media_replacement(%L, %L)', :'ta', (select id from ids where name = 'p1v2')),
  '42501', null, 'nor another municipality'
);
set local request.jwt.claims to :'a3c';
select results_eq(
  format('select tour_id, opened_draft from public.apply_media_replacement(%L, %L)', :'ta', (select id from ids where name = 'p1v2')),
  format('values (%L::uuid, true)', (select id from ids where name = 'tour')),
  'the editor uses it: the tour gets a draft'
);
select is(
  (select s.panorama_version_id from public.tour_scenes s join public.tours t on t.draft_revision_id = s.tour_revision_id
   where t.id = (select id from ids where name = 'tour')),
  (select id from ids where name = 'p1v2'),
  'the draft scene shows the new version, with the same scene id'
);
select is(
  (select s.panorama_version_id from public.tour_scenes s join public.tours t on t.published_revision_id = s.tour_revision_id
   where t.id = (select id from ids where name = 'tour')),
  (select version_id from media where name = 'p1'),
  'visitors still see the old one until the tour is published'
);
select is(
  (select s.scene_id from public.tour_scenes s join public.tours t on t.draft_revision_id = s.tour_revision_id
   where t.id = (select id from ids where name = 'tour')),
  (select id from ids where name = 'scene'),
  'its points and view stay (same scene)'
);
select is(
  (select count(*)::int from public.tour_hotspots h join public.tours t on t.draft_revision_id = h.tour_revision_id
   where t.id = (select id from ids where name = 'tour') and h.model_version_id = (select version_id from media where name = 'm')),
  1, 'the model point is untouched'
);
select is(
  (select count(*)::int from public.apply_media_replacement(:'ta', (select id from ids where name = 'p1v2'))),
  0, 'using it again changes nothing'
);
select results_eq(
  format($$select scope, version from public.media_asset_uses(%L, 'panorama') order by scope$$, :'ta'),
  $$values ('draft'::text, 2), ('published'::text, 1)$$,
  'the panel sees the new version in the draft and the old one published'
);
select throws_ok(
  format('select * from public.apply_media_replacement(%L, %L)', :'ta', (select version_id from media where name = 'p1')),
  'PT409', 'a newer version exists', 'an older version cannot be put back this way'
);

-- A third version with the draft already open: the draft changes, its edit count moves on.
create temp table before_edit as
  select r.edit_count from public.tour_revisions r join public.tours t on t.draft_revision_id = r.id
  where t.id = (select id from ids where name = 'tour');
insert into ids select 'p1v3', version_id from public.create_media_replacement_upload(:'ta', (select asset from media where name = 'p1'), 'image/webp', 5000000);
reset role;
select pg_temp.ready((select id from ids where name = 'p1v3'));
set local role authenticated;
set local request.jwt.claims to :'a3c';
select results_eq(
  format('select tour_id, opened_draft from public.apply_media_replacement(%L, %L)', :'ta', (select id from ids where name = 'p1v3')),
  format('values (%L::uuid, false)', (select id from ids where name = 'tour')),
  'with a draft open, the same draft gets it'
);
select ok(
  (select r.edit_count from public.tour_revisions r join public.tours t on t.draft_revision_id = r.id
   where t.id = (select id from ids where name = 'tour')) > (select edit_count from before_edit),
  'and its edit count moves on (an editor with the old page open must reload)'
);

-- The model: same rules, on its points.
insert into ids select 'mv2', version_id from public.create_media_replacement_upload(:'ta', (select asset from media where name = 'm'), 'model/gltf-binary', 3000000);
reset role;
select pg_temp.ready((select id from ids where name = 'mv2'));
set local role authenticated;
set local request.jwt.claims to :'a3c';
select is(
  (select count(*)::int from public.apply_media_replacement(:'ta', (select id from ids where name = 'mv2'))), 1,
  'a new version of the model goes to the tour draft'
);
select is(
  (select h.model_version_id from public.tour_hotspots h join public.tours t on t.draft_revision_id = h.tour_revision_id
   where t.id = (select id from ids where name = 'tour')),
  (select id from ids where name = 'mv2'), 'the point shows it'
);
set local request.jwt.claims to :'a1c';
select throws_ok(
  format('select * from public.publish_tour(%L, %L, %s)', :'ta', (select id from ids where name = 'tour'),
    (select r.edit_count from public.tour_revisions r join public.tours t on t.draft_revision_id = r.id where t.id = (select id from ids where name = 'tour'))),
  'PT409', 'a 3D model has no poster yet', 'the new model needs its poster before the tour is published'
);
reset role;
select is(
  (select count(*)::int from public.audit_events where action = 'media.replacement_applied'),
  4, 'each use is audited'
);
set local role authenticated;

-- ── Deleting ───────────────────────────────────────────────────────────────
set local request.jwt.claims to :'a1c';
select throws_ok(
  format('select public.delete_media_asset(%L, %L)', :'ta', (select asset from media where name = 'p1')),
  'PT409', 'a tour uses it', 'a panorama a tour uses (or used) cannot be deleted'
);
select throws_ok(
  format('select public.delete_media_asset(%L, %L)', :'ta', (select asset from media where name = 'pp')),
  'PT409', 'it is being processed', 'nor one still being processed'
);
set local request.jwt.claims to :'a3c';
select throws_ok(
  format('select public.delete_media_asset(%L, %L)', :'ta', (select asset from media where name = 'p2')),
  '42501', null, 'editors do not delete'
);
set local request.jwt.claims to :'b1c';
select throws_ok(
  format('select public.delete_media_asset(%L, %L)', :'ta', (select asset from media where name = 'p2')),
  '42501', null, 'nor another municipality'
);
select throws_ok(
  format('select public.delete_media_asset(%L, %L)', :'tb', (select asset from media where name = 'p2')),
  'PT404', null, 'not even through its own'
);
set local request.jwt.claims to :'a1c';
select is(
  public.delete_media_asset(:'ta', (select asset from media where name = 'p2')), 1,
  'the owner deletes the panorama nobody used'
);
select is(
  (select count(*)::int from public.list_tenant_panoramas(:'ta') where asset_id = (select asset from media where name = 'p2')),
  0, 'it leaves the list'
);
select throws_ok(
  format('select public.delete_media_asset(%L, %L)', :'ta', (select asset from media where name = 'p2')),
  'PT404', null, 'deleting twice finds nothing'
);
select throws_ok(
  format($$select * from public.create_media_replacement_upload(%L, %L, 'image/jpeg', 5000)$$, :'ta', (select asset from media where name = 'p2')),
  'PT404', null, 'a deleted panorama is not replaced'
);
select throws_ok(
  format('select * from public.add_tour_scene(%L, %L, %s, %L, %L)', :'ta', (select id from ids where name = 'tour'),
    (select r.edit_count from public.tour_revisions r join public.tours t on t.draft_revision_id = r.id where t.id = (select id from ids where name = 'tour')),
    (select version_id from media where name = 'p2'), 'Otra'),
  '23514', null, 'nor added to a tour from a page opened before'
);
reset role;
select is(
  (select status::text || ': ' || rejected_reason from public.asset_versions where id = (select version_id from media where name = 'p2')),
  'rejected: Borrado por el municipio.', 'its version is rejected (its quota is freed)'
);
select is(
  (select diff ->> 'versions' from public.audit_events where action = 'media.deleted'), '1',
  'the deletion is audited'
);

-- The runner removes the files of the deleted version.
set local role rikuy_worker;
create temp table c1 as select * from worker_api.claim_jobs('runner-a', 5, array['media.remove_unused']);
create temp table claimed as
  select worker_api.claim_unused_media((select job_id from c1), (select fencing_token from c1)) as prefix;
reset role;
select is(
  (select prefix from claimed),
  :'ta' || '/' || (select asset from media where name = 'p2') || '/1/',
  'the cleanup job hands the runner the folder of the deleted panorama'
);

select * from finish();
rollback;
