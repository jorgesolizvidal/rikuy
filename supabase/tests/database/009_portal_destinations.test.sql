-- Public destination pages: only published revisions of active tenants, image sizes,
-- and the portal hostname for members.
begin;
set local client_min_messages to warning;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

\set ta 'aaaaaaaa-0000-4000-8000-000000000001'
\set tb 'bbbbbbbb-0000-4000-8000-000000000001'
\set a1c '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated"}'
\set b1c '{"sub":"00000000-0000-4000-8000-0000000000b1","role":"authenticated"}'
\set svc '{"role":"service_role"}'
\set sha '0000000000000000000000000000000000000000000000000000000000000abc'

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000a1', 'owner.a@example.test'),
  ('00000000-0000-4000-8000-0000000000b1', 'owner.b@example.test');
insert into public.tenants (id, slug, display_name, status, default_locale, timezone) values
  (:'ta', 'tenant-a', 'Tenant A', 'provisioning', 'es', 'America/La_Paz'),
  (:'tb', 'tenant-b', 'Tenant B', 'provisioning', 'es', 'America/La_Paz');
insert into public.memberships (tenant_id, user_id, role, status, accepted_at) values
  (:'ta', '00000000-0000-4000-8000-0000000000a1', 'owner', 'active', now()),
  (:'tb', '00000000-0000-4000-8000-0000000000b1', 'owner', 'active', now());
insert into public.tenant_domains (id, tenant_id, hostname, kind, status, verified_at) values
  ('aaaaaaaa-0000-4000-8000-0000000000d1', :'ta', 'tenant-a.localhost', 'platform', 'active', now());
update public.tenants set canonical_domain_id = 'aaaaaaaa-0000-4000-8000-0000000000d1' where id = :'ta';
update public.tenants set status = 'active';
set constraints all immediate;

select plan(13);

-- A published destination with a cover and two gallery photos, then a newer draft.
set local role authenticated;
set local request.jwt.claims to :'a1c';
select asset_id as img1, version_id as img1_v from public.create_image_upload(:'ta', 'content', 'image/jpeg', 1000) \gset
select asset_id as img2, version_id as img2_v from public.create_image_upload(:'ta', 'content', 'image/jpeg', 1000) \gset
set local role service_role;
set local request.jwt.claims to :'svc';
select public.media_complete_upload(:'img1_v', 'image/jpeg', 1000, 2400, 1600, :'sha');
select public.media_complete_upload(:'img2_v', 'image/jpeg', 1000, 800, 1200, :'sha');
select public.media_publish_version(:'ta', :'img1', 1);
select public.media_publish_version(:'ta', :'img2', 1);
set local role authenticated;
set local request.jwt.claims to :'a1c';
select content_id as d1 from public.create_content_item(:'ta', 'destination', 'plaza', 'Plaza') \gset
select public.save_content_draft(:'ta', :'d1', format(
  '{"title":"Plaza","summary":"La plaza","body":[{"type":"paragraph","children":[{"type":"text","text":"Hola"}]}],"location":{"lat":-17.4,"lng":-66.1},"cover":{"assetId":"%s","version":1,"alt":"Fachada"},"gallery":[{"assetId":"%s","version":1,"alt":"Retrato"},{"assetId":"%s","version":1,"alt":"Otra vista"}]}',
  :'img1', :'img2', :'img1')::jsonb, 1);
select public.publish_content(:'ta', :'d1', 2);
select public.save_content_draft(:'ta', :'d1',
  '{"title":"Plaza (borrador)","summary":"Cambio sin publicar","body":[],"location":null,"cover":null,"gallery":[]}'::jsonb, null);
select content_id as d2 from public.create_content_item(:'ta', 'destination', 'museo', 'Museo') \gset

-- ── Anonymous portal reads ─────────────────────────────────────────────────
set local role anon;
select is((select count(*)::int from public.portal_destinations(:'ta')), 1, 'only published destinations are listed');
select is((select title from public.portal_destinations(:'ta')), 'Plaza', 'the list shows the published title, not the draft');
select is((select (cover ->> 'width')::int from public.portal_destinations(:'ta')), 2400, 'covers carry their width');
select is((select (cover ->> 'height')::int from public.portal_destinations(:'ta')), 1600, 'and their height');
select is((select summary from public.portal_destination(:'ta', 'plaza')), 'La plaza', 'the page shows the published revision');
select is(
  (select jsonb_agg(g ->> 'alt') from public.portal_destination(:'ta', 'plaza'), jsonb_array_elements(gallery) g),
  '["Retrato", "Otra vista"]'::jsonb, 'the gallery keeps its order and alternative texts');
select is((select (gallery -> 0 ->> 'height')::int from public.portal_destination(:'ta', 'plaza')), 1200, 'gallery images carry their size');
select is((select count(*)::int from public.portal_destination(:'ta', 'museo')), 0, 'a never-published destination has no page');
select is((select count(*)::int from public.portal_destination(:'tb', 'plaza')), 0, 'another tenant cannot serve it under its own host');
select ok(not has_function_privilege('anon', 'public.tenant_portal_host(uuid)', 'EXECUTE'), 'visitors do not call the member-only host lookup');

-- ── Portal host for members ────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to :'a1c';
select is(public.tenant_portal_host(:'ta'), 'tenant-a.localhost', 'a member gets the canonical portal host');
set local request.jwt.claims to :'b1c';
select is(public.tenant_portal_host(:'ta'), null, 'a member of another tenant gets nothing');

-- ── Suspension hides everything ────────────────────────────────────────────
reset role;
update public.tenants set status = 'suspended' where id = :'ta';
set local role anon;
select is((select count(*)::int from public.portal_destinations(:'ta')), 0, 'a suspended portal lists nothing');

select * from finish();
rollback;
