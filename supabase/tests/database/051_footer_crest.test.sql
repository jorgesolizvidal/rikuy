-- The coat of arms in the portal's footer (fix/interface-details, ADR-068): an optional
-- `crest` in the brand, a reference to a logo-type image of the same tenant, like the logo.
begin;
set local client_min_messages to warning;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

\set ta 'aaaaaaaa-0000-4000-8000-000000000001'
\set tb 'bbbbbbbb-0000-4000-8000-000000000001'
\set a1c '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}'
\set a3c '{"sub":"00000000-0000-4000-8000-0000000000a3","role":"authenticated","aal":"aal2"}'
\set b1c '{"sub":"00000000-0000-4000-8000-0000000000b1","role":"authenticated","aal":"aal2"}'
\set svc '{"role":"service_role"}'
\set sha '0000000000000000000000000000000000000000000000000000000000000abc'
\set brand '{"identity":{"siteName":"Tenant A","shortName":"A","tagline":""},"theme":{"mode":"light","brand":"#1f6f4a","accent":"#a06f12"},"contact":{},"social":[],"seo":{"description":""}}'

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000a1', 'owner.a@example.test'),
  ('00000000-0000-4000-8000-0000000000a3', 'editor.a@example.test'),
  ('00000000-0000-4000-8000-0000000000b1', 'owner.b@example.test');
insert into public.tenants (id, slug, display_name, status, default_locale, timezone) values
  (:'ta', 'tenant-a', 'Tenant A', 'provisioning', 'es', 'America/La_Paz'),
  (:'tb', 'tenant-b', 'Tenant B', 'provisioning', 'es', 'America/La_Paz');
insert into public.memberships (tenant_id, user_id, role, status, accepted_at) values
  (:'ta', '00000000-0000-4000-8000-0000000000a1', 'owner', 'active', now()),
  (:'ta', '00000000-0000-4000-8000-0000000000a3', 'editor', 'active', now()),
  (:'tb', '00000000-0000-4000-8000-0000000000b1', 'owner', 'active', now());
update public.tenants set status = 'active';
set constraints all immediate;

select plan(17);

-- ── Shape ───────────────────────────────────────────────────────────────────
select ok(private.is_valid_presentation(:'brand'::jsonb),
  'a brand without a crest stays valid');
select ok(private.is_valid_presentation(jsonb_set(:'brand'::jsonb, '{crest}',
    '{"assetId":"aaaaaaaa-0000-4000-8000-0000000000ff","version":1}'::jsonb)),
  'a crest is a reference {assetId, version}');
select ok(not private.is_valid_presentation(jsonb_set(:'brand'::jsonb, '{crest}',
    '{"assetId":"https://evil.example/escudo.png","version":1}'::jsonb)),
  'a crest is never a URL');
select ok(not private.is_valid_presentation(jsonb_set(:'brand'::jsonb, '{crest}',
    '{"assetId":"aaaaaaaa-0000-4000-8000-0000000000ff","version":1,"alt":"x"}'::jsonb)),
  'the crest reference has no extra fields');
select ok(not private.is_valid_presentation(jsonb_set(:'brand'::jsonb, '{crest}',
    '{"assetId":"aaaaaaaa-0000-4000-8000-0000000000ff","version":0}'::jsonb)),
  'versions start at 1');

-- ── Images: a logo-type one of A, a photo of A and a logo-type one of B ─────
set local role authenticated;
set local request.jwt.claims to :'a1c';
select asset_id as crest_asset, version_id as crest_version
from public.create_image_upload(:'ta', 'logo', 'image/png', 12345) \gset
select asset_id as photo_asset, version_id as photo_version
from public.create_image_upload(:'ta', 'content', 'image/jpeg', 12345) \gset
set local request.jwt.claims to :'b1c';
select asset_id as b_asset, version_id as b_version
from public.create_image_upload(:'tb', 'logo', 'image/png', 100) \gset
reset role;

set local role authenticated;
set local request.jwt.claims to :'a1c';
select throws_ok(
  format('select * from public.save_tenant_config_draft(%L, %L, null)', :'ta',
    jsonb_set(:'brand'::jsonb, '{crest}', jsonb_build_object('assetId', :'crest_asset', 'version', 1))),
  '23514', null, 'the brand cannot use a crest that is still uploading'
);
reset role;

set local role service_role;
set local request.jwt.claims to :'svc';
select public.media_complete_upload(:'crest_version', 'image/png', 10, 256, 256, :'sha');
select public.media_complete_upload(:'photo_version', 'image/jpeg', 10, 1600, 1067, :'sha');
select public.media_complete_upload(:'b_version', 'image/png', 10, 64, 64, :'sha');
reset role;

-- ── Saving and publishing ───────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to :'a1c';
select throws_ok(
  format('select * from public.save_tenant_config_draft(%L, %L, null)', :'ta',
    jsonb_set(:'brand'::jsonb, '{crest}', jsonb_build_object('assetId', :'photo_asset', 'version', 1))),
  '23514', null, 'a content photo cannot be the crest'
);
select throws_ok(
  format('select * from public.save_tenant_config_draft(%L, %L, null)', :'ta',
    jsonb_set(:'brand'::jsonb, '{crest}', jsonb_build_object('assetId', :'b_asset', 'version', 1))),
  '23514', null, 'A cannot use the image of B as its crest'
);
select lives_ok(
  format('select * from public.save_tenant_config_draft(%L, %L, null)', :'ta',
    jsonb_set(:'brand'::jsonb, '{crest}', jsonb_build_object('assetId', :'crest_asset', 'version', 1))),
  'the owner saves a draft with a ready crest'
);
select throws_ok(
  format($$select * from public.publish_tenant_config(%L, (select id from public.tenant_config_versions where tenant_id = %L and state = 'draft'), 1)$$, :'ta', :'ta'),
  'PT409', null, 'the brand is not published before the crest derivatives are public'
);
reset role;

set local role authenticated;
set local request.jwt.claims to :'a3c';
select throws_ok(
  format('select * from public.save_tenant_config_draft(%L, %L, 1)', :'ta',
    jsonb_set(:'brand'::jsonb, '{crest}', jsonb_build_object('assetId', :'crest_asset', 'version', 1))),
  '42501', null, 'an editor cannot change the brand'
);
reset role;

set local role service_role;
set local request.jwt.claims to :'svc';
select public.media_publish_version(:'ta', :'crest_asset', 1);
reset role;

set local role authenticated;
set local request.jwt.claims to :'a1c';
select lives_ok(
  format($$select * from public.publish_tenant_config(%L, (select id from public.tenant_config_versions where tenant_id = %L and state = 'draft'), 1)$$, :'ta', :'ta'),
  'with public derivatives, the brand with its crest is published'
);
reset role;
select is(
  (select c.branding #>> '{crest,assetId}' from public.tenants t
    join public.tenant_config_versions c on c.id = t.active_config_id where t.id = :'ta'),
  :'crest_asset', 'the published brand points at the crest'
);

-- ── The daily sweep of unused images keeps a crest in use ───────────────────
update public.asset_versions set ready_at = now() - interval '8 days'
where id in (:'crest_version', :'photo_version');
select ok(not private.is_unused_media(:'crest_version'), 'a crest used by a brand version is not unused');
select ok(private.is_unused_media(:'photo_version'), 'an old photo nothing uses still is');

set local role anon;
select throws_ok(
  format('select private.is_unused_media(%L)', :'crest_version'),
  '42501', null, 'visitors cannot call the private checks'
);
reset role;

select * from finish();
rollback;
