-- Destinations: revisions, publication, rollback, images, location and isolation.
begin;
set local client_min_messages to warning;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

\set ta 'aaaaaaaa-0000-4000-8000-000000000001'
\set tb 'bbbbbbbb-0000-4000-8000-000000000001'
\set a1c '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated"}'
\set a3c '{"sub":"00000000-0000-4000-8000-0000000000a3","role":"authenticated"}'
\set a4c '{"sub":"00000000-0000-4000-8000-0000000000a4","role":"authenticated"}'
\set a5c '{"sub":"00000000-0000-4000-8000-0000000000a5","role":"authenticated"}'
\set b1c '{"sub":"00000000-0000-4000-8000-0000000000b1","role":"authenticated"}'
\set svc '{"role":"service_role"}'
\set sha '0000000000000000000000000000000000000000000000000000000000000abc'
\set body '[{"type":"heading","level":2,"children":[{"type":"text","text":"Historia"}]},{"type":"paragraph","children":[{"type":"text","text":"Texto "},{"type":"text","text":"importante","marks":["bold"]},{"type":"link","href":"https://example.test/a","children":[{"type":"text","text":"más"}]}]},{"type":"list","ordered":true,"items":[[{"type":"text","text":"uno"}],[{"type":"text","text":"dos"}]]}]'

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000a1', 'owner.a@example.test'),
  ('00000000-0000-4000-8000-0000000000a3', 'editor.a@example.test'),
  ('00000000-0000-4000-8000-0000000000a4', 'analyst.a@example.test'),
  ('00000000-0000-4000-8000-0000000000a5', 'revoked.a@example.test'),
  ('00000000-0000-4000-8000-0000000000b1', 'owner.b@example.test');
insert into public.tenants (id, slug, display_name, status, default_locale, timezone) values
  (:'ta', 'tenant-a', 'Tenant A', 'provisioning', 'es', 'America/La_Paz'),
  (:'tb', 'tenant-b', 'Tenant B', 'provisioning', 'es', 'America/La_Paz');
insert into public.memberships (tenant_id, user_id, role, status, accepted_at, revoked_at) values
  (:'ta', '00000000-0000-4000-8000-0000000000a1', 'owner', 'active', now(), null),
  (:'ta', '00000000-0000-4000-8000-0000000000a3', 'editor', 'active', now(), null),
  (:'ta', '00000000-0000-4000-8000-0000000000a4', 'analyst', 'active', now(), null),
  (:'ta', '00000000-0000-4000-8000-0000000000a5', 'admin', 'revoked', now(), now()),
  (:'tb', '00000000-0000-4000-8000-0000000000b1', 'owner', 'active', now(), null);
update public.tenants set status = 'active';
set constraints all immediate;

select plan(57);

-- ── Structure and privileges ────────────────────────────────────────────────
select ok(relrowsecurity, format('RLS enabled on %s', relname))
from pg_class
where oid in ('public.content_items'::regclass, 'public.content_revisions'::regclass, 'public.media_references'::regclass)
order by relname;
select ok(
  not has_table_privilege('anon', t, 'SELECT, INSERT, UPDATE, DELETE') and
  not has_table_privilege('authenticated', t, 'INSERT, UPDATE, DELETE, TRUNCATE'),
  format('anon has nothing and members only read %s', t)
)
from unnest(array['public.content_items', 'public.content_revisions', 'public.media_references']) as t
order by t;
select ok(
  exists (select 1 from pg_indexes where indexname = 'content_revisions_location_idx' and indexdef ilike '%gist%'),
  'locations have a spatial (GiST) index'
);

-- ── Images used below: one ready+published and one ready-only of A, one of B ─
set local role authenticated;
set local request.jwt.claims to :'a3c';
select asset_id as img_pub, version_id as img_pub_v from public.create_image_upload(:'ta', 'content', 'image/jpeg', 1000) \gset
select asset_id as img_new, version_id as img_new_v from public.create_image_upload(:'ta', 'content', 'image/jpeg', 1000) \gset
set local request.jwt.claims to :'b1c';
select asset_id as img_b, version_id as img_b_v from public.create_image_upload(:'tb', 'content', 'image/jpeg', 1000) \gset
set local role service_role;
set local request.jwt.claims to :'svc';
select public.media_complete_upload(:'img_pub_v', 'image/jpeg', 1000, 1600, 900, :'sha');
select public.media_complete_upload(:'img_new_v', 'image/jpeg', 1000, 1600, 900, :'sha');
select public.media_complete_upload(:'img_b_v', 'image/jpeg', 1000, 1600, 900, :'sha');
select public.media_publish_version(:'ta', :'img_pub', 1);

-- ── Creating ────────────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to :'a3c';
select content_id as d1, revision_id as d1r1 from public.create_content_item(:'ta', 'destination', 'plaza', 'Plaza') \gset
select is((select count(*)::int from public.content_items where tenant_id = :'ta'), 1, 'an editor creates a destination with its first draft');
select throws_ok(format('select * from public.create_content_item(%L, %L, %L, %L)', :'ta', 'destination', 'plaza', 'Otra'), 'PT409', null, 'identifiers are unique per tenant');
select throws_ok(format('select * from public.create_content_item(%L, %L, %L, %L)', :'ta', 'destination', 'Plaza Mayor', 'Plaza'), '23514', null, 'identifiers are lowercase words joined by hyphens');
set local request.jwt.claims to :'a4c';
select throws_ok(format('select * from public.create_content_item(%L, %L, %L, %L)', :'ta', 'destination', 'museo', 'Museo'), '42501', null, 'an analyst cannot create content');
set local request.jwt.claims to :'b1c';
select throws_ok(format('select * from public.create_content_item(%L, %L, %L, %L)', :'ta', 'destination', 'museo', 'Museo'), '42501', null, 'the owner of B cannot create content in A');
select lives_ok(format('select * from public.create_content_item(%L, %L, %L, %L)', :'tb', 'destination', 'plaza', 'Plaza B'), 'B can use the same identifier in its own portal');

-- ── Saving drafts ───────────────────────────────────────────────────────────
set local request.jwt.claims to :'a3c';
select throws_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 1)', :'ta', :'d1',
    '{"title":"Plaza","summary":"","body":[{"type":"html","value":"<script>"}],"location":null,"cover":null,"gallery":[]}'),
  '23514', null, 'unknown block types (e.g. raw HTML) are rejected');
select throws_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 1)', :'ta', :'d1',
    '{"title":"Plaza","summary":"","body":[{"type":"paragraph","children":[{"type":"link","href":"javascript:alert(1)","children":[{"type":"text","text":"x"}]}]}],"location":null,"cover":null,"gallery":[]}'),
  '23514', null, 'only https links are accepted');
select throws_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 1)', :'ta', :'d1',
    '{"title":"Plaza","summary":"","body":[],"location":{"lat":95,"lng":0},"cover":null,"gallery":[]}'),
  '23514', null, 'latitudes are between -90 and 90');
select throws_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 1)', :'ta', :'d1',
    '{"title":"Plaza","summary":"","body":[],"location":null,"cover":null,"gallery":[],"css":"body{}"}'),
  '23514', null, 'unknown fields are rejected');
select throws_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 1)', :'ta', :'d1',
    format('{"title":"Plaza","summary":"","body":[],"location":null,"cover":{"assetId":"%s","version":1,"alt":"Foto"},"gallery":[]}', :'img_b')),
  '23514', null, 'images of another tenant cannot be referenced');
select throws_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 1)', :'ta', :'d1',
    format('{"title":"Plaza","summary":"","body":[],"location":null,"cover":{"assetId":"%s","version":1,"alt":""},"gallery":[]}', :'img_pub')),
  '23514', null, 'images need alternative text');

select is(
  (select edit_count from public.save_content_draft(:'ta', :'d1',
    format('{"title":"Plaza mayor","summary":"","body":%s,"location":{"lat":-17.4,"lng":-66.1},"cover":{"assetId":"%s","version":1,"alt":"Fachada"},"gallery":[{"assetId":"%s","version":1,"alt":"Interior"}]}',
      :'body', :'img_pub', :'img_new')::jsonb, 1)),
  2, 'a valid draft is saved and its edit counter advances');
select throws_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 1)', :'ta', :'d1',
    '{"title":"Plaza","summary":"","body":[],"location":null,"cover":null,"gallery":[]}'),
  'PT409', null, 'saving over a newer draft is a conflict');
select is(
  (select extensions.st_astext(location::extensions.geometry) from public.content_revisions where id = :'d1r1'),
  'POINT(-66.1 -17.4)', 'the location is stored as a PostGIS point (lng lat)');
select is((select count(*)::int from public.media_references where revision_id = :'d1r1'), 2, 'cover and gallery are referenced by asset version');

-- ── Publishing ──────────────────────────────────────────────────────────────
select throws_ok(format('select * from public.publish_content(%L, %L, 2)', :'ta', :'d1'), '42501', null, 'an editor cannot publish');
set local request.jwt.claims to :'a1c';
select throws_ok(format('select * from public.publish_content(%L, %L, 2)', :'ta', :'d1'), '23514', null, 'a destination without summary cannot be published');
select lives_ok(
  format('select * from public.save_content_draft(%L, %L, %L::jsonb, 2)', :'ta', :'d1',
    format('{"title":"Plaza mayor","summary":"El corazón del pueblo","body":%s,"location":{"lat":-17.4,"lng":-66.1},"cover":{"assetId":"%s","version":1,"alt":"Fachada"},"gallery":[{"assetId":"%s","version":1,"alt":"Interior"}]}',
      :'body', :'img_pub', :'img_new')),
  'the owner completes the draft');
select throws_ok(format('select * from public.publish_content(%L, %L, 3)', :'ta', :'d1'), 'PT409', null, 'images without public derivatives block publication');
select lives_ok(
  format('select * from public.save_content_draft(%L, %L, %L::jsonb, 3)', :'ta', :'d1',
    format('{"title":"Plaza mayor","summary":"El corazón del pueblo","body":%s,"location":{"lat":-17.4,"lng":-66.1},"cover":{"assetId":"%s","version":1,"alt":"Fachada"},"gallery":[]}',
      :'body', :'img_pub')),
  'the unpublished image is removed from the gallery');
select throws_ok(format('select * from public.publish_content(%L, %L, 3)', :'ta', :'d1'), 'PT409', null, 'publishing a stale edit is a conflict');
select is((select revision_no from public.publish_content(:'ta', :'d1', 4)), 1, 'the owner publishes revision 1');
select ok(
  (select draft_revision_id is null and published_revision_id = :'d1r1' from public.content_items where id = :'d1'),
  'publishing seals the draft and moves the public pointer');

-- ── Sealed revisions are immutable ─────────────────────────────────────────
reset role;
select throws_ok(format('update public.content_revisions set title = %L where id = %L', 'Cambio', :'d1r1'), '23514', null, 'a sealed revision cannot be edited');
select throws_ok(format('delete from public.content_revisions where id = %L', :'d1r1'), '23514', null, 'a sealed revision cannot be deleted');
select throws_ok(format('delete from public.media_references where revision_id = %L', :'d1r1'), '23514', null, 'images of a sealed revision cannot be removed');

-- ── Anonymous reads ─────────────────────────────────────────────────────────
set local role anon;
select is((select count(*)::int from public.get_published_destination(:'tb', 'plaza')), 0, 'a destination that was never published does not exist for visitors');
select is((select document ->> 'title' from public.get_published_destination(:'ta', 'plaza')), 'Plaza mayor', 'visitors read the published revision');
select is((select document #>> '{cover,alt}' from public.get_published_destination(:'ta', 'plaza')), 'Fachada', 'with its cover and alternative text');
select is((select count(*)::int from public.list_published_destinations(:'tb')), 0, 'drafts are never listed');
select throws_ok('select count(*) from public.content_items', '42501', null, 'visitors cannot read the tables');

-- ── A new draft does not touch the public version ───────────────────────────
set local role authenticated;
set local request.jwt.claims to :'a3c';
select is(
  (select revision_no from public.save_content_draft(:'ta', :'d1',
    format('{"title":"Plaza mayor (renovada)","summary":"Nueva descripción","body":%s,"location":{"lat":-17.41,"lng":-66.11},"cover":null,"gallery":[]}', :'body')::jsonb, null)),
  2, 'editing a published destination opens revision 2');
set local role anon;
select is((select document ->> 'title' from public.get_published_destination(:'ta', 'plaza')), 'Plaza mayor', 'visitors still see revision 1');
set local role authenticated;
set local request.jwt.claims to :'a1c';
select is((select revision_no from public.publish_content(:'ta', :'d1', 1)), 2, 'the owner publishes revision 2');
set local role anon;
select is((select document ->> 'title' from public.get_published_destination(:'ta', 'plaza')), 'Plaza mayor (renovada)', 'visitors see revision 2');

-- ── Rollback ────────────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to :'a3c';
select throws_ok(format('select * from public.restore_content_revision(%L, %L, %L)', :'ta', :'d1', :'d1r1'), '42501', null, 'an editor cannot roll back');
set local request.jwt.claims to :'a1c';
select is((select revision_no from public.restore_content_revision(:'ta', :'d1', :'d1r1')), 1, 'the owner puts revision 1 back');
select throws_ok(format('select * from public.restore_content_revision(%L, %L, %L)', :'ta', :'d1', :'d1r1'), 'PT409', null, 'restoring the live revision is a conflict');
set local role anon;
select is((select document ->> 'title' from public.get_published_destination(:'ta', 'plaza')), 'Plaza mayor', 'visitors see revision 1 again');
select is((select count(*)::int from public.list_published_destinations(:'ta')), 1, 'the rest of the portal is untouched');

-- ── Discarding drafts ───────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to :'a3c';
select content_id as d2 from public.create_content_item(:'ta', 'destination', 'museo', 'Museo') \gset
select throws_ok(format('select public.discard_content_draft(%L, %L, 1)', :'ta', :'d2'), 'PT409', null, 'a never-published destination keeps its draft');
select lives_ok(
  format('select * from public.save_content_draft(%L, %L, %L::jsonb, null)', :'ta', :'d1',
    '{"title":"Borrador","summary":"","body":[],"location":null,"cover":null,"gallery":[]}'),
  'a new draft of the published destination');
select lives_ok(format('select public.discard_content_draft(%L, %L, 1)', :'ta', :'d1'), 'the draft can be discarded');

-- ── Isolation of drafts between members ─────────────────────────────────────
set local request.jwt.claims to :'b1c';
select is((select count(*)::int from public.content_items where tenant_id = :'ta'), 0, 'B does not see the content of A');
select throws_ok(format('select public.content_revision_document(%L, %L)', :'ta', :'d1r1'), 'PT404', null, 'B cannot read revisions of A');
set local request.jwt.claims to :'a5c';
select is((select count(*)::int from public.content_items), 0, 'a revoked member sees nothing');
set local request.jwt.claims to :'a4c';
select is((select count(*)::int from public.content_items where tenant_id = :'ta'), 2, 'an analyst reads the destinations of A');

-- ── Audit and suspension ────────────────────────────────────────────────────
reset role;
select is(
  (select array_agg(action order by occurred_at, action) from public.audit_events where tenant_id = :'ta' and entity_id = :'d1'),
  array['content.created', 'content.published', 'content.published', 'content.restored'],
  'creation, publications and rollback are audited');
update public.tenants set status = 'suspended' where id = :'ta';
set local role anon;
select is((select count(*)::int from public.list_published_destinations(:'ta')), 0, 'a suspended portal publishes nothing');

select * from finish();
rollback;
