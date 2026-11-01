-- P5 · Paso 2 (ADR-037): the assistant's knowledge. Documents, knowledge content, chunks of
-- sealed revisions only, and searches that only ever see what is published NOW — never a
-- draft, a retired item, a replaced version, another municipality or a suspended one.
begin;
set local client_min_messages to warning;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

\set ta 'aaaaaaaa-0000-4000-8000-000000000001'
\set tb 'bbbbbbbb-0000-4000-8000-000000000001'
\set a1c '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated"}'
\set a3c '{"sub":"00000000-0000-4000-8000-0000000000a3","role":"authenticated"}'
\set a4c '{"sub":"00000000-0000-4000-8000-0000000000a4","role":"authenticated"}'
\set b1c '{"sub":"00000000-0000-4000-8000-0000000000b1","role":"authenticated"}'
\set sha '0000000000000000000000000000000000000000000000000000000000000abc'
\set manifest '{"version":1,"format":"pdf","pages":3,"characters":1200,"textFile":"document/text.json","encoding":"pdf"}'

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
-- The seed's own indexing jobs stay out of these claims.
update public.background_jobs set available_at = now() + interval '1 day'
where kind in ('knowledge.index', 'media.extract_document') and status = 'pending';

grant usage on schema extensions to rikuy_worker, rikuy_ai;
do $$ begin execute format('grant temporary on database %I to rikuy_worker, rikuy_ai', current_database()); end $$;

-- Stands in for the indexer: one chunk per claimed job, with the revision's summary.
create function pg_temp.index_claimed(p_claims regclass)
returns void
language plpgsql
as $$
declare
  v_claim record;
  v_title text;
  v_text text;
begin
  for v_claim in execute format('select job_id, fencing_token from %s', p_claims) loop
    select coalesce(r.title, tr.manifest #>> '{scenes,0,title}'),
           coalesce(r.summary, tr.manifest #>> '{scenes,0,description}')
      into v_title, v_text
    from public.background_jobs j
    left join public.content_revisions r on j.subject_type = 'content_revision' and r.id = j.subject_id
    left join public.tour_revisions tr on j.subject_type = 'tour_revision' and tr.id = j.subject_id
    where j.id = v_claim.job_id;
    perform worker_api.store_knowledge_chunks(
      v_claim.job_id, v_claim.fencing_token, 1, v_title,
      jsonb_build_array(jsonb_build_object(
        'chunkNo', 0, 'heading', null, 'body', coalesce(nullif(v_text, ''), v_title),
        'pageFrom', 2, 'pageTo', 3, 'sceneId', null, 'hotspotId', null, 'sha256', repeat('a', 64)))
    );
    perform worker_api.complete_job(v_claim.job_id, v_claim.fencing_token, '{"outcome":"stored"}', '{}');
  end loop;
end;
$$;

select plan(59);

-- ── Structure and privileges ────────────────────────────────────────────────
select ok(
  (select bool_and(relrowsecurity) from pg_class where relname in ('knowledge_chunks', 'knowledge_indexed_revisions')),
  'the knowledge tables have RLS'
);
select ok(not has_table_privilege('authenticated', 'public.knowledge_chunks', 'SELECT'), 'members never read chunks directly');
select ok(not has_table_privilege('anon', 'public.knowledge_chunks', 'SELECT'), 'nor visitors');
select ok(not has_function_privilege('anon', 'public.search_tenant_knowledge(uuid, text, integer)', 'EXECUTE'), 'visitors cannot search');
select ok(not has_function_privilege('authenticated', 'ai_api.search_knowledge(uuid, text, integer)', 'EXECUTE'), 'members cannot use the assistant''s search');
select ok(has_function_privilege('rikuy_ai', 'ai_api.search_knowledge(uuid, text, integer)', 'EXECUTE'), 'the AI role can');
select ok(not has_function_privilege('authenticated', 'worker_api.store_knowledge_chunks(uuid, bigint, integer, text, jsonb)', 'EXECUTE'), 'only the worker stores chunks');
select is(private.knowledge_terms('¿Qué fue la Ch''ampa Guerra en UCUREÑA?'), array['ampa', 'ch', 'guerr', 'ucuren'], 'questions become content words, without accents');

-- ── Documents ───────────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to :'a3c';
create temp table doc as select * from public.create_image_upload(:'ta', 'document', 'application/pdf', 5000000);
create temp table doc2 as select * from public.create_image_upload(:'ta', 'document', 'text/plain', 1000);
create temp table img as select * from public.create_image_upload(:'ta', 'content', 'image/jpeg', 1000);
select ok((select version_id from doc) is not null, 'an editor reserves a PDF document');
select throws_ok(
  format('select * from public.create_image_upload(%L, %L, %L, %s)', :'ta', 'document', 'application/pdf', 21000000),
  '23514', null, 'a document above 20 MB is refused'
);
select throws_ok(
  format('select * from public.create_image_upload(%L, %L, %L, %s)', :'ta', 'document', 'image/png', 1000),
  '23514', null, 'a document is a PDF or a text file'
);
select throws_ok(
  format('select public.submit_document(%L, %L)', :'ta', (select version_id from doc)),
  'PT409', null, 'nothing is read before the file is uploaded'
);
reset role;
insert into storage.objects (bucket_id, name) values
  ('media-originals', (select original_path from doc)),
  ('media-originals', (select original_path from doc2)),
  ('media-originals', (select original_path from img));
grant select on doc, doc2, img to rikuy_worker;
set local role authenticated;
set local request.jwt.claims to :'a3c';
select is(public.submit_document(:'ta', (select version_id from doc)), 'processing', 'submitting reads it in the background');
select is(public.submit_document(:'ta', (select version_id from doc2)), 'processing', 'also a text file');
select throws_ok(
  format('select public.submit_document(%L, %L)', :'ta', (select version_id from img)),
  'PT404', null, 'a photo is not a document'
);
set local request.jwt.claims to :'a4c';
select throws_ok(
  format('select public.submit_document(%L, %L)', :'ta', (select version_id from doc)),
  '42501', null, 'an analyst cannot submit documents'
);
reset role;
select is(
  (select count(*)::int from public.usage_reservations r where r.asset_version_id = (select version_id from doc) and r.resource = 'media_compute_seconds'),
  1, 'a document reserves processing time, like a panorama'
);

set local role rikuy_worker;
create temp table d1 as select * from worker_api.claim_jobs('runner-d', 2, array['media.extract_document']);
select is((select count(*)::int from d1), 1, 'one document at a time per municipality');
create temp table ds as select * from worker_api.document_source((select job_id from d1), (select fencing_token from d1));
select is((select status from ds), 'processing', 'the worker reads the source of its job');
select throws_ok(
  format('select worker_api.complete_document(%L, %s, %L, 5000000, %L, %L)',
    (select job_id from d1), (select fencing_token from d1), 'application/pdf', :'sha',
    '{"version":1,"format":"pdf","pages":3,"characters":10,"textFile":"../text.json","encoding":"pdf"}'),
  '23514', null, 'a manifest pointing outside the version is refused'
);
select throws_ok(
  format('select worker_api.complete_document(%L, %s, %L, 5000000, %L, %L)',
    (select job_id from d1), (select fencing_token from d1), 'text/plain', :'sha', :'manifest'),
  '23514', null, 'the real type must match the manifest'
);
select is(
  worker_api.complete_document((select job_id from d1), (select fencing_token from d1), 'application/pdf', 5000000, :'sha', :'manifest'),
  'ready', 'a read PDF is ready'
);
select worker_api.complete_job((select job_id from d1), (select fencing_token from d1), '{"outcome":"ready"}', '{}');
create temp table d2 as select * from worker_api.claim_jobs('runner-d', 1, array['media.extract_document']);
select is(
  worker_api.reject_document((select job_id from d2), (select fencing_token from d2), 'no_text'),
  'rejected', 'a scanned one is rejected with its reason'
);
reset role;

-- ── Knowledge content: drafts, publication, kind guards ────────────────────
set local role authenticated;
set local request.jwt.claims to :'a3c';
create temp table k as select * from public.create_content_item(:'ta', 'knowledge', 'libro', 'Libro de historia');
select throws_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 1)', :'ta', (select content_id from k),
    '{"title":"Libro","summary":"","body":[],"document":null,"location":null}'),
  '23514', null, 'a knowledge draft has exactly its own fields'
);
select throws_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 1)', :'ta', (select content_id from k),
    jsonb_build_object('title', 'Libro', 'summary', '', 'body', '[]'::jsonb,
      'document', jsonb_build_object('assetId', (select asset_id from img), 'version', 1))),
  '23514', null, 'a photo cannot be its document'
);
select throws_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 1)', :'ta', (select content_id from k),
    jsonb_build_object('title', 'Libro', 'summary', '', 'body', '[]'::jsonb,
      'document', jsonb_build_object('assetId', (select asset_id from doc2), 'version', 1))),
  '23514', null, 'nor a rejected document'
);
select lives_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 1)', :'ta', (select content_id from k),
    jsonb_build_object('title', 'Libro de historia', 'summary', 'La alpaca del valle.', 'body', '[]'::jsonb,
      'document', jsonb_build_object('assetId', (select asset_id from doc), 'version', 1))),
  'an editor saves a draft with its document'
);
select throws_ok(
  format('select * from public.publish_content(%L, %L, 2)', :'ta', (select content_id from k)),
  '42501', null, 'an editor cannot publish'
);
set local request.jwt.claims to :'b1c';
select throws_ok(
  format('select * from public.create_tour(%L, %L)', :'ta', (select content_id from k)),
  '42501', null, 'another municipality cannot touch it'
);
set local request.jwt.claims to :'a1c';
select throws_ok(
  format('select * from public.create_tour(%L, %L)', :'ta', (select content_id from k)),
  '23514', null, 'knowledge never has a tour'
);
select throws_ok(
  format('select public.retire_content(%L, %L)', :'ta', (select content_id from k)),
  'PT409', null, 'what was never published cannot be retired'
);
select is(
  (select revision_no from public.publish_content(:'ta', (select content_id from k), 2)), 1,
  'the owner publishes it'
);
reset role;
select is(
  (select count(*)::int from public.background_jobs j
   where j.kind = 'knowledge.index' and j.subject_type = 'content_revision'
     and j.subject_id = (select published_revision_id from public.content_items where id = (select content_id from k))),
  1, 'publishing enqueues its indexing, in the same transaction'
);

-- Draft text is never indexed: a chunk for a draft revision is refused.
set local role authenticated;
set local request.jwt.claims to :'a1c';
select lives_ok(
  format('select * from public.save_content_draft(%L, %L, %L, null)', :'ta', (select content_id from k),
    jsonb_build_object('title', 'Libro de historia', 'summary', 'El unicornio del valle.', 'body', '[]'::jsonb,
      'document', jsonb_build_object('assetId', (select asset_id from doc), 'version', 1))),
  'a new draft (version 2) starts'
);
reset role;
select throws_ok(
  format($q$insert into public.knowledge_chunks (tenant_id, content_id, content_revision_id, chunker_version, chunk_no, title, body, sha256)
           select %L, %L, i.draft_revision_id, 1, 0, 'Libro', 'El unicornio', repeat('a', 64)
           from public.content_items i where i.id = %L$q$,
         :'ta', (select content_id from k), (select content_id from k)),
  '23514', null, 'a draft revision can never have chunks'
);

-- The worker indexes version 1.
set local role rikuy_worker;
create temp table i1 as select * from worker_api.claim_jobs('runner-i', 5, array['knowledge.index']);
select is(
  (select worker_api.knowledge_source((select job_id from i1 limit 1), (select fencing_token from i1 limit 1)) ->> 'title'),
  'Libro de historia', 'the worker reads what to index under its lease'
);
select ok(
  (select worker_api.knowledge_source((select job_id from i1 limit 1), (select fencing_token from i1 limit 1)) #>> '{document,prefix}')
    = :'ta' || '/' || (select asset_id from doc)::text || '/1/',
  'with the folder of its document''s text'
);
reset role;
grant select on i1 to postgres;
select pg_temp.index_claimed('i1');

set local role authenticated;
set local request.jwt.claims to :'a4c';
select is(
  (select title || ' · ' || page_from || '–' || page_to from public.search_tenant_knowledge(:'ta', '¿Qué es la alpaca?')),
  'Libro de historia · 2–3', 'an analyst finds the published text, with its pages'
);
select is(
  (select count(*)::int from public.search_tenant_knowledge(:'ta', 'unicornio')), 0,
  'the draft''s text is never found'
);
select is(
  (select count(*)::int from public.search_tenant_knowledge(:'ta', 'de la el y')), 0,
  'a question of only stop words finds nothing'
);
set local request.jwt.claims to :'b1c';
select throws_ok(
  format('select * from public.search_tenant_knowledge(%L, %L)', :'ta', 'alpaca'),
  '42501', null, 'another municipality cannot search it'
);
select is(
  (select count(*)::int from public.search_tenant_knowledge(:'tb', 'alpaca')), 0,
  'and its own search never returns it'
);
reset role;

-- Version 2 published: version 1 stops at once, even before version 2 is indexed.
set local role authenticated;
set local request.jwt.claims to :'a1c';
select is(
  (select revision_no from public.publish_content(:'ta', (select content_id from k),
     (select edit_count from public.content_revisions where id = (select draft_revision_id from public.content_items where id = (select content_id from k)))
  )), 2, 'version 2 is published'
);
select is(
  (select count(*)::int from public.search_tenant_knowledge(:'ta', 'alpaca')), 0,
  'the replaced version is never found again'
);
reset role;
set local role rikuy_worker;
create temp table i2 as select * from worker_api.claim_jobs('runner-i', 5, array['knowledge.index']);
reset role;
select pg_temp.index_claimed('i2');
set local role authenticated;
set local request.jwt.claims to :'a1c';
select is(
  (select source_version from public.search_tenant_knowledge(:'ta', 'unicornio')), 2,
  'once indexed, version 2 is found, with its version for the citation'
);

-- Back to version 1: instant, with its own chunks (no new indexing).
select lives_ok(
  format('select * from public.restore_content_revision(%L, %L, %L)', :'ta', (select content_id from k),
    (select id from public.content_revisions where content_id = (select content_id from k) and revision_no = 1)),
  'the owner goes back to version 1'
);
select is(
  (select count(*)::int from public.search_tenant_knowledge(:'ta', 'alpaca')), 1,
  'version 1 is found again at once'
);
select is(
  (select count(*)::int from public.search_tenant_knowledge(:'ta', 'unicornio')), 0,
  'and version 2 is not'
);

-- Retired: never in a result again, in the same transaction.
set local request.jwt.claims to :'a3c';
select throws_ok(
  format('select public.retire_content(%L, %L)', :'ta', (select content_id from k)),
  '42501', null, 'an editor cannot retire'
);
set local request.jwt.claims to :'a1c';
select lives_ok(format('select public.retire_content(%L, %L)', :'ta', (select content_id from k)), 'the owner retires it');
select is(
  (select count(*)::int from public.search_tenant_knowledge(:'ta', 'alpaca')), 0,
  'a retired document never appears again'
);
select throws_ok(
  format('select public.retire_content(%L, %L)', :'ta',
    (select content_id from public.create_content_item(:'ta', 'destination', 'mirador', 'Mirador'))),
  '23514', null, 'destinations are not retired'
);
reset role;
select is(
  (select count(*)::int from public.audit_events where action = 'content.retired' and tenant_id = :'ta'), 1,
  'the retirement is audited'
);

-- ── The assistant's search: online municipalities only ─────────────────────
set local role authenticated;
set local request.jwt.claims to :'a1c';
select lives_ok(
  format('select * from public.restore_content_revision(%L, %L, %L)', :'ta', (select content_id from k),
    (select id from public.content_revisions where content_id = (select content_id from k) and revision_no = 2)),
  'version 2 published again'
);
reset role;
set local role rikuy_ai;
select is(
  (select count(*)::int from ai_api.search_knowledge(:'ta', 'unicornio')), 1,
  'the assistant finds what a member finds'
);
reset role;
update public.tenants set status = 'suspended' where id = :'ta';
set local role rikuy_ai;
select is(
  (select count(*)::int from ai_api.search_knowledge(:'ta', 'unicornio')), 0,
  'a suspended municipality gives the assistant nothing'
);
reset role;
update public.tenants set status = 'active' where id = :'ta';

-- A tour never offers knowledge as a destination of «ir a otro recorrido».
set local role authenticated;
set local request.jwt.claims to :'a1c';
create temp table t as select * from public.create_tour(:'ta', (select id from public.content_items where tenant_id = :'ta' and slug = 'mirador'));
select is(
  (select count(*)::int from public.tour_hotspot_targets(:'ta', (select tour_id from t)) where kind = 'knowledge'), 0,
  'knowledge is never a tour''s target'
);
reset role;

-- ── Index status ────────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to :'a4c';
select is(
  (select chunks from public.knowledge_index_status(:'ta') where source_id = (select content_id from k)), 1,
  'members see that the published version is read'
);
select is(
  (select count(*)::int from public.knowledge_index_status(:'ta') where kind = 'destination'), 0,
  'unpublished content is not listed'
);
reset role;

select * from finish();
rollback;
