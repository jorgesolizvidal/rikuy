-- Categories and the portal's home (C3 · Paso 3, ADR-062): owners and admins define the
-- categories of their municipality; a destination or an event picks one of its own kind in its
-- draft; removing a category archives it; the portal sees only published content and the
-- categories still in use; the home is data of the brand, with fixed keys and variants and a
-- cover destination of the same municipality. Nobody touches the table directly.
begin;
set local client_min_messages to warning;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

\set ta 'aaaaaaaa-0000-4000-8000-000000000001'
\set tb 'bbbbbbbb-0000-4000-8000-000000000001'
\set ownera '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}'
\set ownera1 '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal1"}'
\set editora '{"sub":"00000000-0000-4000-8000-0000000000a2","role":"authenticated","aal":"aal2"}'
\set analysta '{"sub":"00000000-0000-4000-8000-0000000000a3","role":"authenticated","aal":"aal2"}'
\set ownerb '{"sub":"00000000-0000-4000-8000-0000000000b1","role":"authenticated","aal":"aal2"}'
\set doc '{"title":"Plaza","summary":"","body":[],"location":null,"cover":null,"gallery":[]'
\set evdoc '{"title":"Feria","summary":"","body":[],"schedule":null,"venueId":null,"location":null,"cover":null,"gallery":[]'
\set head '{"identity":{"siteName":"Tenant A","shortName":"A","tagline":""},"theme":{"mode":"light","brand":"#14532d","accent":"#b45309"},"contact":{},"social":[],"seo":{"description":""}'

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000a1', 'owner.a@example.test'),
  ('00000000-0000-4000-8000-0000000000a2', 'editor.a@example.test'),
  ('00000000-0000-4000-8000-0000000000a3', 'analyst.a@example.test'),
  ('00000000-0000-4000-8000-0000000000b1', 'owner.b@example.test');
insert into public.tenants (id, slug, display_name, status, default_locale, timezone) values
  (:'ta', 'tenant-a', 'Tenant A', 'provisioning', 'es', 'America/La_Paz'),
  (:'tb', 'tenant-b', 'Tenant B', 'provisioning', 'es', 'America/La_Paz');
insert into public.memberships (tenant_id, user_id, role, status, accepted_at) values
  (:'ta', '00000000-0000-4000-8000-0000000000a1', 'owner', 'active', now()),
  (:'ta', '00000000-0000-4000-8000-0000000000a2', 'editor', 'active', now()),
  (:'ta', '00000000-0000-4000-8000-0000000000a3', 'analyst', 'active', now()),
  (:'tb', '00000000-0000-4000-8000-0000000000b1', 'owner', 'active', now());
update public.tenants set status = 'active';
set constraints all immediate;

create temp table ids (name text primary key, id uuid);
grant select, insert, update on ids to authenticated, anon;

set local role authenticated;
set local request.jwt.claims to :'ownera';
insert into ids select 'plaza', content_id from public.create_content_item(:'ta', 'destination', 'plaza', 'Plaza');
insert into ids select 'museo', content_id from public.create_content_item(:'ta', 'destination', 'museo', 'Museo');
insert into ids select 'feria', content_id from public.create_content_item(:'ta', 'event', 'feria', 'Feria');
insert into ids select 'libro', content_id from public.create_content_item(:'ta', 'knowledge', 'libro', 'Libro');
set local request.jwt.claims to :'ownerb';
insert into ids select 'laguna', content_id from public.create_content_item(:'tb', 'destination', 'laguna', 'Laguna');
insert into ids select 'catb', (value ->> 'id')::uuid
from jsonb_array_elements(public.save_content_categories(:'tb', 'destination', '[{"name":"Lagunas"}]'));
reset role;

select plan(56);

-- ── Who defines the categories ─────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to :'editora';
select throws_ok(
  format('select public.save_content_categories(%L, %L, %L)', :'ta', 'destination', '[{"name":"Plazas"}]'),
  '42501', null, 'an editor does not define categories'
);
set local request.jwt.claims to :'analysta';
select throws_ok(
  format('select public.save_content_categories(%L, %L, %L)', :'ta', 'destination', '[{"name":"Plazas"}]'),
  '42501', null, 'an analyst does not define categories'
);
set local request.jwt.claims to :'ownera1';
select throws_ok(
  format('select public.save_content_categories(%L, %L, %L)', :'ta', 'destination', '[{"name":"Plazas"}]'),
  '42501', null, 'an owner without the second factor does not define them'
);
set local request.jwt.claims to :'ownerb';
select throws_ok(
  format('select public.save_content_categories(%L, %L, %L)', :'ta', 'destination', '[{"name":"Plazas"}]'),
  '42501', null, 'the owner of another tenant does not define them'
);

set local request.jwt.claims to :'ownera';
select is(
  (select jsonb_agg(value ->> 'name' order by (value ->> 'position')::int)
   from jsonb_array_elements(public.save_content_categories(:'ta', 'destination',
     '[{"name":"Plazas"},{"name":"Museos"},{"name":"Miradores"}]'))),
  '["Plazas","Museos","Miradores"]'::jsonb, 'the owner defines three categories, in order'
);
insert into ids select 'cat-' || lower(value ->> 'name'), (value ->> 'id')::uuid
from jsonb_array_elements(public.tenant_content_categories(:'ta'));
insert into ids select 'cat-ferias', (value ->> 'id')::uuid
from jsonb_array_elements(public.save_content_categories(:'ta', 'event', '[{"name":"Ferias"}]'))
where value ->> 'kind' = 'event';

select throws_ok(
  format('select public.save_content_categories(%L, %L, %L)', :'ta', 'knowledge', '[{"name":"Libros"}]'),
  '23514', null, 'knowledge has no categories'
);
select throws_ok(
  format('select public.save_content_categories(%L, %L, %L)', :'ta', 'destination', '[{"name":"Plazas"},{"name":"plazas"}]'),
  '23505', null, 'two categories with the same name (ignoring case) are rejected'
);
select throws_ok(
  format('select public.save_content_categories(%L, %L, %L)', :'ta', 'destination', '[{"name":"Pla\nzas"}]'),
  '23514', null, 'a name with a line break is rejected'
);
select throws_ok(
  format('select public.save_content_categories(%L, %L, %L)', :'ta', 'destination', '[{"name":""}]'),
  '23514', null, 'an empty name is rejected'
);
select throws_ok(
  format('select public.save_content_categories(%L, %L, %L)', :'ta', 'destination', '[{"name":" Plazas"}]'),
  '23514', null, 'a name with spaces around it is rejected'
);
select throws_ok(
  format('select public.save_content_categories(%L, %L, %L)', :'ta', 'destination',
    (select jsonb_agg(jsonb_build_object('name', 'Categoría ' || n)) from generate_series(1, 21) n)),
  '23514', null, 'more than 20 categories are rejected'
);
select throws_ok(
  format('select public.save_content_categories(%L, %L, %L)', :'ta', 'destination',
    jsonb_build_array(jsonb_build_object('id', (select id from ids where name = 'catb'), 'name', 'Lagunas'))),
  '23514', null, 'a category of another tenant is rejected'
);
select throws_ok(
  format('select public.save_content_categories(%L, %L, %L)', :'ta', 'destination',
    jsonb_build_array(jsonb_build_object('id', (select id from ids where name = 'cat-ferias'), 'name', 'Ferias'))),
  '23514', null, 'an event category in the list of destinations is rejected'
);
select throws_ok(
  format('select public.save_content_categories(%L, %L, %L)', :'ta', 'destination', '[{"name":"Plazas","color":"red"}]'),
  '23514', null, 'a category has only an id and a name'
);
select is(
  (select count(*)::integer from public.tenant_content_categories(:'ta') x(c), jsonb_array_elements(c)),
  4, 'none of the rejected lists changed anything'
);

-- Rename and reorder: ids stay; leaving one out archives it.
select is(
  (select jsonb_agg(jsonb_build_array(value ->> 'id', value ->> 'name') order by (value ->> 'position')::int)
   from jsonb_array_elements(public.save_content_categories(:'ta', 'destination', jsonb_build_array(
     jsonb_build_object('id', (select id from ids where name = 'cat-miradores'), 'name', 'Miradores'),
     jsonb_build_object('id', (select id from ids where name = 'cat-plazas'), 'name', 'Plazas y centro'))))
   where value ->> 'kind' = 'destination'),
  jsonb_build_array(
    jsonb_build_array((select id from ids where name = 'cat-miradores'), 'Miradores'),
    jsonb_build_array((select id from ids where name = 'cat-plazas'), 'Plazas y centro')),
  'renaming and reordering keep the ids; the museum category is gone from the list'
);
reset role;
select isnt(
  (select archived_at from public.content_categories where id = (select id from ids where name = 'cat-museos')),
  null, 'the category left out is archived, not deleted'
);
select is(
  (select diff ->> 'kind' from public.audit_events where action = 'content.categories_saved' and tenant_id = :'ta'
   order by occurred_at desc limit 1),
  'destination', 'saving the categories is audited'
);
set local role authenticated;
set local request.jwt.claims to :'ownera';
select throws_ok(
  format('select public.save_content_categories(%L, %L, %L)', :'ta', 'destination',
    jsonb_build_array(jsonb_build_object('id', (select id from ids where name = 'cat-museos'), 'name', 'Museos'))),
  '23514', null, 'an archived category cannot come back by its id'
);
select is(
  (select count(*)::integer from jsonb_array_elements(public.save_content_categories(:'ta', 'destination', jsonb_build_array(
     jsonb_build_object('id', (select id from ids where name = 'cat-miradores'), 'name', 'Miradores'),
     jsonb_build_object('id', (select id from ids where name = 'cat-plazas'), 'name', 'Plazas y centro'),
     jsonb_build_object('name', 'Museos')))) where value ->> 'kind' = 'destination'),
  3, 'a new category may take the name of an archived one'
);
insert into ids select 'cat-museos2', (value ->> 'id')::uuid
from jsonb_array_elements(public.tenant_content_categories(:'ta')) where value ->> 'name' = 'Museos';

-- ── Reading ────────────────────────────────────────────────────────────────
set local request.jwt.claims to :'analysta';
select is(
  (select count(*)::integer from jsonb_array_elements(public.tenant_content_categories(:'ta'))),
  4, 'an analyst reads the categories in use'
);
set local request.jwt.claims to :'ownerb';
select throws_ok(
  format('select public.tenant_content_categories(%L)', :'ta'),
  '42501', null, 'the owner of another tenant does not read them'
);
select throws_ok('select count(*) from public.content_categories', '42501', null, 'nobody reads the table directly');
select throws_ok(
  format('insert into public.content_categories (tenant_id, kind, name, position) values (%L, %L, %L, 1)', :'ta', 'destination', 'X'),
  '42501', null, 'nobody writes the table directly'
);
reset role;
set local role anon;
select throws_ok(
  format('select public.tenant_content_categories(%L)', :'ta'),
  '42501', null, 'a visitor does not read the panel list'
);
reset role;

-- ── The category in drafts ─────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to :'editora';
select lives_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 1)', :'ta', (select id from ids where name = 'plaza'),
    :'doc' || format(',"categoryId":"%s"}', (select id from ids where name = 'cat-plazas'))),
  'an editor picks a category for a destination'
);
reset role;
select is(
  private.revision_document((select draft_revision_id from public.content_items where id = (select id from ids where name = 'plaza'))) ->> 'categoryId',
  (select id from ids where name = 'cat-plazas')::text, 'the draft document carries its category'
);
select ok(
  not (private.revision_document((select draft_revision_id from public.content_items where id = (select id from ids where name = 'museo'))) ? 'categoryId'),
  'a draft without a category has no categoryId key (the document is unchanged)'
);
set local role authenticated;
set local request.jwt.claims to :'editora';
select throws_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 2)', :'ta', (select id from ids where name = 'plaza'),
    :'doc' || format(',"categoryId":"%s"}', (select id from ids where name = 'catb'))),
  '23514', null, 'a category of another tenant is rejected'
);
select throws_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 2)', :'ta', (select id from ids where name = 'plaza'),
    :'doc' || format(',"categoryId":"%s"}', (select id from ids where name = 'cat-ferias'))),
  '23514', null, 'an event category on a destination is rejected'
);
select throws_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 2)', :'ta', (select id from ids where name = 'plaza'),
    :'doc' || format(',"categoryId":"%s"}', (select id from ids where name = 'cat-museos'))),
  '23514', null, 'an archived category is rejected'
);
select throws_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 2)', :'ta', (select id from ids where name = 'plaza'),
    :'doc' || ',"categoryId":"plazas"}'),
  '23514', null, 'a category that is not an id is rejected'
);
select throws_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 1)', :'ta', (select id from ids where name = 'libro'),
    format('{"title":"Libro","summary":"","body":[],"document":null,"categoryId":"%s"}', (select id from ids where name = 'cat-plazas'))),
  '23514', null, 'knowledge has no category'
);
select lives_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 1)', :'ta', (select id from ids where name = 'feria'),
    :'evdoc' || format(',"categoryId":"%s"}', (select id from ids where name = 'cat-ferias'))),
  'an event picks an event category'
);
select lives_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 1)', :'ta', (select id from ids where name = 'museo'),
    :'doc' || format(',"categoryId":"%s"}', (select id from ids where name = 'cat-museos2'))),
  'the museum picks the new museums category'
);
select lives_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 2)', :'ta', (select id from ids where name = 'museo'), :'doc' || '}'),
  'a document without categoryId clears it'
);
reset role;
select is(
  (select r.category_id from public.content_revisions r join public.content_items i on i.draft_revision_id = r.id
   where i.id = (select id from ids where name = 'museo')),
  null, 'the museum has no category again'
);

-- ── The portal's index ─────────────────────────────────────────────────────
-- Published as publish_content would (it also asks for a summary, location and photos).
update public.content_revisions r set state = 'sealed', sealed_at = now()
from public.content_items i
where r.id = i.draft_revision_id and i.id in (select id from ids where name in ('plaza', 'feria'));
update public.content_items i
set published_revision_id = i.draft_revision_id, published_at = now(), draft_revision_id = null
where i.id in (select id from ids where name in ('plaza', 'feria'));
set local role anon;
select results_eq(
  format('select kind, slug, category_name from public.portal_content_index(%L) order by kind, slug', :'ta'),
  $$values ('destination'::text, 'plaza'::text, 'Plazas y centro'::text), ('event'::text, 'feria'::text, 'Ferias'::text)$$,
  'a visitor sees published content with its category; drafts (the museum) are not there'
);
select is(
  (select count(*)::integer from public.portal_content_index(:'tb')),
  0, 'the other tenant has nothing published (the laguna is a draft)'
);
reset role;

set local role authenticated;
set local request.jwt.claims to :'ownera';
select is(
  (select (value ->> 'used')::integer from jsonb_array_elements(public.tenant_content_categories(:'ta'))
   where value ->> 'name' = 'Plazas y centro'),
  1, 'the panel counts the items that use a category'
);
-- Archive «Plazas y centro»: the sealed revision keeps its reference, the portal hides it.
select public.save_content_categories(:'ta', 'destination', jsonb_build_array(
  jsonb_build_object('id', (select id from ids where name = 'cat-miradores'), 'name', 'Miradores')));
reset role;
select is(
  (select r.category_id from public.content_revisions r join public.content_items i on i.published_revision_id = r.id
   where i.id = (select id from ids where name = 'plaza')),
  (select id from ids where name = 'cat-plazas'), 'the sealed revision keeps its category after archiving'
);
set local role anon;
select is(
  (select category_name from public.portal_content_index(:'ta') where slug = 'plaza'),
  null, 'the portal no longer shows an archived category'
);
reset role;
update public.tenants set status = 'suspended' where id = :'ta';
set local role anon;
select is(
  (select count(*)::integer from public.portal_content_index(:'ta')),
  0, 'a suspended tenant has no index'
);
reset role;
update public.tenants set status = 'active' where id = :'ta';

-- ── The home in the brand ──────────────────────────────────────────────────
\set home '"home":{"hero":{"variant":"photo","destinationId":null},"figures":[{"value":"1953","label":"Firma del decreto"}],"sections":[{"key":"figures","variant":"band"},{"key":"destinations","variant":"featured"},{"key":"events","variant":"cards"},{"key":"tours","variant":"banner"},{"key":"passport","variant":"banner"},{"key":"assistant","variant":"banner"}]}'
select ok(private.is_valid_presentation((:'head' || ',' || :'home' || '}')::jsonb), 'a full home is valid');
select ok(private.is_valid_presentation((:'head' || '}')::jsonb), 'a brand without home stays valid (platform default)');
select ok(not private.is_valid_presentation((:'head' || ',"home":{"hero":{"variant":"video","destinationId":null},"figures":[],"sections":[]}}')::jsonb),
  'an unknown cover variant is rejected');
select ok(not private.is_valid_presentation((:'head' || ',"home":{"hero":{"variant":"text","destinationId":null},"figures":[],"sections":[{"key":"events","variant":"featured"}]}}')::jsonb),
  'a variant of another section is rejected');
select ok(not private.is_valid_presentation((:'head' || ',"home":{"hero":{"variant":"text","destinationId":null},"figures":[],"sections":[{"key":"map","variant":"banner"}]}}')::jsonb),
  'an unknown section is rejected');
select ok(not private.is_valid_presentation((:'head' || ',"home":{"hero":{"variant":"text","destinationId":null},"figures":[],"sections":[{"key":"tours","variant":"banner"},{"key":"tours","variant":"banner"}]}}')::jsonb),
  'a section twice is rejected');
select ok(not private.is_valid_presentation((:'head' || ',"home":{"hero":{"variant":"text","destinationId":null},"figures":[{"value":"1","label":"a"},{"value":"2","label":"b"},{"value":"3","label":"c"}],"sections":[]}}')::jsonb),
  'more than two figures are rejected');
select ok(not private.is_valid_presentation((:'head' || ',"home":{"hero":{"variant":"text","destinationId":null},"figures":[{"value":"1234567890123","label":"a"}],"sections":[]}}')::jsonb),
  'a figure longer than 12 characters is rejected');
select ok(not private.is_valid_presentation((:'head' || ',"home":{"hero":{"variant":"text","destinationId":null},"figures":[{"value":"<b>1</b>","label":"a","href":"https://x.test"}],"sections":[]}}')::jsonb),
  'a figure has only a value and a label (no links)');
select ok(not private.is_valid_presentation((:'head' || ',"home":{"hero":{"variant":"photo","destinationId":"plaza"},"figures":[],"sections":[]}}')::jsonb),
  'the cover destination is an id');

set local role authenticated;
set local request.jwt.claims to :'ownera';
select throws_ok(
  format('select * from public.save_tenant_config_draft(%L, %L, null)', :'ta',
    :'head' || format(',"home":{"hero":{"variant":"photo","destinationId":"%s"},"figures":[],"sections":[]}}', (select id from ids where name = 'laguna'))),
  '23514', null, 'a cover destination of another tenant is rejected'
);
select throws_ok(
  format('select * from public.save_tenant_config_draft(%L, %L, null)', :'ta',
    :'head' || format(',"home":{"hero":{"variant":"photo","destinationId":"%s"},"figures":[],"sections":[]}}', (select id from ids where name = 'feria'))),
  '23514', null, 'an event as the cover destination is rejected'
);
select lives_ok(
  format('select * from public.save_tenant_config_draft(%L, %L, null)', :'ta',
    :'head' || format(',"home":{"hero":{"variant":"photo","destinationId":"%s"},"figures":[],"sections":[{"key":"destinations","variant":"grid"}]}}', (select id from ids where name = 'museo'))),
  'the owner saves a home with one of its destinations as the cover'
);
reset role;

select * from finish();
rollback;
