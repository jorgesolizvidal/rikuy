-- A · Paso 2 (ADR-071): «Solo asistente». The portal is a module that the map, the tours and
-- the passport need; only the platform operator (second factor) says where a municipality's
-- assistant may be embedded, and the host registry returns it; owners and admins link each
-- item to its page on the municipality's website, only on an authorized website; visitors read
-- those links only while the website stays authorized.
begin;
set local client_min_messages to warning;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

\set ta 'aaaaaaaa-0000-4000-8000-000000000001'
\set tb 'bbbbbbbb-0000-4000-8000-000000000001'
\set op  '{"sub":"00000000-0000-4000-8000-0000000000f1","role":"authenticated","aal":"aal2"}'
\set op1 '{"sub":"00000000-0000-4000-8000-0000000000f1","role":"authenticated","aal":"aal1"}'
\set a1c '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}'
\set a3c '{"sub":"00000000-0000-4000-8000-0000000000a3","role":"authenticated","aal":"aal2"}'
\set a4c '{"sub":"00000000-0000-4000-8000-0000000000a4","role":"authenticated","aal":"aal2"}'
\set b1c '{"sub":"00000000-0000-4000-8000-0000000000b1","role":"authenticated","aal":"aal2"}'

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000f1', 'operador@example.test'),
  ('00000000-0000-4000-8000-0000000000a1', 'owner.a@example.test'),
  ('00000000-0000-4000-8000-0000000000a3', 'editor.a@example.test'),
  ('00000000-0000-4000-8000-0000000000a4', 'analyst.a@example.test'),
  ('00000000-0000-4000-8000-0000000000b1', 'owner.b@example.test');
insert into public.platform_operators (user_id, status) values
  ('00000000-0000-4000-8000-0000000000f1', 'active');
insert into public.tenants (id, slug, display_name, status, default_locale, timezone) values
  (:'ta', 'tenant-a', 'Tenant A', 'provisioning', 'es', 'America/La_Paz'),
  (:'tb', 'tenant-b', 'Tenant B', 'provisioning', 'es', 'America/La_Paz');
insert into public.tenant_domains (tenant_id, hostname, kind, status, verified_at) values
  (:'ta', 'a.asistente.test', 'platform', 'active', now()),
  (:'tb', 'b.asistente.test', 'platform', 'active', now());
update public.tenants t set canonical_domain_id = d.id
from public.tenant_domains d where d.tenant_id = t.id and t.id in (:'ta', :'tb');
insert into public.memberships (tenant_id, user_id, role, status, accepted_at) values
  (:'ta', '00000000-0000-4000-8000-0000000000a1', 'owner', 'active', now()),
  (:'ta', '00000000-0000-4000-8000-0000000000a3', 'editor', 'active', now()),
  (:'ta', '00000000-0000-4000-8000-0000000000a4', 'analyst', 'active', now()),
  (:'tb', '00000000-0000-4000-8000-0000000000b1', 'owner', 'active', now());
update public.tenants set status = 'active';
set constraints all immediate;

select plan(49);

-- ── The portal is a module ──────────────────────────────────────────────────
select is((select position::int from public.platform_modules where key = 'portal'), 0,
  'the public portal is the first module of the catalog');
select is(
  (select array_agg(key order by key) from public.platform_modules where requires = 'portal'),
  '{map,passport,tours}'::text[],
  'the map, the tours and the passport need it');
select ok(private.has_module(:'ta', 'portal'), 'a new municipality has its portal');
select is(
  (select count(*)::int from public.tenants t
   where not private.has_module(t.id, 'portal')), 0,
  'every municipality that already existed keeps its portal');

set local role authenticated;
set local request.jwt.claims to :'op';
select throws_ok(format('select public.platform_set_tenant_modules(%L, %L)', :'ta', '{map}'),
  '23514', null, 'the map is refused without the portal');
select is(
  public.platform_set_tenant_modules(:'ta', '{assistant,voice,agenda,services,community_memory,copilot}'),
  '{agenda,assistant,voice,copilot,services,community_memory}'::text[],
  'the «Solo asistente» package: no portal, the assistant and what it knows');
set local role anon;
select is((select modules from public.resolve_tenant_by_host('a.asistente.test')),
  '{agenda,assistant,voice,copilot,services,community_memory}'::text[],
  'the portal learns it has no public portal');

-- ── Where the assistant may be embedded: only the operator ──────────────────
set local role authenticated;
set local request.jwt.claims to :'a1c';
select throws_ok(format('select public.platform_add_embed_origin(%L, %L)', :'ta', 'https://www.tenant-a.gob.bo'),
  '42501', null, 'the owner of the municipality cannot authorize a website');
set local request.jwt.claims to :'op1';
select throws_ok(format('select public.platform_add_embed_origin(%L, %L)', :'ta', 'https://www.tenant-a.gob.bo'),
  '42501', null, 'nor an operator without the second factor');
set local role anon;
select throws_ok(format('select public.platform_add_embed_origin(%L, %L)', :'ta', 'https://www.tenant-a.gob.bo'),
  '42501', null, 'nor a visitor');

set local role authenticated;
set local request.jwt.claims to :'op';
select throws_ok(format('select public.platform_add_embed_origin(%L, %L)', :'ta', 'http://www.tenant-a.gob.bo'),
  '23514', null, 'plain http is refused on the internet');
select throws_ok(format('select public.platform_add_embed_origin(%L, %L)', :'ta', 'https://www.tenant-a.gob.bo/turismo'),
  '23514', null, 'a website, never a path');
select throws_ok(format('select public.platform_add_embed_origin(%L, %L)', :'ta', 'https://WWW.Tenant-A.gob.bo'),
  '23514', null, 'lowercase, as the app writes it');
select throws_ok(format('select public.platform_add_embed_origin(%L, %L)', :'ta', 'https://user@tenant-a.gob.bo'),
  '23514', null, 'no user name in it');
select throws_ok(format('select public.platform_add_embed_origin(%L, %L)', :'ta', '*'),
  '23514', null, 'no wildcard');
select throws_ok(format('select public.platform_add_embed_origin(%L, %L)', gen_random_uuid(), 'https://x.gob.bo'),
  'PT404', null, 'an unknown municipality is refused');
select is(public.platform_add_embed_origin(:'ta', 'https://www.tenant-a.gob.bo'), '{https://www.tenant-a.gob.bo}'::text[],
  'the operator authorizes the municipality''s website');
select is(public.platform_add_embed_origin(:'ta', 'http://localhost:4599'),
  '{http://localhost:4599,https://www.tenant-a.gob.bo}'::text[],
  'and a page on this machine, for development');
select is(public.platform_add_embed_origin(:'ta', 'https://www.tenant-a.gob.bo'),
  '{http://localhost:4599,https://www.tenant-a.gob.bo}'::text[], 'adding it again changes nothing');
select is((select count(*)::int from public.platform_embed_origins(:'ta')), 2, 'the operator lists them');
reset role;
select is((select count(*)::int from public.audit_events where action = 'platform.embed_origin_added' and tenant_id = :'ta'), 2,
  'each website added is audited once');
insert into public.assistant_embed_origins (tenant_id, origin)
select :'tb', format('https://sitio-%s.tenant-b.bo', n) from generate_series(1, 10) n;
set local role authenticated;
set local request.jwt.claims to :'op';
select throws_ok(format('select public.platform_add_embed_origin(%L, %L)', :'tb', 'https://otro.tenant-b.bo'),
  'PT409', null, 'at most ten websites per municipality');

set local role anon;
select is((select embed_origins from public.resolve_tenant_by_host('a.asistente.test')),
  '{http://localhost:4599,https://www.tenant-a.gob.bo}'::text[], 'the host registry returns them');
select throws_ok('select * from public.assistant_embed_origins', '42501', null,
  'visitors do not read the table');

set local role authenticated;
set local request.jwt.claims to :'a4c';
select is(public.tenant_embed_origins(:'ta'), '{http://localhost:4599,https://www.tenant-a.gob.bo}'::text[],
  'any member sees them in the panel');
set local request.jwt.claims to :'b1c';
select throws_ok(format('select public.tenant_embed_origins(%L)', :'ta'), '42501', null,
  'the owner of another municipality does not');
select throws_ok('select * from public.assistant_embed_origins', '42501', null,
  'nor does anyone read the table directly');

-- ── «Página en la web del municipio» ────────────────────────────────────────
set local request.jwt.claims to :'a1c';
create temp table plaza as select * from public.create_content_item(:'ta', 'destination', 'plaza', 'Plaza');
select * from public.save_content_draft(:'ta', (select content_id from plaza),
  '{"title":"Plaza principal","summary":"La plaza.","body":[],"location":{"lat":-17.39,"lng":-66.15},"cover":null,"gallery":[]}', 1);
create temp table hidden as select * from public.create_content_item(:'ta', 'destination', 'borrador', 'Borrador');
create temp table guide as select * from public.create_content_item(:'ta', 'knowledge', 'guia', 'Guía');

set local request.jwt.claims to :'a3c';
select throws_ok(format('select public.set_content_web_link(%L, %L, %L)', :'ta', (select content_id from plaza),
  'https://www.tenant-a.gob.bo/turismo/plaza'), '42501', null, 'an editor does not set the link');
set local request.jwt.claims to :'b1c';
select throws_ok(format('select public.set_content_web_link(%L, %L, %L)', :'ta', (select content_id from plaza),
  'https://www.tenant-a.gob.bo/turismo/plaza'), '42501', null, 'nor the owner of another municipality');
set local request.jwt.claims to :'a1c';
select throws_ok(format('select public.set_content_web_link(%L, %L, %L)', :'ta', (select content_id from plaza),
  'https://otro-sitio.com/plaza'), '23514', 'the website is not authorized', 'a website that is not authorized is refused');
select throws_ok(format('select public.set_content_web_link(%L, %L, %L)', :'ta', (select content_id from plaza),
  'javascript:alert(1)'), '23514', 'invalid web address', 'only web addresses');
select throws_ok(format('select public.set_content_web_link(%L, %L, %L)', :'ta', (select content_id from plaza),
  'https://www.tenant-a.gob.bo/a b'), '23514', 'invalid web address', 'no spaces');
select throws_ok(format('select public.set_content_web_link(%L, %L, %L)', :'ta', (select content_id from plaza),
  'https://www.tenant-a.gob.bo@evil.com/'), '23514', null, 'no user name hiding another website');
select throws_ok(format('select public.set_content_web_link(%L, %L, %L)', :'ta', (select content_id from plaza),
  'https://www.tenant-a.gob.bo.evil.com/'), '23514', 'the website is not authorized',
  'a website that only starts like the authorized one is refused');
select throws_ok(format('select public.set_content_web_link(%L, %L, %L)', :'ta', (select content_id from guide),
  'https://www.tenant-a.gob.bo/guia'), 'PT404', null, 'knowledge has no page of its own to link');
select is(public.set_content_web_link(:'ta', (select content_id from plaza), 'https://www.tenant-a.gob.bo/turismo/plaza?x=1#mapa'),
  'https://www.tenant-a.gob.bo/turismo/plaza?x=1#mapa', 'the owner links the place to its page on the website');
select lives_ok(format('select public.set_content_web_link(%L, %L, %L)', :'ta', (select content_id from hidden),
  'https://www.tenant-a.gob.bo/turismo/borrador'), 'and a draft too');
reset role;
select is((select diff ->> 'to' from public.audit_events where action = 'content.web_link_set'
           and entity_id = (select content_id from plaza)), 'https://www.tenant-a.gob.bo/turismo/plaza?x=1#mapa',
  'it is audited');
set local role authenticated;
set local request.jwt.claims to :'a4c';
select is(public.content_web_link(:'ta', (select content_id from plaza)),
  'https://www.tenant-a.gob.bo/turismo/plaza?x=1#mapa', 'any member reads it in the editor');

-- Visitors: only what is published, only while the website is authorized.
set local request.jwt.claims to :'a1c';
select * from public.publish_content(:'ta', (select content_id from plaza), 2);
set local role anon;
select results_eq(
  format('select kind, slug, url from public.portal_web_links(%L)', :'ta'),
  $$values ('destination', 'plaza', 'https://www.tenant-a.gob.bo/turismo/plaza?x=1#mapa')$$,
  'visitors get the link of what is published, never of a draft');
select is_empty(format('select * from public.portal_web_links(%L)', :'tb'), 'nothing of another municipality');
select throws_ok('select web_url from public.content_items', '42501', null, 'nor the column itself');

set local role authenticated;
set local request.jwt.claims to :'op';
select is(public.platform_remove_embed_origin(:'ta', 'https://www.tenant-a.gob.bo'), '{http://localhost:4599}'::text[],
  'the operator removes the website');
set local role anon;
select is_empty(format('select * from public.portal_web_links(%L)', :'ta'), 'and its links stop at once');
reset role;
select is((select count(*)::int from public.audit_events where action = 'platform.embed_origin_removed' and tenant_id = :'ta'), 1,
  'removing it is audited');
select ok((select web_url from public.content_items where id = (select content_id from plaza)) is not null,
  'the link is kept: authorizing the website again brings it back');

set local role authenticated;
set local request.jwt.claims to :'a1c';
select is(public.set_content_web_link(:'ta', (select content_id from plaza), null), null,
  'the owner removes the link');

-- The table itself refuses what the functions would.
reset role;
select throws_ok(
  format('insert into public.assistant_embed_origins (tenant_id, origin) values (%L, %L)', :'ta', 'https://x.bo/ruta'),
  '23514', null, 'the table refuses a path');
select throws_ok(
  format('update public.content_items set web_url = %L where id = %L', 'ftp://x.bo/a', (select content_id from plaza)),
  '23514', null, 'and a link that is not a web address');

select * from finish();
rollback;
