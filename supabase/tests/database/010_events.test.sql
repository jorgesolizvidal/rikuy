-- Events: schedule validation, venue, publication rules, the agenda that drops ended
-- events by itself (in the tenant's time zone), drafts and isolation.
begin;
set local client_min_messages to warning;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

\set ta 'aaaaaaaa-0000-4000-8000-000000000001'
\set tb 'bbbbbbbb-0000-4000-8000-000000000001'
\set a1c '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated"}'
\set a2c '{"sub":"00000000-0000-4000-8000-0000000000a2","role":"authenticated"}'
\set b1c '{"sub":"00000000-0000-4000-8000-0000000000b1","role":"authenticated"}'

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000a1', 'owner.a@example.test'),
  ('00000000-0000-4000-8000-0000000000a2', 'editor.a@example.test'),
  ('00000000-0000-4000-8000-0000000000b1', 'owner.b@example.test');
insert into public.tenants (id, slug, display_name, status, default_locale, timezone) values
  (:'ta', 'tenant-a', 'Tenant A', 'provisioning', 'es', 'America/La_Paz'),
  (:'tb', 'tenant-b', 'Tenant B', 'provisioning', 'es', 'Asia/Tokyo');
insert into public.memberships (tenant_id, user_id, role, status, accepted_at) values
  (:'ta', '00000000-0000-4000-8000-0000000000a1', 'owner', 'active', now()),
  (:'ta', '00000000-0000-4000-8000-0000000000a2', 'editor', 'active', now()),
  (:'tb', '00000000-0000-4000-8000-0000000000b1', 'owner', 'active', now());
insert into public.tenant_domains (id, tenant_id, hostname, kind, status, verified_at) values
  ('aaaaaaaa-0000-4000-8000-0000000000d1', :'ta', 'tenant-a.localhost', 'platform', 'active', now()),
  ('bbbbbbbb-0000-4000-8000-0000000000d1', :'tb', 'tenant-b.localhost', 'platform', 'active', now());
update public.tenants set canonical_domain_id = 'aaaaaaaa-0000-4000-8000-0000000000d1' where id = :'ta';
update public.tenants set canonical_domain_id = 'bbbbbbbb-0000-4000-8000-0000000000d1' where id = :'tb';
update public.tenants set status = 'active';
set constraints all immediate;

select plan(34);

-- ── Time zones ─────────────────────────────────────────────────────────────
select throws_ok(
  $$update public.tenants set timezone = 'Mars/Olympus' where id = 'aaaaaaaa-0000-4000-8000-000000000001'$$,
  '23514', null, 'a tenant time zone must exist');

-- Local "now" in tenant A, as editors would write it.
select to_char(now() at time zone 'America/La_Paz', 'YYYY-MM-DD') as today,
       to_char(now() at time zone 'America/La_Paz' + interval '1 day', 'YYYY-MM-DD') as tomorrow,
       to_char(now() at time zone 'America/La_Paz' - interval '1 day', 'YYYY-MM-DD') as yesterday,
       to_char(now() at time zone 'America/La_Paz' - interval '2 hours', 'YYYY-MM-DD"T"HH24:MI') as two_hours_ago,
       to_char(now() at time zone 'America/La_Paz' - interval '1 hour', 'YYYY-MM-DD"T"HH24:MI') as hour_ago,
       to_char(now() at time zone 'America/La_Paz' + interval '7 days', 'YYYY-MM-DD"T"HH24:MI') as next_week,
       to_char(now() at time zone 'America/La_Paz' + interval '7 days 3 hours', 'YYYY-MM-DD"T"HH24:MI') as next_week_end
\gset

-- A destination to use as venue, published.
set local role authenticated;
set local request.jwt.claims to :'a1c';
select content_id as venue from public.create_content_item(:'ta', 'destination', 'plaza', 'Plaza') \gset
select public.save_content_draft(:'ta', :'venue',
  '{"title":"Plaza","summary":"La plaza","body":[],"location":{"lat":-17.4,"lng":-66.1},"cover":null,"gallery":[]}'::jsonb, 1);
select public.publish_content(:'ta', :'venue', 2);

-- ── Creating and validating ────────────────────────────────────────────────
set local request.jwt.claims to :'a2c';
select content_id as e1 from public.create_content_item(:'ta', 'event', 'feria', 'Feria') \gset
select ok(:'e1' is not null, 'editors create events');
select is(
  (select public.content_revision_document(:'ta', r.id) from public.content_items i
   join public.content_revisions r on r.id = i.draft_revision_id where i.id = :'e1') ->> 'schedule',
  null, 'a new event has no schedule yet');
select ok(
  (select doc ? 'title' and not doc ? 'schedule' and not doc ? 'venueId'
   from (select public.content_revision_document(:'ta', i.published_revision_id) as doc
         from public.content_items i where i.id = :'venue') d),
  'destinations keep their document shape (no schedule key)');

\set base '"title":"Feria","summary":"Feria del valle","body":[],"location":{"lat":-17.4,"lng":-66.1},"cover":null,"gallery":[]'
select throws_ok(format($$select public.save_content_draft('%s', '%s', '{%s,"schedule":{"allDay":false,"start":"2026-11-02T19:00","end":"2026-11-02T18:00"},"venueId":null}'::jsonb, 1)$$, :'ta', :'e1', :'base'),
  '23514', null, 'the end cannot be before the start');
select throws_ok(format($$select public.save_content_draft('%s', '%s', '{%s,"schedule":{"allDay":true,"start":"2026-02-30","end":"2026-02-30"},"venueId":null}'::jsonb, 1)$$, :'ta', :'e1', :'base'),
  '23514', null, 'dates must exist');
select throws_ok(format($$select public.save_content_draft('%s', '%s', '{%s,"schedule":{"allDay":false,"start":"2026-11-02T24:00","end":"2026-11-03T01:00"},"venueId":null}'::jsonb, 1)$$, :'ta', :'e1', :'base'),
  '23514', null, '24:00 is not a time');
select throws_ok(format($$select public.save_content_draft('%s', '%s', '{%s,"schedule":{"allDay":true,"start":"2026-11-02T10:00","end":"2026-11-02T12:00"},"venueId":null}'::jsonb, 1)$$, :'ta', :'e1', :'base'),
  '23514', null, 'all-day events take dates, not times');
select throws_ok(format($$select public.save_content_draft('%s', '%s', '{%s,"schedule":{"allDay":true,"start":"2026-01-01","end":"2027-06-01"},"venueId":null}'::jsonb, 1)$$, :'ta', :'e1', :'base'),
  '23514', null, 'an event lasts at most a year');
select throws_ok(format($$select public.save_content_draft('%s', '%s', '{%s,"schedule":null}'::jsonb, 1)$$, :'ta', :'e1', :'base'),
  '23514', null, 'events need the venueId key (exact shape)');
select throws_ok(format($$select public.save_content_draft('%s', '%s', '{%s,"schedule":null,"venueId":"%s"}'::jsonb, 1)$$, :'ta', :'e1', :'base', :'e1'),
  '23514', null, 'the venue must be a destination, not an event');
select throws_ok(format($$select public.save_content_draft('%s', '%s', '{%s,"schedule":null,"venueId":null}'::jsonb, 2)$$, :'ta', :'venue', :'base'),
  '23514', null, 'a destination does not accept event fields');

-- Valid draft without a date: saved, but not publishable.
select is((select edit_count from public.save_content_draft(:'ta', :'e1',
  format('{%s,"schedule":null,"venueId":"%s"}', :'base', :'venue')::jsonb, 1)), 2, 'a draft without date is saved');
set local request.jwt.claims to :'a1c';
select throws_ok(format($$select public.publish_content('%s', '%s', 2)$$, :'ta', :'e1'),
  '23514', null, 'an event without a date cannot be published');

set local request.jwt.claims to :'a2c';
select is((select edit_count from public.save_content_draft(:'ta', :'e1',
  format('{%s,"schedule":{"allDay":false,"start":"%s","end":"%s"},"venueId":"%s"}', :'base', :'next_week', :'next_week_end', :'venue')::jsonb, 2)),
  3, 'a complete event is saved');
select is(
  (select public.content_revision_document(:'ta', r.id) from public.content_items i
   join public.content_revisions r on r.id = i.draft_revision_id where i.id = :'e1') -> 'schedule',
  jsonb_build_object('allDay', false, 'start', :'next_week', 'end', :'next_week_end'),
  'the schedule comes back exactly as written');
select throws_ok(format($$select public.publish_content('%s', '%s', 3)$$, :'ta', :'e1'),
  '42501', null, 'editors cannot publish events');
set local request.jwt.claims to :'a1c';
select is((select revision_no from public.publish_content(:'ta', :'e1', 3)), 1, 'owners publish events');

-- ── Ended or not, in the tenant time zone ──────────────────────────────────
-- e2: timed, ended one hour ago local time (still "in the future" if read as UTC).
select content_id as e2 from public.create_content_item(:'ta', 'event', 'charla', 'Charla') \gset
select public.save_content_draft(:'ta', :'e2',
  format('{%s,"schedule":{"allDay":false,"start":"%s","end":"%s"},"venueId":null}', :'base', :'two_hours_ago', :'hour_ago')::jsonb, 1);
select public.publish_content(:'ta', :'e2', 2);
-- e3: all-day event whose last day is today: still on the agenda until midnight.
select content_id as e3 from public.create_content_item(:'ta', 'event', 'mercado', 'Mercado') \gset
select public.save_content_draft(:'ta', :'e3',
  format('{%s,"schedule":{"allDay":true,"start":"%s","end":"%s"},"venueId":null}', :'base', :'yesterday', :'today')::jsonb, 1);
select public.publish_content(:'ta', :'e3', 2);
-- e4: all-day, ended yesterday.
select content_id as e4 from public.create_content_item(:'ta', 'event', 'carnaval', 'Carnaval') \gset
select public.save_content_draft(:'ta', :'e4',
  format('{%s,"schedule":{"allDay":true,"start":"%s","end":"%s"},"venueId":null}', :'base', :'yesterday', :'yesterday')::jsonb, 1);
select public.publish_content(:'ta', :'e4', 2);
-- e5: a draft with a future date, never published.
select content_id as e5 from public.create_content_item(:'ta', 'event', 'borrador', 'Borrador') \gset
select public.save_content_draft(:'ta', :'e5',
  format('{%s,"schedule":{"allDay":true,"start":"%s","end":"%s"},"venueId":null}', :'base', :'tomorrow', :'tomorrow')::jsonb, 1);

set local role anon;
select is(
  (select array_agg(slug order by slug) from public.portal_events(:'ta')),
  array['feria', 'mercado'],
  'the agenda lists upcoming and ongoing events only (no ended ones, no drafts)');
select is((select ended from public.portal_event(:'ta', 'charla')), true, 'a timed event ended in local time is marked ended');
select is((select ended from public.portal_event(:'ta', 'mercado')), false, 'an all-day event lasts until the end of its last day');
select is((select ended from public.portal_event(:'ta', 'carnaval')), true, 'an all-day event that ended yesterday is marked ended');
select is((select count(*)::int from public.portal_event(:'ta', 'borrador')), 0, 'drafts have no public page');
select is((select venue from public.portal_events(:'ta') where slug = 'feria'),
  jsonb_build_object('slug', 'plaza', 'title', 'Plaza'), 'the venue is the published destination');
select is((select starts_at from public.portal_events(:'ta') where slug = 'feria'),
  (:'next_week')::timestamp at time zone 'America/La_Paz', 'the start instant uses the tenant time zone');
select is((select count(*)::int from public.portal_events(:'tb')), 0, 'another tenant sees none of them');
select is((select count(*)::int from public.portal_event(:'tb', 'feria')), 0, 'nor serves them under its host');
select is((select count(*)::int from public.portal_events(:'ta') where slug = 'plaza'), 0, 'destinations are not events');
select ok(not has_function_privilege('anon', 'public.list_content_events(uuid)', 'EXECUTE'), 'visitors cannot list the panel agenda');

-- ── Panel agenda for members ───────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to :'a2c';
select is((select count(*)::int from public.list_content_events(:'ta')), 5, 'members see every event, drafts included');
select is((select array_agg(slug order by slug) from public.list_content_events(:'ta') where ended),
  array['carnaval', 'charla'], 'and which ones already ended');
set local request.jwt.claims to :'b1c';
select throws_ok(format($$select * from public.list_content_events('%s')$$, :'ta'),
  '42501', null, 'members of another tenant cannot list it');

-- ── Unpublished venue disappears from the event page, the event stays ──────
reset role;
update public.content_items set published_revision_id = null, published_at = null where id = :'venue';
set local role anon;
select is((select venue from public.portal_event(:'ta', 'feria')), null, 'an unpublished venue is not shown');

-- ── Suspension hides the agenda ────────────────────────────────────────────
reset role;
update public.tenants set status = 'suspended' where id = :'ta';
set local role anon;
select is((select count(*)::int from public.portal_events(:'ta')), 0, 'a suspended portal has no agenda');

select * from finish();
rollback;
