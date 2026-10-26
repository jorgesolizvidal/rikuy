-- Tours 360° and scenes (P4 · Paso 1): one tour per content item, one entry scene per
-- revision, intent RPCs that never rewrite what they were not asked to change, sealed
-- revisions and rollback of the whole graph (RC-02).
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
\set manifest '{"version":1,"projection":"equirectangular","source":{"width":8192,"height":4096,"bytes":9000000,"mime":"image/jpeg","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"preview":{"file":"preview.webp","width":1024,"height":512,"bytes":18000},"image":{"file":"image.webp","width":4096,"height":2048,"bytes":1400000},"tiles":null}'

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

-- Media: four ready panoramas of A (p1..p4), one still processing (pp), one ready photo
-- (img) and a ready panorama of B (pb).
create temp table media (name text primary key, tenant uuid, purpose public.asset_purpose, status public.asset_version_status, asset uuid default gen_random_uuid(), version_id uuid default gen_random_uuid());
insert into media (name, tenant, purpose, status) values
  ('p1', :'ta', 'panorama', 'ready'), ('p2', :'ta', 'panorama', 'ready'),
  ('p3', :'ta', 'panorama', 'ready'), ('p4', :'ta', 'panorama', 'ready'),
  ('pp', :'ta', 'panorama', 'processing'), ('img', :'ta', 'content', 'ready'),
  ('pb', :'tb', 'panorama', 'ready');
insert into public.assets (id, tenant_id, purpose) select asset, tenant, purpose from media;
insert into public.asset_versions (id, tenant_id, asset_id, version, status, declared_mime, declared_bytes, mime, bytes, width, height, sha256, ready_at, manifest)
select version_id, tenant, asset, 1, status, 'image/jpeg', 1000,
       case when status = 'ready' then 'image/jpeg' end,
       case when status = 'ready' then 1000 end,
       case when status = 'ready' then 8192 end,
       case when status = 'ready' then 4096 end,
       case when status = 'ready' then :'sha' end,
       case when status = 'ready' then now() end,
       case when status = 'ready' and purpose = 'panorama' then :'manifest'::jsonb end
from media;
grant select on media to authenticated;

create temp table ids (name text primary key, id uuid);
grant select, insert, update on ids to authenticated;

select plan(59);

-- ── Structure ───────────────────────────────────────────────────────────────
select ok((select bool_and(relrowsecurity) from pg_class where oid in ('public.tours'::regclass, 'public.tour_revisions'::regclass, 'public.tour_scenes'::regclass)), 'tours, revisions and scenes have RLS');
select ok(not has_table_privilege('authenticated', 'public.tour_scenes', 'insert')
          and not has_table_privilege('authenticated', 'public.tour_revisions', 'update'),
          'no direct writes: only intent RPCs');
select ok(not has_function_privilege('anon', 'public.create_tour(uuid, uuid)', 'execute')
          and not has_function_privilege('anon', 'public.tour_editor(uuid, uuid)', 'execute'),
          'visitors cannot call the editor RPCs');

-- ── Creating a tour ─────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to :'a1c';
insert into ids select 'dest', content_id from public.create_content_item(:'ta', 'destination', 'museo', 'Museo');
insert into ids select 'dest2', content_id from public.create_content_item(:'ta', 'destination', 'plaza', 'Plaza');
insert into ids select 'event', content_id from public.create_content_item(:'ta', 'event', 'feria', 'Feria');
set local request.jwt.claims to :'b1c';
insert into ids select 'destb', content_id from public.create_content_item(:'tb', 'destination', 'mirador', 'Mirador');

set local request.jwt.claims to :'a3c';
insert into ids select 'tour', tour_id from public.create_tour(:'ta', (select id from ids where name = 'dest'));
select ok((select id from ids where name = 'tour') is not null, 'an editor gives a destination its tour');
select throws_ok(format('select * from public.create_tour(%L, %L)', :'ta', (select id from ids where name = 'dest')),
  'PT409', null, 'a destination has at most one tour');
select throws_ok(format('select * from public.create_tour(%L, %L)', :'ta', (select id from ids where name = 'destb')),
  'PT404', null, 'a tour cannot belong to another municipality''s destination');
insert into ids select 'etour', tour_id from public.create_tour(:'ta', (select id from ids where name = 'event'));
select ok((select id from ids where name = 'etour') is not null, 'an event can have a tour too');
set local request.jwt.claims to :'a4c';
select throws_ok(format('select * from public.create_tour(%L, %L)', :'ta', (select id from ids where name = 'dest2')),
  '42501', null, 'an analyst cannot create tours');
set local request.jwt.claims to :'b1c';
select throws_ok(format('select * from public.create_tour(%L, %L)', :'ta', (select id from ids where name = 'dest2')),
  '42501', null, 'the owner of B cannot create tours in A');

-- ── Scenes ──────────────────────────────────────────────────────────────────
set local request.jwt.claims to :'a3c';
select throws_ok(format('select * from public.publish_tour(%L, %L, 1)', :'ta', (select id from ids where name = 'tour')),
  '42501', null, 'an editor cannot publish');
set local request.jwt.claims to :'a1c';
select throws_ok(format('select * from public.publish_tour(%L, %L, 1)', :'ta', (select id from ids where name = 'tour')),
  '23514', null, 'publishing a tour without scenes (and so without entry) fails');

set local request.jwt.claims to :'a3c';
create temp table s1 as select * from public.add_tour_scene(:'ta', (select id from ids where name = 'tour'), 1, (select version_id from media where name = 'p1'), 'Entrada');
select is((select edit_count from s1), 2, 'adding a scene counts as an edit');
select is((select entry_scene_id from public.tour_revisions where id = (select revision_id from s1)),
  (select scene_id from s1), 'the first scene becomes the entry');
select throws_ok(format('select * from public.add_tour_scene(%L, %L, 1, %L, %L)', :'ta', (select id from ids where name = 'tour'), (select version_id from media where name = 'p2'), 'Sala'),
  'PT409', null, 'an old edit number is refused');
select throws_ok(format('select * from public.add_tour_scene(%L, %L, 2, %L, %L)', :'ta', (select id from ids where name = 'tour'), (select version_id from media where name = 'p1'), 'Otra vez'),
  'PT409', null, 'a panorama appears once per tour');
select throws_ok(format('select * from public.add_tour_scene(%L, %L, 2, %L, %L)', :'ta', (select id from ids where name = 'tour'), (select version_id from media where name = 'pp'), 'Procesando'),
  '23514', null, 'a panorama still processing cannot be a scene');
select throws_ok(format('select * from public.add_tour_scene(%L, %L, 2, %L, %L)', :'ta', (select id from ids where name = 'tour'), (select version_id from media where name = 'img'), 'Foto'),
  '23514', null, 'a photo is not a panorama');
select throws_ok(format('select * from public.add_tour_scene(%L, %L, 2, %L, %L)', :'ta', (select id from ids where name = 'tour'), (select version_id from media where name = 'pb'), 'Ajeno'),
  '23514', null, 'a panorama of another municipality cannot be a scene');
select throws_ok(format('select * from public.add_tour_scene(%L, %L, 2, %L, %L)', :'ta', (select id from ids where name = 'tour'), (select version_id from media where name = 'p2'), ' Sala'),
  '23514', null, 'scene titles are trimmed lines');
create temp table s2 as select * from public.add_tour_scene(:'ta', (select id from ids where name = 'tour'), 2, (select version_id from media where name = 'p2'), 'Sala');
select is((select entry_scene_id from public.tour_revisions where id = (select revision_id from s2)),
  (select scene_id from s1), 'adding more scenes keeps the entry');

-- Partial changes: only what is sent changes.
select lives_ok(format($q$select * from public.update_tour_scene(%L, %L, 3, %L, '{"description":"La sala principal","initialView":{"yaw":1.5,"pitch":-0.2,"fov":70}}')$q$,
  :'ta', (select id from ids where name = 'tour'), (select scene_id from s2)), 'description and initial view are saved');
select lives_ok(format($q$select * from public.update_tour_scene(%L, %L, 4, %L, '{"title":"Sala principal"}')$q$,
  :'ta', (select id from ids where name = 'tour'), (select scene_id from s2)), 'the title alone is saved');
select is((select row(title, description, initial_yaw, initial_pitch, initial_fov, panorama_version_id)::text from public.tour_scenes where scene_id = (select scene_id from s2)),
  row('Sala principal', 'La sala principal', 1.5::double precision, -0.2::double precision, 70::double precision, (select version_id from media where name = 'p2'))::text,
  'changing the title keeps description, initial view and panorama (RC-01)');
select throws_ok(format($q$select * from public.update_tour_scene(%L, %L, 5, %L, '{"initialView":{"yaw":4,"pitch":0,"fov":60}}')$q$,
  :'ta', (select id from ids where name = 'tour'), (select scene_id from s2)), '23514', null, 'yaw outside [-π, π) is refused');
select throws_ok(format($q$select * from public.update_tour_scene(%L, %L, 5, %L, '{"initialView":{"yaw":0,"pitch":0,"fov":120}}')$q$,
  :'ta', (select id from ids where name = 'tour'), (select scene_id from s2)), '23514', null, 'a field of view above 90° is refused');
select throws_ok(format($q$select * from public.update_tour_scene(%L, %L, 5, %L, '{"panoramaVersionId":"x"}')$q$,
  :'ta', (select id from ids where name = 'tour'), (select scene_id from s2)), '23514', null, 'unknown fields are refused');
set local request.jwt.claims to :'b1c';
select throws_ok(format($q$select * from public.update_tour_scene(%L, %L, 5, %L, '{"title":"X"}')$q$,
  :'ta', (select id from ids where name = 'tour'), (select scene_id from s2)), '42501', null, 'the owner of B cannot edit A''s scenes');
select throws_ok(format('select * from public.set_tour_entry_scene(%L, %L, 5, %L)', :'tb', (select id from ids where name = 'tour'), (select scene_id from s2)),
  'PT404', null, 'A''s tour does not exist for B');

-- ── Publishing (two scenes) ─────────────────────────────────────────────────
set local request.jwt.claims to :'a1c';
create temp table pub1 as select * from public.publish_tour(:'ta', (select id from ids where name = 'tour'), 5);
select is((select revision_no from pub1), 1, 'the owner publishes revision 1');
select is((select row(t.published_revision_id, t.draft_revision_id)::text from public.tours t where t.id = (select id from ids where name = 'tour')),
  row((select revision_id from pub1), null::uuid)::text, 'the public points at it and there is no draft');
reset role;
select throws_ok(format($q$update public.tour_scenes set title = 'X' where tour_revision_id = %L$q$, (select revision_id from pub1)),
  '23514', null, 'scenes of a sealed revision are immutable');
select throws_ok(format('update public.tour_revisions set entry_scene_id = null where id = %L', (select revision_id from pub1)),
  '23514', null, 'a sealed revision is immutable');
set local role authenticated;

-- ── A new draft: copy of the published graph, same scene ids ───────────────
set local request.jwt.claims to :'a3c';
select throws_ok(format('select * from public.add_tour_scene(%L, %L, 5, %L, %L)', :'ta', (select id from ids where name = 'tour'), (select version_id from media where name = 'p3'), 'Patio'),
  'PT409', null, 'after publishing, an edit starts from "no draft" (null), not an old number');
create temp table s3 as select * from public.add_tour_scene(:'ta', (select id from ids where name = 'tour'), null, (select version_id from media where name = 'p3'), 'Patio');
select isnt((select revision_id from s3), (select revision_id from pub1), 'editing opens a new draft');
select is((select array_agg(scene_id order by position) from public.tour_scenes where tour_revision_id = (select revision_id from s3) and position < 2),
  (select array_agg(scene_id order by position) from public.tour_scenes where tour_revision_id = (select revision_id from pub1)),
  'the draft keeps the published scenes with the same ids');
create temp table s4 as select * from public.add_tour_scene(:'ta', (select id from ids where name = 'tour'), (select edit_count from s3), (select version_id from media where name = 'p4'), 'Torre');
select is((select count(*)::integer from public.tour_scenes where tour_revision_id = (select revision_id from s4)), 4, 'two scenes, then four');

-- Order: moving does not change the entry.
select lives_ok(format('select * from public.move_tour_scene(%L, %L, %s, %L, 0)', :'ta', (select id from ids where name = 'tour'), (select edit_count from s4), (select scene_id from s4)),
  'the last scene moves to the front');
select is((select array_agg(title order by position) from public.tour_scenes where tour_revision_id = (select revision_id from s4)),
  array['Torre', 'Entrada', 'Sala principal', 'Patio'], 'the others shift');
select is((select entry_scene_id from public.tour_revisions where id = (select revision_id from s4)), (select scene_id from s1),
  'editing the order does not change the entry');
select throws_ok(format('select * from public.move_tour_scene(%L, %L, %s, %L, 4)', :'ta', (select id from ids where name = 'tour'), (select edit_count from s4) + 1, (select scene_id from s4)),
  '23514', null, 'a position past the end is refused');

-- Entry: exactly one, of this tour.
select lives_ok(format('select * from public.set_tour_entry_scene(%L, %L, %s, %L)', :'ta', (select id from ids where name = 'tour'), (select edit_count from s4) + 1, (select scene_id from s3)),
  'the entry changes');
select is((select entry_scene_id from public.tour_revisions where id = (select revision_id from s4)), (select scene_id from s3),
  'the new entry is the one reference (no flags on scenes)');
create temp table es as select * from public.add_tour_scene(:'ta', (select id from ids where name = 'etour'), 1, (select version_id from media where name = 'p1'), 'Feria');
select throws_ok(format('select * from public.set_tour_entry_scene(%L, %L, %s, %L)', :'ta', (select id from ids where name = 'tour'), (select edit_count from s4) + 2, (select scene_id from es)),
  'PT404', null, 'a scene of another tour cannot be the entry');

-- ── Publish 2, roll back to 1: the whole graph comes back ──────────────────
set local request.jwt.claims to :'a1c';
create temp table pub2 as select * from public.publish_tour(:'ta', (select id from ids where name = 'tour'), (select edit_count from s4) + 2);
select is((select revision_no from pub2), 2, 'revision 2 (four scenes) is published');
create temp table rb as select * from public.restore_tour_revision(:'ta', (select id from ids where name = 'tour'), (select revision_id from pub1));
select is((select published_revision_id from public.tours where id = (select id from ids where name = 'tour')), (select revision_id from pub1),
  'rolling back points at revision 1');
select is((select (d -> 'entrySceneId')::text || ':' || jsonb_array_length(d -> 'scenes')::text
           from (select public.tour_editor(:'ta', (select id from ids where name = 'tour')) -> 'published' as d) x),
  to_jsonb((select scene_id from s1))::text || ':2', 'and keeps its graph: two scenes and its own entry');
select throws_ok(format('select * from public.restore_tour_revision(%L, %L, %L)', :'ta', (select id from ids where name = 'tour'), (select revision_id from pub1)),
  'PT409', null, 'restoring the published revision again is refused');
select throws_ok(format('select * from public.restore_tour_revision(%L, %L, %L)', :'ta', (select id from ids where name = 'etour'), (select revision_id from pub2)),
  'PT404', null, 'a revision of another tour cannot be restored');
select is(jsonb_array_length(public.tour_editor(:'ta', (select id from ids where name = 'tour')) -> 'history'), 2, 'the history lists both sealed revisions');

-- ── Removing the entry scene ────────────────────────────────────────────────
set local request.jwt.claims to :'a3c';
create temp table rm as select * from public.remove_tour_scene(:'ta', (select id from ids where name = 'tour'), null, (select scene_id from s1));
select is((select entry_scene_id from rm), (select scene_id from s2), 'removing the entry makes the first remaining scene the entry');
select is((select array_agg(position order by position) from public.tour_scenes where tour_revision_id = (select revision_id from rm)),
  array[0]::smallint[], 'positions stay compact');

-- ── Discarding ──────────────────────────────────────────────────────────────
select lives_ok(format('select public.discard_tour_draft(%L, %L, %s)', :'ta', (select id from ids where name = 'tour'), (select edit_count from rm)),
  'the draft of a published tour can be discarded');
select is((select draft_revision_id from public.tours where id = (select id from ids where name = 'tour')), null, 'no draft is left');
select throws_ok(format('select public.discard_tour_draft(%L, %L, %s)', :'ta', (select id from ids where name = 'etour'), (select edit_count from es)),
  'PT409', null, 'a tour that was never published keeps its draft');

-- ── Reads ───────────────────────────────────────────────────────────────────
set local request.jwt.claims to :'a4c';
select is((select array_agg(status || ':' || content_kind::text || ':' || scenes order by content_title) from public.list_tenant_tours(:'ta')),
  array['draft:event:1', 'published:destination:2'], 'members see the tours with their status, kind and scenes');
select is((select count(*)::integer from public.tours), 2, 'an analyst reads A''s tours');
set local request.jwt.claims to :'b1c';
select is((select count(*)::integer from public.tour_scenes), 0, 'B sees no scene of A');
select throws_ok(format('select * from public.list_tenant_tours(%L)', :'ta'), '42501', null, 'B cannot list A''s tours');
select throws_ok(format('select public.tour_revision_document(%L, %L)', :'tb', (select revision_id from pub1)), 'PT404', null, 'nor read its revisions');

select * from finish();
rollback;
