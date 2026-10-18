-- White-label presentation: shape validation, draft → publish RPCs, roles and isolation.
begin;
set local client_min_messages to warning;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

\set brand_a '{"identity":{"siteName":"Tenant A","shortName":"A","tagline":""},"theme":{"mode":"light","brand":"#1f6f4a","accent":"#a06f12"},"contact":{"email":"hola@a.example.test"},"social":[{"network":"tiktok","url":"https://tiktok.com/@tenant-a"}],"seo":{"description":"Portal A"}}'
\set brand_a2 '{"identity":{"siteName":"Tenant A v2","shortName":"A2","tagline":"Nuevo"},"theme":{"mode":"dark","brand":"#f0a868","accent":"#7fb7d9"},"contact":{},"social":[],"seo":{"description":""}}'
\set brand_b '{"identity":{"siteName":"Tenant B","shortName":"B","tagline":""},"theme":{"mode":"light","brand":"#1e3a8a","accent":"#b45309"},"contact":{},"social":[],"seo":{"description":""}}'

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000a1', 'owner.a@example.test'),
  ('00000000-0000-4000-8000-0000000000a2', 'admin.a@example.test'),
  ('00000000-0000-4000-8000-0000000000a3', 'editor.a@example.test'),
  ('00000000-0000-4000-8000-0000000000a4', 'analyst.a@example.test'),
  ('00000000-0000-4000-8000-0000000000a5', 'revoked.a@example.test'),
  ('00000000-0000-4000-8000-0000000000b1', 'owner.b@example.test');

insert into public.tenants (id, slug, display_name, status, default_locale, timezone) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'tenant-a', 'Tenant A', 'provisioning', 'es', 'America/La_Paz'),
  ('bbbbbbbb-0000-4000-8000-000000000001', 'tenant-b', 'Tenant B', 'provisioning', 'es', 'America/La_Paz');

insert into public.memberships (tenant_id, user_id, role, status, accepted_at, revoked_at) values
  ('aaaaaaaa-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a1', 'owner', 'active', now(), null),
  ('aaaaaaaa-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a2', 'admin', 'active', now(), null),
  ('aaaaaaaa-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a3', 'editor', 'active', now(), null),
  ('aaaaaaaa-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a4', 'analyst', 'active', now(), null),
  ('aaaaaaaa-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a5', 'admin', 'revoked', now(), now()),
  ('bbbbbbbb-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000b1', 'owner', 'active', now(), null);

insert into public.tenant_config_versions (id, tenant_id, version, state, sealed_at, branding) values
  ('cccccccc-0000-4000-8000-00000000000a', 'aaaaaaaa-0000-4000-8000-000000000001', 1, 'sealed', now(), :'brand_a'),
  ('cccccccc-0000-4000-8000-00000000000b', 'bbbbbbbb-0000-4000-8000-000000000001', 1, 'sealed', now(), :'brand_b');

update public.tenants set status = 'active', active_config_id = 'cccccccc-0000-4000-8000-00000000000a'
where id = 'aaaaaaaa-0000-4000-8000-000000000001';
update public.tenants set status = 'active', active_config_id = 'cccccccc-0000-4000-8000-00000000000b'
where id = 'bbbbbbbb-0000-4000-8000-000000000001';

set constraints all immediate;

select plan(41);

-- ── Privileges ──────────────────────────────────────────────────────────────
select ok(not has_function_privilege('anon', 'public.save_tenant_config_draft(uuid, jsonb, integer)', 'EXECUTE'), 'anon cannot save drafts');
select ok(not has_function_privilege('anon', 'public.publish_tenant_config(uuid, uuid, integer)', 'EXECUTE'), 'anon cannot publish');
select ok(has_function_privilege('anon', 'public.get_published_presentation(uuid)', 'EXECUTE'), 'anon can read the published presentation');
select ok(has_function_privilege('authenticated', 'public.save_tenant_config_draft(uuid, jsonb, integer)', 'EXECUTE'), 'authenticated can call the draft RPC (roles checked inside)');
select ok(not has_function_privilege('public', 'private.is_valid_presentation(jsonb)', 'EXECUTE'), 'PUBLIC cannot execute the validator');

-- ── Shape is enforced by the database itself ───────────────────────────────
select throws_ok(
  format($$insert into public.tenant_config_versions (tenant_id, version, branding) values ('bbbbbbbb-0000-4000-8000-000000000001', 10, %L)$$,
    replace(:'brand_b', '#1e3a8a', 'red')),
  '23514', null, 'named colors are rejected'
);
select throws_ok(
  format($$insert into public.tenant_config_versions (tenant_id, version, branding) values ('bbbbbbbb-0000-4000-8000-000000000001', 10, %L)$$,
    replace(:'brand_b', '#1e3a8a', '#fff;}body{display:none')),
  '23514', null, 'CSS cannot be smuggled through a color'
);
select throws_ok(
  format($$insert into public.tenant_config_versions (tenant_id, version, branding) values ('bbbbbbbb-0000-4000-8000-000000000001', 10, %L)$$,
    jsonb_set(:'brand_b'::jsonb, '{html}', '"<script>"')),
  '23514', null, 'unknown keys are rejected'
);
select throws_ok(
  format($$insert into public.tenant_config_versions (tenant_id, version, branding) values ('bbbbbbbb-0000-4000-8000-000000000001', 10, %L)$$,
    jsonb_set(:'brand_b'::jsonb, '{social}', '[{"network":"x","url":"javascript:alert(1)"}]')),
  '23514', null, 'only https links are accepted'
);
select throws_ok(
  format($$insert into public.tenant_config_versions (tenant_id, version, branding) values ('bbbbbbbb-0000-4000-8000-000000000001', 10, %L)$$,
    jsonb_set(:'brand_b'::jsonb, '{social}', '[{"network":"x","url":"https://x.com/a"},{"network":"x","url":"https://x.com/b"}]')),
  '23514', null, 'one link per network'
);
select throws_ok(
  format($$insert into public.tenant_config_versions (tenant_id, version, branding) values ('bbbbbbbb-0000-4000-8000-000000000001', 10, %L)$$,
    jsonb_set(:'brand_b'::jsonb, '{identity,shortName}', '"Nombre demasiado largo"')),
  '23514', null, 'length limits are enforced'
);
select throws_ok(
  format($$insert into public.tenant_config_versions (tenant_id, version, branding) values ('bbbbbbbb-0000-4000-8000-000000000001', 10, %L)$$,
    jsonb_set(:'brand_b'::jsonb, '{identity,tagline}', to_jsonb(E'dos\nlineas'::text))),
  '23514', null, 'control characters are rejected'
);
select lives_ok(
  $$insert into public.tenant_config_versions (id, tenant_id, version) values ('cccccccc-0000-4000-8000-0000000000b2', 'bbbbbbbb-0000-4000-8000-000000000001', 2)$$,
  'an empty draft ({}) is allowed'
);
select throws_ok(
  $$insert into public.tenant_config_versions (tenant_id, version) values ('bbbbbbbb-0000-4000-8000-000000000001', 3)$$,
  '23505', null, 'a tenant has at most one draft'
);
delete from public.tenant_config_versions where id = 'cccccccc-0000-4000-8000-0000000000b2';

-- ── Anonymous portal read ───────────────────────────────────────────────────
set local role anon;
select is(
  (select branding #>> '{identity,siteName}' from public.get_published_presentation('cccccccc-0000-4000-8000-00000000000a')),
  'Tenant A', 'anon reads the active presentation of A'
);
select throws_ok('select * from public.tenant_config_versions', '42501', null, 'anon cannot read config versions directly');
reset role;

-- ── Roles that may not manage the brand ────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000a3","role":"authenticated"}';
select throws_ok(
  format('select * from public.save_tenant_config_draft(%L, %L, null)', 'aaaaaaaa-0000-4000-8000-000000000001', :'brand_a2'),
  '42501', null, 'an editor cannot save the brand'
);
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000a4","role":"authenticated"}';
select throws_ok(
  format('select * from public.save_tenant_config_draft(%L, %L, null)', 'aaaaaaaa-0000-4000-8000-000000000001', :'brand_a2'),
  '42501', null, 'an analyst cannot save the brand'
);
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000a5","role":"authenticated"}';
select throws_ok(
  format('select * from public.save_tenant_config_draft(%L, %L, null)', 'aaaaaaaa-0000-4000-8000-000000000001', :'brand_a2'),
  '42501', null, 'a revoked admin cannot save the brand'
);
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select throws_ok(
  format('select * from public.save_tenant_config_draft(%L, %L, null)', 'aaaaaaaa-0000-4000-8000-000000000001', :'brand_a2'),
  '42501', null, 'the owner of B cannot save the brand of A'
);

-- ── Owner of A edits a draft with optimistic concurrency ───────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
select results_eq(
  format('select version, revision from public.save_tenant_config_draft(%L, %L, null)', 'aaaaaaaa-0000-4000-8000-000000000001', :'brand_a2'),
  $$values (2, 1)$$, 'first save creates draft version 2, revision 1'
);
select results_eq(
  format('select version, revision from public.save_tenant_config_draft(%L, %L, 1)', 'aaaaaaaa-0000-4000-8000-000000000001', :'brand_a2'),
  $$values (2, 2)$$, 'saving with the current revision updates the same draft'
);
select throws_ok(
  format('select * from public.save_tenant_config_draft(%L, %L, 1)', 'aaaaaaaa-0000-4000-8000-000000000001', :'brand_a2'),
  'PT409', null, 'a stale revision is a conflict'
);
select throws_ok(
  format('select * from public.save_tenant_config_draft(%L, %L, null)', 'aaaaaaaa-0000-4000-8000-000000000001', :'brand_a2'),
  'PT409', null, 'expecting no draft while one exists is a conflict'
);
select throws_ok(
  format('select * from public.save_tenant_config_draft(%L, %L, 2)', 'aaaaaaaa-0000-4000-8000-000000000001', '{"identity":{}}'),
  '23514', null, 'the RPC rejects an invalid presentation'
);

-- The owner of B cannot see, nor publish, the draft of A.
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select is(
  (select count(*)::int from public.tenant_config_versions where tenant_id = 'aaaaaaaa-0000-4000-8000-000000000001'),
  0, 'B cannot read any configuration of A'
);
select throws_ok(
  format('select * from public.publish_tenant_config(%L, (select id from public.tenant_config_versions limit 0), 2)', 'aaaaaaaa-0000-4000-8000-000000000001'),
  '42501', null, 'B cannot publish for A'
);
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000a3","role":"authenticated"}';
select is(
  (select count(*)::int from public.tenant_config_versions where state = 'draft'),
  1, 'an editor of A can read the draft of A'
);
select throws_ok(
  $$select * from public.publish_tenant_config('aaaaaaaa-0000-4000-8000-000000000001', (select id from public.tenant_config_versions where state = 'draft'), 2)$$,
  '42501', null, 'an editor cannot publish'
);

-- ── Admin of A publishes ────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000a2","role":"authenticated"}';
select throws_ok(
  $$select * from public.publish_tenant_config('aaaaaaaa-0000-4000-8000-000000000001', (select id from public.tenant_config_versions where state = 'draft'), 1)$$,
  'PT409', null, 'publishing a stale revision is a conflict'
);
select throws_ok(
  $$select * from public.publish_tenant_config('aaaaaaaa-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-00000000000b', 1)$$,
  'PT404', null, 'a configuration of another tenant is not found'
);
select results_eq(
  $$select version from public.publish_tenant_config('aaaaaaaa-0000-4000-8000-000000000001', (select id from public.tenant_config_versions where state = 'draft'), 2)$$,
  $$values (2)$$, 'the admin publishes version 2'
);
select is(
  (select c.version from public.tenants t join public.tenant_config_versions c on c.id = t.active_config_id
   where t.id = 'aaaaaaaa-0000-4000-8000-000000000001'),
  2, 'the tenant now points at version 2'
);
select is(
  (select count(*)::int from public.tenant_config_versions where state = 'draft'),
  0, 'no draft remains after publishing'
);
select results_eq(
  $$select action, actor_id, revision from public.audit_events where action = 'tenant.config.published'$$,
  $$values ('tenant.config.published'::text, '00000000-0000-4000-8000-0000000000a2'::uuid, 2)$$,
  'publishing is audited with the actor and version'
);
select throws_ok(
  $$select * from public.publish_tenant_config('aaaaaaaa-0000-4000-8000-000000000001', (select id from public.tenant_config_versions where version = 2), 2)$$,
  'PT409', null, 'a sealed version cannot be published again'
);
reset role;

-- ── Public read after publishing ───────────────────────────────────────────
set local role anon;
select is(
  (select count(*)::int from public.get_published_presentation('cccccccc-0000-4000-8000-00000000000a')),
  0, 'a superseded version is no longer public'
);
reset role;
select is(
  (select p.branding #>> '{identity,siteName}' from public.tenants t,
     lateral public.get_published_presentation(t.active_config_id) p
   where t.id = 'aaaaaaaa-0000-4000-8000-000000000001'),
  'Tenant A v2', 'the new version is served for A'
);
select is(
  (select branding #>> '{identity,siteName}' from public.get_published_presentation('cccccccc-0000-4000-8000-00000000000b')),
  'Tenant B', 'B is unaffected'
);

-- ── Suspended tenants are read-only ─────────────────────────────────────────
update public.tenants set status = 'suspended' where id = 'aaaaaaaa-0000-4000-8000-000000000001';
select is(
  (select count(*)::int from public.get_published_presentation(
    (select active_config_id from public.tenants where id = 'aaaaaaaa-0000-4000-8000-000000000001'))),
  0, 'a suspended tenant serves no presentation'
);
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
select throws_ok(
  format('select * from public.save_tenant_config_draft(%L, %L, null)', 'aaaaaaaa-0000-4000-8000-000000000001', :'brand_a2'),
  '42501', null, 'the owner of a suspended tenant cannot change the brand'
);
reset role;

select * from finish();
rollback;
