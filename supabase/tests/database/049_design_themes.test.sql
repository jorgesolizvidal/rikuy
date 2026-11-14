-- Portal themes (ADR-061): an optional style in the presentation, one of two fixed values;
-- «immersive» only on a dark background. Older presentations without it stay valid.
begin;
set local client_min_messages to warning;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

\set head '{"identity":{"siteName":"Tenant A","shortName":"A","tagline":""},"theme":'
\set tail ',"contact":{},"social":[],"seo":{"description":""}}'

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000a1', 'owner.a@example.test'),
  ('00000000-0000-4000-8000-0000000000a2', 'editor.a@example.test'),
  ('00000000-0000-4000-8000-0000000000b1', 'owner.b@example.test');
insert into public.tenants (id, slug, display_name, status, default_locale, timezone) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'tenant-a', 'Tenant A', 'provisioning', 'es', 'America/La_Paz'),
  ('bbbbbbbb-0000-4000-8000-000000000001', 'tenant-b', 'Tenant B', 'provisioning', 'es', 'America/La_Paz');
insert into public.memberships (tenant_id, user_id, role, status, accepted_at) values
  ('aaaaaaaa-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a1', 'owner', 'active', now()),
  ('aaaaaaaa-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a2', 'editor', 'active', now()),
  ('bbbbbbbb-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000b1', 'owner', 'active', now());

set constraints all immediate;

select plan(18);

-- ── Shape of the style ─────────────────────────────────────────────────────
select ok(private.is_valid_presentation((:'head' || '{"mode":"light","brand":"#14532d","accent":"#b45309"}' || :'tail')::jsonb),
  'without a style (older presentations: editorial)');
select ok(private.is_valid_presentation((:'head' || '{"style":"editorial","mode":"light","brand":"#14532d","accent":"#b45309"}' || :'tail')::jsonb),
  'editorial on a light background');
select ok(private.is_valid_presentation((:'head' || '{"style":"editorial","mode":"dark","brand":"#f0a868","accent":"#7fb7d9"}' || :'tail')::jsonb),
  'editorial on a dark background');
select ok(private.is_valid_presentation((:'head' || '{"style":"immersive","mode":"dark","brand":"#f0a868","accent":"#7fb7d9"}' || :'tail')::jsonb),
  'immersive on a dark background');
select ok(not private.is_valid_presentation((:'head' || '{"style":"immersive","mode":"light","brand":"#14532d","accent":"#b45309"}' || :'tail')::jsonb),
  'immersive on a light background is rejected');
select ok(not private.is_valid_presentation((:'head' || '{"style":"brutalist","mode":"dark","brand":"#f0a868","accent":"#7fb7d9"}' || :'tail')::jsonb),
  'an unknown style is rejected');
select ok(not private.is_valid_presentation((:'head' || '{"style":"Immersive","mode":"dark","brand":"#f0a868","accent":"#7fb7d9"}' || :'tail')::jsonb),
  'styles are exact lowercase values');
select ok(not private.is_valid_presentation((:'head' || '{"style":null,"mode":"dark","brand":"#f0a868","accent":"#7fb7d9"}' || :'tail')::jsonb),
  'a null style is rejected');
select ok(not private.is_valid_presentation((:'head' || '{"style":["immersive"],"mode":"dark","brand":"#f0a868","accent":"#7fb7d9"}' || :'tail')::jsonb),
  'a style that is not a string is rejected');
select ok(not private.is_valid_presentation((:'head' || '{"style":"editorial","mode":"light","brand":"#14532d","accent":"#b45309","font":"Comic Sans"}' || :'tail')::jsonb),
  'no other key: fonts come with the style, never from the tenant');
select ok(not private.is_valid_presentation((:'head' || '{"style":"editorial","mode":"light","brand":"#14532d","accent":"red;}body{"}' || :'tail')::jsonb),
  'colors are still #rrggbb only');

-- ── Through the draft and publish RPCs ─────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}';
select results_eq(
  format('select version, revision from public.save_tenant_config_draft(%L, %L, null)',
    'aaaaaaaa-0000-4000-8000-000000000001',
    :'head' || '{"style":"immersive","mode":"dark","brand":"#f0a868","accent":"#7fb7d9"}' || :'tail'),
  $$values (1, 1)$$, 'the owner saves a draft with the immersive theme'
);
select throws_ok(
  format('select * from public.save_tenant_config_draft(%L, %L, 1)',
    'aaaaaaaa-0000-4000-8000-000000000001',
    :'head' || '{"style":"immersive","mode":"light","brand":"#14532d","accent":"#b45309"}' || :'tail'),
  '23514', null, 'the RPC rejects an immersive theme on a light background'
);
select results_eq(
  $$select version from public.publish_tenant_config('aaaaaaaa-0000-4000-8000-000000000001',
      (select id from public.tenant_config_versions where state = 'draft'), 1)$$,
  $$values (1)$$, 'the owner publishes it'
);
reset role;
select is(
  (select v.branding #>> '{theme,style}' from public.tenant_config_versions v
    join public.tenants t on t.active_config_id = v.id
    where t.id = 'aaaaaaaa-0000-4000-8000-000000000001' and v.state = 'sealed'),
  'immersive', 'the sealed, active version keeps the style'
);

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000a2","role":"authenticated","aal":"aal2"}';
select throws_ok(
  format('select * from public.save_tenant_config_draft(%L, %L, null)',
    'aaaaaaaa-0000-4000-8000-000000000001',
    :'head' || '{"style":"editorial","mode":"light","brand":"#14532d","accent":"#b45309"}' || :'tail'),
  '42501', null, 'an editor cannot change the theme (the brand is for owners and admins)'
);

set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000b1","role":"authenticated","aal":"aal2"}';
select throws_ok(
  format('select * from public.save_tenant_config_draft(%L, %L, null)',
    'aaaaaaaa-0000-4000-8000-000000000001',
    :'head' || '{"style":"editorial","mode":"light","brand":"#14532d","accent":"#b45309"}' || :'tail'),
  '42501', null, 'the owner of another tenant cannot change it'
);
reset role;

select is(
  (select count(*)::integer from public.tenant_config_versions
    where tenant_id = 'aaaaaaaa-0000-4000-8000-000000000001' and state = 'draft'),
  0, 'neither of them left a draft'
);

select * from finish();
rollback;
