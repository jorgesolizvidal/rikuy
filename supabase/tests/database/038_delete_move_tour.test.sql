-- Deleting a tour and moving it to another destination or event (C0 · Paso 3, ADR-049): only
-- owners and admins, never across municipalities; a move keeps the whole tour (history and
-- place in the general tour), leaves its old page leading to it and refuses a place with a
-- tour or one its own points lead to; deleting removes every revision, its place in the
-- general tour and what the assistant read, frees its media, and is the only way a sealed
-- revision goes. Visitors: a tour never links to its own place, and an old tour page leads
-- to the moved tour or to its place.
begin;
set local client_min_messages to warning;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

\set ta 'aaaaaaaa-0000-4000-8000-000000000001'
\set tb 'bbbbbbbb-0000-4000-8000-000000000001'
\set a1c '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}'
\set a2c '{"sub":"00000000-0000-4000-8000-0000000000a2","role":"authenticated","aal":"aal2"}'
\set a3c '{"sub":"00000000-0000-4000-8000-0000000000a3","role":"authenticated","aal":"aal2"}'
\set a4c '{"sub":"00000000-0000-4000-8000-0000000000a4","role":"authenticated","aal":"aal2"}'
\set b1c '{"sub":"00000000-0000-4000-8000-0000000000b1","role":"authenticated","aal":"aal2"}'
\set sha '0000000000000000000000000000000000000000000000000000000000000abc'
\set pano '{"version":1,"projection":"equirectangular","source":{"width":8192,"height":4096,"bytes":9000000,"mime":"image/jpeg","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"preview":{"file":"preview.webp","width":1024,"height":512,"bytes":18000},"image":{"file":"image.webp","width":4096,"height":2048,"bytes":1400000},"tiles":null}'
\set place '{"title":"%s","summary":"Un lugar","body":[],"location":{"lat":-17.39,"lng":-66.15},"cover":null,"gallery":[]}'

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000a1', 'owner.a@example.test'),
  ('00000000-0000-4000-8000-0000000000a2', 'admin.a@example.test'),
  ('00000000-0000-4000-8000-0000000000a3', 'editor.a@example.test'),
  ('00000000-0000-4000-8000-0000000000a4', 'analyst.a@example.test'),
  ('00000000-0000-4000-8000-0000000000b1', 'owner.b@example.test');
insert into public.tenants (id, slug, display_name, status, default_locale, timezone) values
  (:'ta', 'tenant-a', 'Tenant A', 'provisioning', 'es', 'America/La_Paz'),
  (:'tb', 'tenant-b', 'Tenant B', 'provisioning', 'es', 'America/La_Paz');
insert into public.memberships (tenant_id, user_id, role, status, accepted_at) values
  (:'ta', '00000000-0000-4000-8000-0000000000a1', 'owner', 'active', now()),
  (:'ta', '00000000-0000-4000-8000-0000000000a2', 'admin', 'active', now()),
  (:'ta', '00000000-0000-4000-8000-0000000000a3', 'editor', 'active', now()),
  (:'ta', '00000000-0000-4000-8000-0000000000a4', 'analyst', 'active', now()),
  (:'tb', '00000000-0000-4000-8000-0000000000b1', 'owner', 'active', now());
update public.tenants set status = 'active';
set constraints all immediate;

-- Three public panoramas of A.
create temp table media (name text primary key, tenant uuid, asset uuid default gen_random_uuid(), version_id uuid default gen_random_uuid());
insert into media (name, tenant) values ('p1', :'ta'), ('p2', :'ta'), ('p3', :'ta');
insert into public.assets (id, tenant_id, purpose) select asset, tenant, 'panorama' from media;
insert into public.asset_versions (id, tenant_id, asset_id, version, status, declared_mime, declared_bytes, mime, bytes, width, height, sha256, ready_at, manifest, published_at)
select version_id, tenant, asset, 1, 'ready', 'image/jpeg', 1000, 'image/jpeg', 1000, 8192, 4096, :'sha', now(), :'pano'::jsonb, now()
from media;
create temp table ids (name text primary key, id uuid);
grant select on media to authenticated, anon;
grant select, insert, update on ids to authenticated;
grant select on ids to anon;
create function pg_temp.id(p_name text) returns uuid language sql as $$ select id from ids where name = p_name $$;
create function pg_temp.edit(p_tour uuid) returns integer language sql as $$
  select r.edit_count from public.tours t join public.tour_revisions r on r.id = t.draft_revision_id where t.id = p_tour
$$;

-- Published places: museo, plaza, mirador; an unpublished event; a knowledge text.
set local role authenticated;
set local request.jwt.claims to :'a1c';
insert into ids select 'museo', content_id from public.create_content_item(:'ta', 'destination', 'museo', 'Museo');
insert into ids select 'plaza', content_id from public.create_content_item(:'ta', 'destination', 'plaza', 'Plaza');
insert into ids select 'mirador', content_id from public.create_content_item(:'ta', 'destination', 'mirador', 'Mirador');
insert into ids select 'feria', content_id from public.create_content_item(:'ta', 'event', 'feria', 'Feria');
insert into ids select 'guia', content_id from public.create_content_item(:'ta', 'knowledge', 'guia', 'Guía');
select * from public.save_content_draft(:'ta', pg_temp.id('museo'), format(:'place', 'Museo')::jsonb, 1);
select * from public.publish_content(:'ta', pg_temp.id('museo'), 2);
select * from public.save_content_draft(:'ta', pg_temp.id('plaza'), format(:'place', 'Plaza')::jsonb, 1);
select * from public.publish_content(:'ta', pg_temp.id('plaza'), 2);
select * from public.save_content_draft(:'ta', pg_temp.id('mirador'), format(:'place', 'Mirador')::jsonb, 1);
select * from public.publish_content(:'ta', pg_temp.id('mirador'), 2);

-- Tour T (museo) leads to the plaza; tour P (plaza) leads to the museo. Both published and
-- in the general tour, T first and its start.
insert into ids select 'T', tour_id from public.create_tour(:'ta', pg_temp.id('museo'));
insert into ids select 'P', tour_id from public.create_tour(:'ta', pg_temp.id('plaza'));
insert into ids select 'sala', scene_id from public.add_tour_scene(:'ta', pg_temp.id('T'), 1, (select version_id from media where name = 'p1'), 'Sala');
insert into ids select 'pscene', scene_id from public.add_tour_scene(:'ta', pg_temp.id('P'), 1, (select version_id from media where name = 'p2'), 'Plaza');
select * from public.add_tour_hotspot(:'ta', pg_temp.id('T'), 2, pg_temp.id('sala'), jsonb_build_object(
  'kind', 'tour', 'title', 'Ir a la plaza', 'position', '{"yaw":2,"pitch":0}'::jsonb, 'targetContentId', pg_temp.id('plaza')));
insert into ids select 'to_museo', hotspot_id from public.add_tour_hotspot(:'ta', pg_temp.id('P'), 2, pg_temp.id('pscene'), jsonb_build_object(
  'kind', 'tour', 'title', 'Ir al museo', 'position', '{"yaw":1,"pitch":0}'::jsonb, 'targetContentId', pg_temp.id('museo')));
insert into ids select 'T1', revision_id from public.publish_tour(:'ta', pg_temp.id('T'), 3);
insert into ids select 'P1', revision_id from public.publish_tour(:'ta', pg_temp.id('P'), 3);
select * from public.save_general_tour(:'ta', coalesce((select edit_count from public.general_tours where tenant_id = :'ta'), 0),
  array[pg_temp.id('T'), pg_temp.id('P')], pg_temp.id('T'));

-- What the assistant read from T (as the indexer would store it).
reset role;
insert into public.knowledge_chunks (tenant_id, tour_id, tour_revision_id, chunker_version, chunk_no, title, heading, body, sha256)
values (:'ta', pg_temp.id('T'), pg_temp.id('T1'), 1, 0, 'Museo', 'Sala', 'La sala del museo.', :'sha');
insert into public.knowledge_indexed_revisions (tenant_id, tour_revision_id, chunker_version, chunks, characters)
values (:'ta', pg_temp.id('T1'), 1, 1, 18);

select plan(46);

-- ── What deleting or moving changes ────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to :'a4c';
select results_eq(
  format($$select revisions, published, in_general_tour, starts_general_tour,
                  linked_from -> 0 ->> 'contentTitle', linked_from -> 0 -> 'published',
                  linked_from -> 0 -> 'draft', jsonb_array_length(linked_from)
           from public.tour_removal_impact(%L, %L)$$, :'ta', pg_temp.id('T')),
  $$values (1, true, true, true, 'Plaza', 'true'::jsonb, 'false'::jsonb, 1)$$,
  'any member sees what deleting or moving T changes: the plaza tour leads to it'
);
set local request.jwt.claims to :'b1c';
select throws_ok(format('select * from public.tour_removal_impact(%L, %L)', :'ta', pg_temp.id('T')),
  '42501', null, 'another municipality does not');

-- ── Who moves ───────────────────────────────────────────────────────────────
set local request.jwt.claims to :'a3c';
select throws_ok(format('select * from public.move_tour(%L, %L, %L)', :'ta', pg_temp.id('T'), pg_temp.id('mirador')),
  '42501', null, 'an editor does not move a tour');
set local request.jwt.claims to :'a4c';
select throws_ok(format('select * from public.move_tour(%L, %L, %L)', :'ta', pg_temp.id('T'), pg_temp.id('mirador')),
  '42501', null, 'nor an analyst');
set local request.jwt.claims to :'b1c';
select throws_ok(format('select * from public.move_tour(%L, %L, %L)', :'ta', pg_temp.id('T'), pg_temp.id('mirador')),
  '42501', null, 'nor another municipality');
select throws_ok(format('select * from public.move_tour(%L, %L, %L)', :'tb', pg_temp.id('T'), pg_temp.id('mirador')),
  'PT404', null, 'nor A''s tour seen from B');

-- ── Where it can go ─────────────────────────────────────────────────────────
set local request.jwt.claims to :'a2c';
select throws_ok(format('select * from public.move_tour(%L, %L, %L)', :'ta', pg_temp.id('T'), pg_temp.id('museo')),
  'PT409', 'the tour is already there', 'not where it is');
select throws_ok(format('select * from public.move_tour(%L, %L, %L)', :'ta', pg_temp.id('T'), pg_temp.id('plaza')),
  'PT409', 'that place already has a tour', 'not to a place with a tour');
select throws_ok(format('select * from public.move_tour(%L, %L, %L)', :'ta', pg_temp.id('T'), pg_temp.id('guia')),
  '23514', null, 'not to a knowledge text');
select throws_ok(format('select * from public.move_tour(%L, %L, %L)', :'ta', pg_temp.id('T'), gen_random_uuid()),
  'PT404', null, 'not to an unknown place');
-- A draft point of T leads to the mirador: T cannot go there while it does.
insert into ids select 'to_mirador', hotspot_id from public.add_tour_hotspot(:'ta', pg_temp.id('T'), null, pg_temp.id('sala'), jsonb_build_object(
  'kind', 'tour', 'title', 'Ir al mirador', 'position', '{"yaw":0,"pitch":0}'::jsonb, 'targetContentId', pg_temp.id('mirador')));
select throws_ok(format('select * from public.move_tour(%L, %L, %L)', :'ta', pg_temp.id('T'), pg_temp.id('mirador')),
  'PT409', 'a point of the tour leads to that place', 'not to a place its own points lead to');
select public.discard_tour_draft(:'ta', pg_temp.id('T'), pg_temp.edit(pg_temp.id('T')));

-- ── Moving T to the mirador ─────────────────────────────────────────────────
select results_eq(
  format('select from_kind::text, from_slug, to_kind::text, to_slug from public.move_tour(%L, %L, %L)', :'ta', pg_temp.id('T'), pg_temp.id('mirador')),
  $$values ('destination', 'museo', 'destination', 'mirador')$$,
  'an admin moves T to the mirador'
);
reset role;
select is((select content_id from public.tours where id = pg_temp.id('T')), pg_temp.id('mirador'), 'the tour is the mirador''s now');
select is((select published_revision_id from public.tours where id = pg_temp.id('T')), pg_temp.id('T1'), 'with its published version');
select ok(exists (select 1 from public.general_tour_entries where tenant_id = :'ta' and tour_id = pg_temp.id('T') and position = 0)
          and (select start_tour_id from public.general_tours where tenant_id = :'ta') = pg_temp.id('T'),
  'and its place in the general tour');
select is((select tour_id from public.tour_redirects where tenant_id = :'ta' and content_id = pg_temp.id('museo')), pg_temp.id('T'),
  'the museo remembers where its tour went');
select is((select title from public.knowledge_chunks where tour_id = pg_temp.id('T')), 'Mirador',
  'the assistant cites it under its new place');
select is((select diff from public.audit_events where action = 'tour.moved' and entity_id = pg_temp.id('T')),
  jsonb_build_object('from', pg_temp.id('museo'), 'to', pg_temp.id('mirador')), 'the move is audited');

-- Visitors.
set local role anon;
select is((select title from public.portal_tour(:'ta', 'destination', 'mirador')), 'Mirador', 'visitors open the tour at the mirador');
select is((select count(*)::int from public.portal_tour(:'ta', 'destination', 'museo')), 0, 'not at the museo');
select results_eq(
  format($$select kind::text, slug, target from public.portal_tour_redirect(%L, 'destination', 'museo')$$, :'ta'),
  $$values ('destination', 'mirador', 'tour')$$,
  'the museo''s old tour page leads to the mirador''s tour'
);
select is((select count(*)::int from public.portal_tour_redirect(:'ta', 'destination', 'mirador')), 0, 'a page with its tour leads nowhere');
select is((select count(*)::int from public.portal_tour_redirect(:'ta', 'event', 'feria')), 0, 'nor an unpublished place');
select is((select count(*)::int from public.portal_tour_redirect(:'tb', 'destination', 'museo')), 0, 'nor another municipality''s address');
select ok(not ((select targets from public.portal_tour(:'ta', 'destination', 'plaza')) ? pg_temp.id('museo')::text),
  'the plaza''s "go to the museo" is hidden: the museo has no tour now');

-- ── A tour never links to its own place ────────────────────────────────────
-- P's published version leads to the museo: P cannot go there.
set local role authenticated;
set local request.jwt.claims to :'a1c';
select throws_ok(format('select * from public.move_tour(%L, %L, %L)', :'ta', pg_temp.id('P'), pg_temp.id('museo')),
  'PT409', 'a point of the tour leads to that place', 'its published version counts when it has no draft');
-- Without that point (version 2) it can; back to version 1, the old point is not offered.
select * from public.remove_tour_hotspot(:'ta', pg_temp.id('P'), null, pg_temp.id('to_museo'));
select * from public.publish_tour(:'ta', pg_temp.id('P'), pg_temp.edit(pg_temp.id('P')));
select lives_ok(format('select * from public.move_tour(%L, %L, %L)', :'ta', pg_temp.id('P'), pg_temp.id('museo')),
  'the owner moves P to the museo');
reset role;
select is((select count(*)::int from public.tour_redirects where tenant_id = :'ta' and content_id = pg_temp.id('museo')), 0,
  'a place that gets a tour stops redirecting');
set local role authenticated;
set local request.jwt.claims to :'a1c';
select * from public.restore_tour_revision(:'ta', pg_temp.id('P'), pg_temp.id('P1'));
set local role anon;
select ok(not ((select targets from public.portal_tour(:'ta', 'destination', 'museo')) ? pg_temp.id('museo')::text),
  'version 1 leads to the museo, its own place now: visitors do not get that point');

-- ── Who deletes ─────────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to :'a3c';
select throws_ok(format('select * from public.delete_tour(%L, %L)', :'ta', pg_temp.id('T')), '42501', null, 'an editor does not delete a tour');
set local request.jwt.claims to :'b1c';
select throws_ok(format('select * from public.delete_tour(%L, %L)', :'ta', pg_temp.id('T')), '42501', null, 'nor another municipality');
select throws_ok(format('select * from public.delete_tour(%L, %L)', :'tb', pg_temp.id('T')), 'PT404', null, 'nor A''s tour seen from B');
select throws_ok($$insert into private.tour_deletions values (gen_random_uuid(), pg_current_xact_id())$$, '42501', null,
  'nobody marks a tour as being deleted');
reset role;
select throws_ok(format($$delete from public.tour_revisions where tour_id = %L and state = 'sealed'$$, pg_temp.id('T')),
  '23514', 'sealed revisions are immutable', 'a sealed revision is still immutable outside a tour''s deletion');

-- ── Deleting T ──────────────────────────────────────────────────────────────
-- First T moves on to the (unpublished) feria: the mirador's page leads to it now.
set local role authenticated;
set local request.jwt.claims to :'a1c';
select results_eq(
  format('select to_kind::text, to_slug, former_places from public.move_tour(%L, %L, %L)', :'ta', pg_temp.id('T'), pg_temp.id('feria')),
  $$values ('event', 'feria', '[]'::jsonb)$$,
  'a tour moves on to an event; the museo it had left has a tour now, so no former place'
);
select results_eq(
  format('select content_kind::text, content_slug, former_places from public.delete_tour(%L, %L)', :'ta', pg_temp.id('T')),
  $$values ('event', 'feria', '[{"kind":"destination","slug":"mirador"}]'::jsonb)$$,
  'the owner deletes T: its place, and the place it had left (its page must be refreshed)'
);
reset role;
select ok(not exists (select 1 from public.tours where id = pg_temp.id('T'))
          and not exists (select 1 from public.tour_revisions where tour_id = pg_temp.id('T'))
          and not exists (select 1 from public.tour_scenes where tour_revision_id = pg_temp.id('T1')),
  'the tour, its revisions and scenes are gone');
select results_eq(
  format($$select tour_id, position from public.general_tour_entries where tenant_id = %L$$, :'ta'),
  format($$values (%L::uuid, 0)$$, pg_temp.id('P')),
  'the general tour keeps the plaza''s tour, first'
);
select is((select start_tour_id from public.general_tours where tenant_id = :'ta'), null::uuid, 'and starts with the first one');
select ok(not exists (select 1 from public.knowledge_chunks where tour_id = pg_temp.id('T'))
          and not exists (select 1 from public.knowledge_indexed_revisions where tour_revision_id = pg_temp.id('T1')),
  'what the assistant read from it is gone');
select is((select count(*)::int from public.tour_redirects where tour_id = pg_temp.id('T')), 0, 'and where it had been');
select is((select count(*)::int from private.tour_deletions), 0, 'nothing stays marked');
select results_eq(
  format($$select diff ->> 'content_id', (diff ->> 'revisions')::int, (diff ->> 'was_published')::boolean
           from public.audit_events where action = 'tour.deleted' and entity_id = %L$$, pg_temp.id('T')),
  format($$values (%L, 1, true)$$, pg_temp.id('feria')),
  'the deletion is audited'
);

-- Visitors: the mirador's tour page leads to the mirador.
set local role anon;
select results_eq(
  format($$select kind::text, slug, target from public.portal_tour_redirect(%L, 'destination', 'mirador')$$, :'ta'),
  $$values ('destination', 'mirador', 'place')$$,
  'the deleted tour''s page leads to its place'
);

-- Its panorama is free now (ADR-048).
set local role authenticated;
set local request.jwt.claims to :'a1c';
select lives_ok(format('select public.delete_media_asset(%L, %L)', :'ta', (select asset from media where name = 'p1')),
  'its panorama can be deleted');
select throws_ok(format('select * from public.delete_tour(%L, %L)', :'ta', pg_temp.id('T')), 'PT404', null, 'deleting it again: not found');

select * from finish();
rollback;
