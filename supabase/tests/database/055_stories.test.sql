-- A · Paso 1.3 (ADR-069): the community's memory. The module, what a draft accepts (and that
-- «anónimo» keeps no name), who prepares and who publishes, that publishing asks for the text,
-- who tells it and the person's consent (kept in the revision and the audit), what visitors read,
-- «Retirar», what the indexer reads, and that the other kinds of content stay as they were.
begin;
set local client_min_messages to warning;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

\set ta 'aaaaaaaa-0000-4000-8000-000000000001'
\set tb 'bbbbbbbb-0000-4000-8000-000000000001'
\set a1c '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}'
\set a3c '{"sub":"00000000-0000-4000-8000-0000000000a3","role":"authenticated","aal":"aal2"}'
\set a4c '{"sub":"00000000-0000-4000-8000-0000000000a4","role":"authenticated","aal":"aal2"}'
\set b1c '{"sub":"00000000-0000-4000-8000-0000000000b1","role":"authenticated","aal":"aal2"}'

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
-- The seed's own indexing jobs stay out of the claim below.
update public.background_jobs set available_at = now() + interval '1 day'
where kind = 'knowledge.index' and status = 'pending';
grant usage on schema extensions to rikuy_worker;
do $$ begin execute format('grant temporary on database %I to rikuy_worker', current_database()); end $$;

-- A story as the editor writes it; each test changes one thing.
create function pg_temp.story(p_changes jsonb default '{}')
returns jsonb
language sql
as $$
  select jsonb_build_object(
    'title', 'La noche de la helada',
    'summary', 'Cómo se salvó la cosecha del 63.',
    'body', '[{"type":"paragraph","children":[{"type":"text","text":"Mi abuelo encendió fogatas toda la noche."}]}]'::jsonb,
    'author', 'Doña Rosa Vargas',
    'anonymous', false,
    'community', 'Vecina de la plaza',
    'placeId', null,
    'consent', true
  ) || p_changes;
$$;

select plan(42);

-- ── The module ──────────────────────────────────────────────────────────────
select ok(exists (select 1 from public.platform_modules where key = 'community_memory'),
  'the community''s memory is a module');
select ok(private.has_module(:'ta', 'community_memory'), 'a new municipality has it');
select ok(has_function_privilege('anon', 'public.portal_stories(uuid)', 'EXECUTE'), 'visitors read the stories');

-- ── Drafts ──────────────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to :'a1c';
create temp table plaza as select * from public.create_content_item(:'ta', 'destination', 'plaza', 'Plaza');
select * from public.save_content_draft(:'ta', (select content_id from plaza),
  '{"title":"Plaza principal","summary":"La plaza.","body":[],"location":{"lat":-17.39,"lng":-66.15},"cover":null,"gallery":[]}', 1);
select * from public.publish_content(:'ta', (select content_id from plaza), 2);
create temp table fair as select * from public.create_content_item(:'ta', 'event', 'feria', 'Feria');
set local request.jwt.claims to :'a3c';
create temp table frost as select * from public.create_content_item(:'ta', 'story', 'la-helada', 'La noche de la helada');
select ok((select content_id from frost) is not null, 'an editor creates a story');
select lives_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 1)', :'ta', (select content_id from frost),
    pg_temp.story(jsonb_build_object('placeId', (select content_id from plaza)))),
  'and saves its text, who tells it, their community, its place and the consent'
);
select is(
  public.content_revision_document(:'ta', (select draft_revision_id from public.content_items where id = (select content_id from frost))),
  pg_temp.story(jsonb_build_object('placeId', (select content_id from plaza))), 'the editor reads it back as written'
);
select lives_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 2)', :'ta', (select content_id from frost),
    pg_temp.story('{"anonymous":true}')),
  'it can be told by «anónimo»'
);
select is(
  (select r.story_author from public.content_revisions r
   where r.id = (select draft_revision_id from public.content_items where id = (select content_id from frost))),
  null, 'and then the name is not kept'
);
select is(
  public.content_revision_document(:'ta', (select draft_revision_id from public.content_items where id = (select content_id from frost))) ->> 'author',
  '', 'not even in what the editor reads back'
);
select throws_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 3)', :'ta', (select content_id from frost),
    pg_temp.story(jsonb_build_object('placeId', (select content_id from fair)))),
  '23514', null, 'its place is a destination, not an event'
);
select throws_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 3)', :'ta', (select content_id from frost),
    pg_temp.story('{"consent":"sí"}')),
  '23514', null, 'the consent is a yes or a no'
);
select throws_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 3)', :'ta', (select content_id from frost),
    pg_temp.story(jsonb_build_object('author', E'Rosa\nVargas'))),
  '23514', null, 'who tells it is one line'
);
select throws_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 3)', :'ta', (select content_id from frost),
    pg_temp.story('{"location":null}')),
  '23514', null, 'a story has no other keys'
);
select throws_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 3)', :'ta', (select content_id from frost),
    pg_temp.story('{"body":[{"type":"paragraph","children":[{"type":"link","href":"javascript:alert(1)","children":[{"type":"text","text":"x"}]}]}]}')),
  '23514', null, 'its text is the allowed rich text only'
);
select lives_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 3)', :'ta', (select content_id from frost),
    pg_temp.story(jsonb_build_object('placeId', (select content_id from plaza)))),
  'the editor puts the name back'
);
select throws_ok(
  format('select * from public.publish_content(%L, %L, 4)', :'ta', (select content_id from frost)),
  '42501', null, 'an editor cannot publish a story'
);
select throws_ok(
  format('select public.retire_content(%L, %L)', :'ta', (select content_id from frost)),
  '42501', null, 'nor retire it'
);
set local request.jwt.claims to :'a4c';
select throws_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 4)', :'ta', (select content_id from frost), pg_temp.story()),
  '42501', null, 'an analyst cannot change it'
);
set local request.jwt.claims to :'b1c';
select throws_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 4)', :'ta', (select content_id from frost), pg_temp.story()),
  '42501', null, 'nor the owner of another municipality'
);

-- ── Publishing: text, who tells it and consent ──────────────────────────────
set local request.jwt.claims to :'a1c';
create temp table untold as select * from public.create_content_item(:'ta', 'story', 'sin-permiso', 'Sin permiso');
select * from public.save_content_draft(:'ta', (select content_id from untold),
  pg_temp.story('{"title":"Sin permiso","consent":false}'), 1);
select throws_ok(
  format('select * from public.publish_content(%L, %L, 2)', :'ta', (select content_id from untold)),
  '23514', null, 'without the person''s consent it is not published'
);
select * from public.save_content_draft(:'ta', (select content_id from untold),
  pg_temp.story('{"title":"Sin permiso","author":"","consent":true}'), 2);
select throws_ok(
  format('select * from public.publish_content(%L, %L, 3)', :'ta', (select content_id from untold)),
  '23514', null, 'nor without who tells it'
);
select * from public.save_content_draft(:'ta', (select content_id from untold),
  pg_temp.story('{"title":"Sin permiso","body":[]}'), 3);
select throws_ok(
  format('select * from public.publish_content(%L, %L, 4)', :'ta', (select content_id from untold)),
  '23514', null, 'nor without its text'
);
select is((select revision_no from public.publish_content(:'ta', (select content_id from frost), 4)), 1,
  'the owner publishes it');
create temp table tale as select * from public.create_content_item(:'ta', 'story', 'el-molino', 'El molino');
select * from public.save_content_draft(:'ta', (select content_id from tale),
  pg_temp.story('{"title":"El molino","anonymous":true,"community":""}'), 1);
select is((select revision_no from public.publish_content(:'ta', (select content_id from tale), 2)), 1,
  'an anonymous story is published too');
reset role;
select is(
  (select r.story_consent from public.content_revisions r
   join public.content_items i on i.published_revision_id = r.id where i.id = (select content_id from frost)),
  true, 'the sealed revision keeps the consent'
);
select is(
  (select diff -> 'consent' from public.audit_events where action = 'content.published' and entity_id = (select content_id from frost)),
  'true'::jsonb, 'and so does the audit'
);
select throws_ok(
  format('update public.content_revisions set story_author = %L, story_anonymous = true where content_id = %L',
    'Alguien', (select content_id from untold)),
  '23514', null, 'the table itself keeps no name for «anónimo»'
);
grant select on frost, tale, untold, plaza to authenticated, anon, rikuy_worker;

-- ── What visitors read ──────────────────────────────────────────────────────
set local role anon;
select results_eq(
  format('select slug, author, anonymous, community, place_slug, place_title from public.portal_stories(%L) order by slug', :'ta'),
  $$values ('el-molino', null::text, true, null::text, null::text, null::text),
           ('la-helada', 'Doña Rosa Vargas', false, 'Vecina de la plaza', 'plaza', 'Plaza principal')$$,
  'the published stories with who tells them and their place, never the drafts'
);
select is((select count(*)::int from public.portal_stories(:'tb')), 0, 'another municipality reads none of them');
reset role;
update public.tenants set status = 'suspended' where id = :'ta';
set local role anon;
select is((select count(*)::int from public.portal_stories(:'ta')), 0, 'nor anyone while it is suspended');
reset role;
update public.tenants set status = 'active' where id = :'ta';

-- ── «Retirar» (the person asked to take it down) ────────────────────────────
set local role authenticated;
set local request.jwt.claims to :'a1c';
select lives_ok(format('select public.retire_content(%L, %L)', :'ta', (select content_id from tale)),
  'the owner retires a story');
set local role anon;
select is((select array_agg(slug) from public.portal_stories(:'ta')), array['la-helada'], 'and visitors stop seeing it');
reset role;
select is(
  (select diff ->> 'kind' from public.audit_events where action = 'content.retired' and entity_id = (select content_id from tale)),
  'story', 'retiring it is audited'
);

-- ── What the assistant's indexer reads ──────────────────────────────────────
select ok(exists (
  select 1 from public.background_jobs j
  join public.content_items i on i.id = (select content_id from frost)
  where j.kind = 'knowledge.index' and j.subject_id = i.published_revision_id
), 'publishing a story queues its indexing');
-- Only this story's indexing is claimed.
update public.background_jobs set available_at = now() + interval '1 day'
where kind = 'knowledge.index' and status = 'pending'
  and subject_id <> (select published_revision_id from public.content_items where id = (select content_id from frost));
set local role rikuy_worker;
create temp table claim as select * from worker_api.claim_jobs('runner-m', 10, array['knowledge.index']);
reset role;
create temp table frost_job as
select c.job_id, c.fencing_token from claim c
join public.background_jobs j on j.id = c.job_id
where j.subject_id = (select published_revision_id from public.content_items where id = (select content_id from frost));
grant select on frost_job to rikuy_worker;
set local role rikuy_worker;
select is(
  (select worker_api.knowledge_source(job_id, fencing_token) -> 'story' from frost_job),
  '{"author":"Doña Rosa Vargas","anonymous":false,"community":"Vecina de la plaza"}'::jsonb,
  'it reads who tells it and their community'
);
select is(
  (select worker_api.knowledge_source(job_id, fencing_token) ->> 'placeTitle' from frost_job),
  'Plaza principal', 'and the published name of its place'
);
reset role;

-- ── The module off, and the other kinds as they were ────────────────────────
delete from public.tenant_modules where tenant_id = :'tb' and module = 'community_memory';
set local role authenticated;
set local request.jwt.claims to :'b1c';
select throws_ok(
  format('select * from public.create_content_item(%L, %L, %L, %L)', :'tb', 'story', 'relato', 'Relato'),
  'PT403', null, 'without the module, no story can be created'
);
set local request.jwt.claims to :'a1c';
select throws_ok(
  format('select * from public.save_content_draft(%L, %L, %L, null)', :'ta', (select content_id from plaza),
    '{"title":"Plaza","summary":"La plaza.","body":[],"location":null,"cover":null,"gallery":[],"consent":true}'),
  '23514', null, 'a destination takes none of the story''s fields'
);
select throws_ok(
  format('select * from public.create_tour(%L, %L)', :'ta', (select content_id from frost)),
  '23514', null, 'a story has no tour'
);
create temp table cut as select * from public.create_content_item(:'ta', 'notice', 'corte', 'Corte');
select throws_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 1)', :'ta', (select content_id from cut),
    jsonb_build_object('title', 'Corte', 'summary', 'Cerrado.', 'body', '[]'::jsonb,
      'validity', '{"from":null,"until":null}'::jsonb, 'placeId', (select content_id from frost))),
  '23514', null, 'nor is it a notice''s place'
);
reset role;
select is(
  (select r.story_consent from public.content_revisions r where r.content_id = (select content_id from plaza)),
  null, 'a destination never gets a consent of stories'
);
select ok(not has_function_privilege('anon', 'private.is_valid_story_draft(jsonb)', 'EXECUTE'),
  'visitors cannot call the validation');

select * from finish();
rollback;
