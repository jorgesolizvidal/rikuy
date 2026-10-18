-- Tenant media: upload lifecycle, Storage policies and the logo reference in the brand.
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
\set svc '{"role":"service_role"}'
\set sha '0000000000000000000000000000000000000000000000000000000000000abc'
\set brand '{"identity":{"siteName":"Tenant A","shortName":"A","tagline":""},"theme":{"mode":"light","brand":"#1f6f4a","accent":"#a06f12"},"contact":{},"social":[],"seo":{"description":""}}'

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

select plan(41);

-- ── Buckets and privileges ──────────────────────────────────────────────────
select is((select public from storage.buckets where id = 'media-originals'), false, 'originals are private');
select is((select public from storage.buckets where id = 'media-public'), true, 'derivatives bucket is public');
select ok(not exists (select 1 from storage.buckets where id = 'media-originals' and 'image/svg+xml' = any (allowed_mime_types)), 'SVG (scriptable) is not accepted');
select ok(not has_function_privilege('anon', 'public.create_image_upload(uuid, public.asset_purpose, text, integer)', 'EXECUTE'), 'anon cannot start uploads');
select ok(not has_function_privilege('authenticated', 'public.media_complete_upload(uuid, text, integer, integer, integer, text)', 'EXECUTE'), 'people cannot mark images as ready');
select ok(not has_function_privilege('authenticated', 'public.media_publish_version(uuid, uuid, integer)', 'EXECUTE'), 'people cannot publish images directly');

-- ── Starting uploads ────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to :'a1c';
select asset_id as logo_asset, version_id as logo_version, original_path as logo_path
from public.create_image_upload(:'ta', 'logo', 'image/png', 12345) \gset
select ok(:'logo_path' = :'ta' || '/' || :'logo_asset' || '/1/original', 'paths are {tenant}/{asset}/{version}/original');
select throws_ok(format('select * from public.create_image_upload(%L, %L, %L, %L)', :'ta', 'logo', 'image/svg+xml', 100), '23514', null, 'SVG uploads are rejected');
select throws_ok(format('select * from public.create_image_upload(%L, %L, %L, %L)', :'ta', 'logo', 'image/png', 0), '23514', null, 'empty uploads are rejected');
select throws_ok(format('select * from public.create_image_upload(%L, %L, %L, %L)', :'ta', 'logo', 'image/png', 20000000), '23514', null, 'oversized uploads are rejected');

set local request.jwt.claims to :'a3c';
select throws_ok(format('select * from public.create_image_upload(%L, %L, %L, %L)', :'ta', 'logo', 'image/png', 100), '42501', null, 'an editor cannot upload the logo');
select lives_ok(format('select * from public.create_image_upload(%L, %L, %L, %L)', :'ta', 'content', 'image/jpeg', 100), 'an editor can upload content images');
set local request.jwt.claims to :'a4c';
select throws_ok(format('select * from public.create_image_upload(%L, %L, %L, %L)', :'ta', 'content', 'image/jpeg', 100), '42501', null, 'an analyst cannot upload');
set local request.jwt.claims to :'b1c';
select throws_ok(format('select * from public.create_image_upload(%L, %L, %L, %L)', :'ta', 'logo', 'image/png', 100), '42501', null, 'the owner of B cannot upload for A');

-- ── Storage policies ────────────────────────────────────────────────────────
set local request.jwt.claims to :'b1c';
select throws_ok(
  format($$insert into storage.objects (bucket_id, name) values ('media-originals', %L)$$, :'logo_path'),
  '42501', null, 'B cannot write the original of A'
);
set local request.jwt.claims to :'a1c';
select lives_ok(
  format($$insert into storage.objects (bucket_id, name) values ('media-originals', %L)$$, :'logo_path'),
  'the owner writes the original at the exact path of the pending version'
);
select throws_ok(
  format($$insert into storage.objects (bucket_id, name) values ('media-originals', %L)$$, :'ta' || '/' || :'logo_asset' || '/1/logo.webp'),
  '42501', null, 'nobody writes derivatives by hand'
);
select throws_ok(
  format($$insert into storage.objects (bucket_id, name) values ('media-public', %L)$$, :'ta' || '/' || :'logo_asset' || '/1/logo.webp'),
  '42501', null, 'nobody writes the public bucket'
);
select throws_ok(
  format($$insert into storage.objects (bucket_id, name) values ('media-originals', %L)$$, :'ta' || '/x/1/original'),
  '42501', null, 'arbitrary paths inside the tenant folder are rejected'
);
select is((select count(*)::int from storage.objects where bucket_id = 'media-originals'), 1, 'the owner reads the originals of A');
set local request.jwt.claims to :'a4c';
select is((select count(*)::int from storage.objects where bucket_id = 'media-originals'), 1, 'an analyst of A can read them too');
select is((select count(*)::int from public.asset_versions), 2, 'members see the image versions of A');
set local request.jwt.claims to :'b1c';
select is((select count(*)::int from storage.objects where bucket_id = 'media-originals'), 0, 'B reads nothing of A');
select is((select count(*)::int from public.asset_versions), 0, 'B sees no image versions of A');
reset role;
set local role anon;
select is((select count(*)::int from storage.objects), 0, 'visitors read no originals');
reset role;

-- ── Lifecycle (service role) ────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to :'a1c';
select throws_ok(
  format('select public.media_complete_upload(%L, %L, 1, 1, 1, %L)', :'logo_version', 'image/png', :'sha'),
  '42501', null, 'the owner cannot mark the upload as ready'
);
-- A logo that is not ready cannot be referenced by the brand.
select throws_ok(
  format('select * from public.save_tenant_config_draft(%L, %L, null)', :'ta',
    jsonb_set(:'brand'::jsonb, '{logo}', jsonb_build_object('assetId', :'logo_asset', 'version', 1))),
  '23514', null, 'the brand cannot use an image that is still uploading'
);
reset role;

set local role service_role;
set local request.jwt.claims to :'svc';
select throws_ok(
  format('select public.media_complete_upload(%L, %L, 10, 64, 64, %L)', :'logo_version', 'image/png', 'not-a-hash'),
  '23514', null, 'a ready image needs complete metadata'
);
select lives_ok(
  format('select public.media_complete_upload(%L, %L, 10, 256, 128, %L)', :'logo_version', 'image/png', :'sha'),
  'the media adapter marks the validated upload as ready'
);
select throws_ok(
  format('select public.media_complete_upload(%L, %L, 10, 256, 128, %L)', :'logo_version', 'image/png', :'sha'),
  'PT409', null, 'an image is completed only once'
);
select throws_ok(format('select public.media_reject_upload(%L, %L)', :'logo_version', 'late'), 'PT409', null, 'a ready image cannot be rejected');
reset role;

-- ── Logo in the brand ───────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to :'a1c';
select lives_ok(
  format('select * from public.save_tenant_config_draft(%L, %L, null)', :'ta',
    jsonb_set(:'brand'::jsonb, '{logo}', jsonb_build_object('assetId', :'logo_asset', 'version', 1))),
  'the owner saves a draft that uses the ready logo'
);
select throws_ok(
  format($$select * from public.publish_tenant_config(%L, (select id from public.tenant_config_versions where tenant_id = %L and state = 'draft'), 1)$$, :'ta', :'ta'),
  'PT409', null, 'the brand cannot be published before the logo derivatives are public'
);
select throws_ok(
  format('select * from public.save_tenant_config_draft(%L, %L, 1)', :'ta',
    jsonb_set(:'brand'::jsonb, '{logo}', '{"assetId":"https://evil.example/logo.png","version":1}'::jsonb)),
  '23514', null, 'a logo is a reference, never a URL'
);
select throws_ok(
  format('select * from public.save_tenant_config_draft(%L, %L, 1)', :'ta',
    jsonb_set(:'brand'::jsonb, '{logo}', jsonb_build_object('assetId', :'logo_asset', 'version', 1, 'src', 'x'))),
  '23514', null, 'the logo reference has no extra fields'
);
reset role;

-- B's ready logo cannot be used by A.
set local role authenticated;
set local request.jwt.claims to :'b1c';
select asset_id as b_asset, version_id as b_version from public.create_image_upload(:'tb', 'logo', 'image/png', 100) \gset
reset role;
set local role service_role;
set local request.jwt.claims to :'svc';
select public.media_complete_upload(:'b_version', 'image/png', 10, 64, 64, :'sha');
reset role;
set local role authenticated;
set local request.jwt.claims to :'a1c';
select throws_ok(
  format('select * from public.save_tenant_config_draft(%L, %L, 1)', :'ta',
    jsonb_set(:'brand'::jsonb, '{logo}', jsonb_build_object('assetId', :'b_asset', 'version', 1))),
  '23514', null, 'A cannot reference the logo of B'
);
reset role;

set local role service_role;
set local request.jwt.claims to :'svc';
select throws_ok(format('select public.media_publish_version(%L, %L, 2)', :'ta', :'logo_asset'), 'PT404', null, 'unknown versions cannot be published');
select lives_ok(format('select public.media_publish_version(%L, %L, 1)', :'ta', :'logo_asset'), 'the media adapter publishes the logo derivatives');
reset role;

set local role authenticated;
set local request.jwt.claims to :'a1c';
select lives_ok(
  format($$select * from public.publish_tenant_config(%L, (select id from public.tenant_config_versions where tenant_id = %L and state = 'draft'), 1)$$, :'ta', :'ta'),
  'with public derivatives, the brand is published'
);
reset role;
select is(
  (select c.branding #>> '{logo,assetId}' from public.tenants t join public.tenant_config_versions c on c.id = t.active_config_id where t.id = :'ta'),
  :'logo_asset', 'the published brand points at the logo'
);

-- ── Abuse guard ─────────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to :'a1c';
select throws_ok(
  format('do $do$ begin for i in 1..25 loop perform * from public.create_image_upload(%L::uuid, ''content'', ''image/jpeg'', 100); end loop; end $do$', :'ta'),
  'PT429', null, 'at most 20 pending uploads per tenant per hour'
);
reset role;

select * from finish();
rollback;
