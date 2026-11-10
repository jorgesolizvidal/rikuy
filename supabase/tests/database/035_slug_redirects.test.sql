-- Changing the address of a destination or event (ADR-047): owners and admins only, old
-- addresses of published content keep leading to it in one hop, an old address is never
-- taken by another place, and visitors only learn the current address of visible content.
begin;
set local client_min_messages to warning;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

\set ta 'aaaaaaaa-0000-4000-8000-000000000001'
\set tb 'bbbbbbbb-0000-4000-8000-000000000001'
\set ownera '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}'
\set editora '{"sub":"00000000-0000-4000-8000-0000000000a2","role":"authenticated","aal":"aal2"}'
\set analysta '{"sub":"00000000-0000-4000-8000-0000000000a3","role":"authenticated","aal":"aal2"}'
\set admina '{"sub":"00000000-0000-4000-8000-0000000000a4","role":"authenticated","aal":"aal2"}'
\set ownerb '{"sub":"00000000-0000-4000-8000-0000000000b1","role":"authenticated","aal":"aal2"}'
\set doc '{"title":"Museo","summary":"Un museo.","body":[],"location":{"lat":-17.39,"lng":-66.15},"cover":null,"gallery":[]}'

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000a1', 'owner.a@example.test'),
  ('00000000-0000-4000-8000-0000000000a2', 'editor.a@example.test'),
  ('00000000-0000-4000-8000-0000000000a3', 'analyst.a@example.test'),
  ('00000000-0000-4000-8000-0000000000a4', 'admin.a@example.test'),
  ('00000000-0000-4000-8000-0000000000b1', 'owner.b@example.test');
insert into public.tenants (id, slug, display_name, status, default_locale, timezone) values
  (:'ta', 'tenant-a', 'Tenant A', 'provisioning', 'es', 'America/La_Paz'),
  (:'tb', 'tenant-b', 'Tenant B', 'provisioning', 'es', 'America/La_Paz');
insert into public.memberships (tenant_id, user_id, role, status, accepted_at) values
  (:'ta', '00000000-0000-4000-8000-0000000000a1', 'owner', 'active', now()),
  (:'ta', '00000000-0000-4000-8000-0000000000a2', 'editor', 'active', now()),
  (:'ta', '00000000-0000-4000-8000-0000000000a3', 'analyst', 'active', now()),
  (:'ta', '00000000-0000-4000-8000-0000000000a4', 'admin', 'active', now()),
  (:'tb', '00000000-0000-4000-8000-0000000000b1', 'owner', 'active', now());
insert into public.tenant_domains (id, tenant_id, hostname, kind, status, verified_at) values
  ('aaaaaaaa-0000-4000-8000-0000000000d1', :'ta', 'tenant-a.localhost', 'platform', 'active', now()),
  ('bbbbbbbb-0000-4000-8000-0000000000d1', :'tb', 'tenant-b.localhost', 'platform', 'active', now());
update public.tenants set canonical_domain_id = 'aaaaaaaa-0000-4000-8000-0000000000d1' where id = :'ta';
update public.tenants set canonical_domain_id = 'bbbbbbbb-0000-4000-8000-0000000000d1' where id = :'tb';
update public.tenants set status = 'active';

set constraints all immediate;

select plan(41);

set local role authenticated;
set local request.jwt.claims to :'ownera';
create temp table museo as select * from public.create_content_item(:'ta', 'destination', 'museo', 'Museo');
create temp table plaza as select * from public.create_content_item(:'ta', 'destination', 'plaza', 'Plaza');
create temp table feria as select * from public.create_content_item(:'ta', 'event', 'feria', 'Feria');
create temp table libro as select * from public.create_content_item(:'ta', 'knowledge', 'libro', 'Libro');
set local request.jwt.claims to :'ownerb';
create temp table museo_b as select * from public.create_content_item(:'tb', 'destination', 'museo', 'Museo');

-- ── Never published: no old address ────────────────────────────────────────
set local request.jwt.claims to :'ownera';
select results_eq(
  format('select slug, previous_slug from public.change_content_slug(%L, %L, %L, %L)',
    :'ta', (select content_id from museo), 'museo', 'museo-historico'),
  $$values ('museo-historico'::text, null::text)$$,
  'an owner renames a destination never published'
);
select is(
  (select count(*)::int from public.content_slug_redirects where content_id = (select content_id from museo)),
  0, 'a draft never published leaves no old address (nobody has its link)'
);
select ok(
  not exists (select 1 from public.content_items where tenant_id = :'tb' and slug <> 'museo'),
  'the same address in another municipality does not change'
);

-- ── Published: the old address keeps leading here ──────────────────────────
select * from public.save_content_draft(:'ta', (select content_id from museo), :'doc'::jsonb, 1);
select * from public.publish_content(:'ta', (select content_id from museo), 2);
select results_eq(
  format('select slug, previous_slug from public.change_content_slug(%L, %L, %L, %L)',
    :'ta', (select content_id from museo), 'museo-historico', 'museo-de-la-reforma'),
  $$values ('museo-de-la-reforma'::text, 'museo-historico'::text)$$,
  'renaming a published destination keeps its old address'
);
select is(
  (select slug from public.content_items where id = (select content_id from museo)),
  'museo-de-la-reforma', 'the destination has its new address'
);
select is(
  (select diff from public.audit_events where action = 'content.slug_changed' and diff ->> 'to' = 'museo-de-la-reforma'),
  '{"kind":"destination","from":"museo-historico","to":"museo-de-la-reforma","kept_old":true}'::jsonb,
  'the change is audited with both addresses'
);

reset role;
set local role anon;
select is(
  public.portal_content_redirect(:'ta', 'destination', 'museo-historico'), 'museo-de-la-reforma',
  'visitors with the old address learn the new one'
);
select is(
  public.portal_content_redirect(:'ta', 'destination', 'museo-de-la-reforma'), null,
  'the current address is not a redirect'
);
select is(
  public.portal_content_redirect(:'tb', 'destination', 'museo-historico'), null,
  'the old address of A means nothing in B'
);
select is(
  public.portal_content_redirect(:'ta', 'event', 'museo-historico'), null,
  'nor for an event of A'
);
select throws_ok(
  'select * from public.content_slug_redirects', '42501', null,
  'visitors cannot read the table'
);
reset role;
set local role authenticated;

-- A second change: every old address leads to the current one in one hop.
set local request.jwt.claims to :'admina';
select lives_ok(
  format('select * from public.change_content_slug(%L, %L, %L, %L)',
    :'ta', (select content_id from museo), 'museo-de-la-reforma', 'museo-1953'),
  'an administrator renames it again'
);
reset role;
set local role anon;
select is(
  public.portal_content_redirect(:'ta', 'destination', 'museo-historico'), 'museo-1953',
  'the first address goes straight to the current one'
);
select is(
  public.portal_content_redirect(:'ta', 'destination', 'museo-de-la-reforma'), 'museo-1953',
  'the second too'
);
reset role;
set local role authenticated;

-- Going back to an old address: it is the current one again.
set local request.jwt.claims to :'ownera';
select lives_ok(
  format('select * from public.change_content_slug(%L, %L, %L, %L)',
    :'ta', (select content_id from museo), 'museo-1953', 'museo-historico'),
  'the place can go back to one of its old addresses'
);
select set_eq(
  format('select slug from public.content_slug_redirects where content_id = %L', (select content_id from museo)),
  $$values ('museo-de-la-reforma'::text), ('museo-1953'::text)$$,
  'it is no longer an old address; the one it left is'
);

-- ── Who and what ───────────────────────────────────────────────────────────
set local request.jwt.claims to :'editora';
select throws_ok(
  format('select * from public.change_content_slug(%L, %L, %L, %L)',
    :'ta', (select content_id from museo), 'museo-historico', 'otro'),
  '42501', null, 'an editor cannot change the address'
);
set local request.jwt.claims to :'analysta';
select throws_ok(
  format('select * from public.change_content_slug(%L, %L, %L, %L)',
    :'ta', (select content_id from museo), 'museo-historico', 'otro'),
  '42501', null, 'an analyst cannot change the address'
);
set local request.jwt.claims to :'ownerb';
select throws_ok(
  format('select * from public.change_content_slug(%L, %L, %L, %L)',
    :'ta', (select content_id from museo), 'museo-historico', 'otro'),
  '42501', null, 'the owner of another municipality cannot change it'
);
select throws_ok(
  format('select * from public.change_content_slug(%L, %L, %L, %L)',
    :'tb', (select content_id from museo), 'museo-historico', 'otro'),
  'PT404', null, 'nor through their own municipality'
);
select is(
  (select count(*)::int from public.content_slug_redirects), 0,
  'and does not see the old addresses of A'
);

set local request.jwt.claims to :'analysta';
select is(
  (select count(*)::int from public.content_slug_redirects), 2,
  'members of A (also analysts) read them for the editor'
);
select throws_ok(
  format($$insert into public.content_slug_redirects (tenant_id, kind, slug, content_id) values (%L, 'destination', 'x', %L)$$,
    :'ta', (select content_id from museo)),
  '42501', null, 'nobody writes the table directly'
);

set local request.jwt.claims to :'ownera';
select throws_ok(
  format('select * from public.change_content_slug(%L, %L, %L, %L)',
    :'ta', (select content_id from museo), 'museo-1953', 'otro'),
  'PT409', 'the address changed meanwhile', 'a stale address (someone changed it meanwhile) is rejected'
);
select throws_ok(
  format('select * from public.change_content_slug(%L, %L, %L, %L)',
    :'ta', (select content_id from museo), 'museo-historico', 'museo-historico'),
  '23514', 'the address is the same', 'the same address is not a change'
);
select throws_ok(
  format('select * from public.change_content_slug(%L, %L, %L, %L)',
    :'ta', (select content_id from museo), 'museo-historico', 'Museo Histórico'),
  '23514', 'invalid identifier', 'an address with spaces, capitals or accents is rejected'
);
select throws_ok(
  format('select * from public.change_content_slug(%L, %L, %L, %L)',
    :'ta', (select content_id from museo), 'museo-historico', 'plaza'),
  'PT409', 'this identifier is already used', 'the current address of another destination is rejected'
);
select throws_ok(
  format('select * from public.change_content_slug(%L, %L, %L, %L)',
    :'ta', (select content_id from plaza), 'plaza', 'museo-1953'),
  'PT409', 'this identifier was used before by another place',
  'the old address of another destination is rejected (its QR would open another place)'
);
select throws_ok(
  format('select * from public.create_content_item(%L, %L, %L, %L)', :'ta', 'destination', 'museo-1953', 'Otro'),
  'PT409', 'this identifier was used before by another place',
  'nor can a new destination take it'
);
select lives_ok(
  format('select * from public.create_content_item(%L, %L, %L, %L)', :'ta', 'event', 'museo-1953', 'Fiesta'),
  'an event can: events and destinations have their own addresses'
);
select throws_ok(
  format('select * from public.change_content_slug(%L, %L, %L, %L)',
    :'ta', (select content_id from libro), 'libro', 'libro-2'),
  'PT404', null, 'knowledge has no public address to change'
);

-- An event: same rules.
select * from public.save_content_draft(:'ta', (select content_id from feria),
  ('{"title":"Feria","summary":"Una feria.","body":[],"location":{"lat":-17.39,"lng":-66.15},"cover":null,"gallery":[],'
   || '"schedule":{"allDay":true,"start":"2030-05-01","end":"2030-05-02"},"venueId":null}')::jsonb, 1);
select * from public.publish_content(:'ta', (select content_id from feria), 2);
select results_eq(
  format('select slug, previous_slug from public.change_content_slug(%L, %L, %L, %L)',
    :'ta', (select content_id from feria), 'feria', 'feria-del-choclo'),
  $$values ('feria-del-choclo'::text, 'feria'::text)$$,
  'a published event keeps its old address too'
);
reset role;
set local role anon;
select is(
  public.portal_content_redirect(:'ta', 'event', 'feria'), 'feria-del-choclo',
  'visitors of the old agenda page learn the new one'
);
reset role;

-- Database guards beyond the RPC.
select throws_ok(
  format($$insert into public.content_slug_redirects (tenant_id, kind, slug, content_id) values (%L, 'event', 'otra', %L)$$,
    :'ta', (select content_id from museo)),
  '23514', null, 'an old address belongs to a content of its own kind'
);
select throws_ok(
  format($$insert into public.content_slug_redirects (tenant_id, kind, slug, content_id) values (%L, 'destination', 'plaza', %L)$$,
    :'ta', (select content_id from museo)),
  'PT409', null, 'an old address is never the current address of another place'
);
select throws_ok(
  format($$update public.content_slug_redirects set tenant_id = %L where slug = 'museo-1953'$$, :'tb'),
  '23514', null, 'an old address cannot move to another municipality'
);

-- At most 20 old addresses per place.
set local role authenticated;
set local request.jwt.claims to :'ownera';
do $$
declare
  v_id uuid := (select content_id from plaza);
  v_slug text := 'plaza';
begin
  perform public.save_content_draft('aaaaaaaa-0000-4000-8000-000000000001', v_id,
    '{"title":"Plaza","summary":"Una plaza.","body":[],"location":{"lat":-17.39,"lng":-66.15},"cover":null,"gallery":[]}'::jsonb, 1);
  perform public.publish_content('aaaaaaaa-0000-4000-8000-000000000001', v_id, 2);
  for i in 1..20 loop
    perform public.change_content_slug('aaaaaaaa-0000-4000-8000-000000000001', v_id, v_slug, 'plaza-' || i);
    v_slug := 'plaza-' || i;
  end loop;
end;
$$;
select throws_ok(
  format('select * from public.change_content_slug(%L, %L, %L, %L)',
    :'ta', (select content_id from plaza), 'plaza-20', 'plaza-21'),
  'PT409', 'too many old addresses', 'a 21st old address is rejected'
);
select lives_ok(
  format('select * from public.change_content_slug(%L, %L, %L, %L)',
    :'ta', (select content_id from plaza), 'plaza-20', 'plaza'),
  'going back to an old address is always possible'
);
reset role;

-- A municipality that is not active hides the old addresses too.
update public.tenants set status = 'suspended' where id = :'ta';
set local role anon;
select is(
  public.portal_content_redirect(:'ta', 'destination', 'museo-1953'), null,
  'a suspended municipality answers nothing'
);
reset role;
update public.tenants set status = 'active' where id = :'ta';

-- Visible content only: a published place with its page gone answers nothing.
update public.content_items set published_revision_id = null, published_at = null where id = (select content_id from museo);
set local role anon;
select is(
  public.portal_content_redirect(:'ta', 'destination', 'museo-1953'), null,
  'content without a published version answers nothing (drafts do not leak)'
);
reset role;

select ok(
  not has_function_privilege('anon', 'public.change_content_slug(uuid, uuid, text, text)', 'execute'),
  'visitors cannot call the rename'
);

select * from finish();
rollback;
