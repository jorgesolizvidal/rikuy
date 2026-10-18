-- Visitor location (ADR-021): the only server-side piece is the municipality's
-- «Estás cerca de…» radius in the presentation; positions never reach the database.
begin;
set local client_min_messages to warning;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

\set base '{"identity":{"siteName":"Tenant A","shortName":"A","tagline":""},"theme":{"mode":"light","brand":"#1f6f4a","accent":"#a06f12"},"contact":{},"social":[],"seo":{"description":""}'

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000a1', 'owner.a@example.test');
insert into public.tenants (id, slug, display_name, status, default_locale, timezone) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'tenant-a', 'Tenant A', 'provisioning', 'es', 'America/La_Paz');
insert into public.memberships (tenant_id, user_id, role, status, accepted_at) values
  ('aaaaaaaa-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a1', 'owner', 'active', now());

set constraints all immediate;

select plan(15);

-- ── Shape of the optional "visitors" settings ──────────────────────────────
select ok(private.is_valid_presentation((:'base' || '}')::jsonb), 'without visitor settings (defaults apply)');
select ok(private.is_valid_presentation((:'base' || ',"visitors":{"nearbyRadius":150}}')::jsonb), 'radius of 150 m');
select ok(private.is_valid_presentation((:'base' || ',"visitors":{"nearbyRadius":50}}')::jsonb), 'minimum radius (50 m)');
select ok(private.is_valid_presentation((:'base' || ',"visitors":{"nearbyRadius":1000}}')::jsonb), 'maximum radius (1000 m)');
select ok(not private.is_valid_presentation((:'base' || ',"visitors":{"nearbyRadius":49}}')::jsonb), 'below the minimum is rejected');
select ok(not private.is_valid_presentation((:'base' || ',"visitors":{"nearbyRadius":1001}}')::jsonb), 'above the maximum is rejected');
select ok(not private.is_valid_presentation((:'base' || ',"visitors":{"nearbyRadius":-150}}')::jsonb), 'negative radius is rejected');
select ok(not private.is_valid_presentation((:'base' || ',"visitors":{"nearbyRadius":150.5}}')::jsonb), 'fractional meters are rejected');
select ok(not private.is_valid_presentation((:'base' || ',"visitors":{"nearbyRadius":"150"}}')::jsonb), 'a string is rejected');
select ok(not private.is_valid_presentation((:'base' || ',"visitors":{}}')::jsonb), 'an empty object is rejected');
select ok(not private.is_valid_presentation((:'base' || ',"visitors":{"nearbyRadius":150,"track":true}}')::jsonb), 'unknown keys are rejected');
select ok(not private.is_valid_presentation((:'base' || ',"visitors":150}')::jsonb), 'a bare number is rejected');

-- ── Through the draft RPC, as the owner ────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
select results_eq(
  format('select version, revision from public.save_tenant_config_draft(%L, %L, null)',
    'aaaaaaaa-0000-4000-8000-000000000001', :'base' || ',"visitors":{"nearbyRadius":300}}'),
  $$values (1, 1)$$, 'the owner saves a draft with a 300 m radius'
);
select throws_ok(
  format('select * from public.save_tenant_config_draft(%L, %L, 1)',
    'aaaaaaaa-0000-4000-8000-000000000001', :'base' || ',"visitors":{"nearbyRadius":5000}}'),
  '23514', null, 'the RPC rejects an out-of-range radius'
);
reset role;

-- ── No table stores positions ───────────────────────────────────────────────
select is_empty(
  $$select table_name, column_name from information_schema.columns
    where table_schema in ('public', 'private')
      and (column_name ~* '(visitor|user|device)_?(lat|lng|location|position)' or column_name ~* 'accuracy')$$,
  'no column stores a visitor position'
);

select * from finish();
rollback;
