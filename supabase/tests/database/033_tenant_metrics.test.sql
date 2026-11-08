-- P6 · Paso 2 (ADR-044): metrics per municipality. Only rikuy_worker writes telemetry, only
-- operators with a second factor read it; latency is a histogram per hour; the AI cost uses
-- a versioned price; the integrity check finds what a published revision is missing.
begin;
set local client_min_messages to warning;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

\set op1 '00000000-0000-4000-8000-0000000000f1'
\set a1  '00000000-0000-4000-8000-0000000000a1'
\set ta  'aaaaaaaa-0000-4000-8000-000000000001'
\set tb  'bbbbbbbb-0000-4000-8000-000000000001'
\set tp  'cccccccc-0000-4000-8000-000000000001'
\set asset 'aaaa0a00-0000-4000-8000-000000000001'
\set ver   'aaaa0b00-0000-4000-8000-000000000001'
\set item  'aaaa0c00-0000-4000-8000-000000000001'
\set rev   'aaaa0d00-0000-4000-8000-000000000001'
\set op_aal2 '{"sub":"00000000-0000-4000-8000-0000000000f1","role":"authenticated","aal":"aal2"}'
\set op_aal1 '{"sub":"00000000-0000-4000-8000-0000000000f1","role":"authenticated","aal":"aal1"}'
\set a1c '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}'
\set ok_call '[{"provider":"groq","model":"openai/gpt-oss-120b","status":"ok","inputTokens":1000000,"outputTokens":1000000,"latencyMs":700,"httpStatus":200}]'
\set sim_call '[{"provider":"simulated","model":"simulated-1","status":"ok","inputTokens":100,"outputTokens":10,"latencyMs":5,"httpStatus":200}]'

insert into auth.users (id, email) values (:'op1', 'operador@example.test'), (:'a1', 'owner.a@example.test');
insert into public.platform_operators (user_id) values (:'op1');
insert into public.tenants (id, slug, display_name, status, default_locale, timezone) values
  (:'ta', 'tenant-a', 'Tenant A', 'provisioning', 'es', 'America/La_Paz'),
  (:'tb', 'tenant-b', 'Tenant B', 'provisioning', 'es', 'America/La_Paz'),
  (:'tp', 'tenant-p', 'Tenant P', 'provisioning', 'es', 'America/La_Paz');
insert into public.memberships (tenant_id, user_id, role, status, accepted_at) values
  (:'ta', :'a1', 'owner', 'active', now()), (:'tb', :'a1', 'owner', 'active', now()),
  (:'tp', :'a1', 'owner', 'active', now());
insert into public.tenant_domains (tenant_id, hostname, kind, status, verified_at) values
  (:'ta', 'tenant-a.localhost', 'platform', 'active', now()),
  (:'tb', 'tenant-b.localhost', 'platform', 'active', now()),
  (:'tp', 'tenant-p.localhost', 'platform', 'active', now());
update public.tenants t set canonical_domain_id = d.id
  from public.tenant_domains d where d.tenant_id = t.id;
update public.tenants set status = 'active' where id in (:'ta', :'tb');
set constraints all immediate;
-- pgTAP lives in extensions; the worker role uses it inside this transaction only.
grant usage on schema extensions to rikuy_worker, rikuy_ai;
do $$ begin execute format('grant temporary on database %I to rikuy_worker, rikuy_ai', current_database()); end $$;

select plan(52);

-- ── Who can do what ───────────────────────────────────────────────────────
select ok(not has_function_privilege('anon', 'worker_api.record_request_error(uuid, text, text, uuid, text, text, text, text, text)', 'EXECUTE'),
  'visitors cannot record errors');
select ok(not has_function_privilege('authenticated', 'worker_api.record_route_latency(uuid, text, integer, integer)', 'EXECUTE'),
  'a signed-in person cannot record latencies');
select ok(not has_function_privilege('service_role', 'worker_api.record_request_error(uuid, text, text, uuid, text, text, text, text, text)', 'EXECUTE'),
  'not even the secret key writes telemetry');
select ok(has_function_privilege('rikuy_worker', 'worker_api.record_route_latency(uuid, text, integer, integer)', 'EXECUTE'),
  'the worker role records latencies');
select ok(not has_table_privilege('authenticated', 'public.request_errors', 'SELECT')
          and not has_table_privilege('service_role', 'public.route_latency_hourly', 'SELECT')
          and not has_table_privilege('authenticated', 'public.ai_prices', 'SELECT')
          and not has_table_privilege('rikuy_worker', 'public.publication_checks', 'SELECT'),
  'nobody reads the metric tables directly');

-- ── Route latency ─────────────────────────────────────────────────────────
set local role rikuy_worker;
select ok(worker_api.record_route_latency(:'ta', 'assistant', 40, 200), 'a fast request is recorded');
select ok(worker_api.record_route_latency(:'ta', 'assistant', 1500, 200), 'a slow one too');
select ok(worker_api.record_route_latency(:'ta', 'assistant', 9000, 503), 'and a failed, very slow one');
select ok(not worker_api.record_route_latency(:'ta', 'admin_page', 10, 200), 'an unknown route is ignored');
select ok(not worker_api.record_route_latency(gen_random_uuid(), 'assistant', 10, 200), 'an unknown municipality is ignored');
select ok(worker_api.record_route_latency(:'tb', 'map_places', -5, 200), 'a negative time counts as 0');
reset role;
select results_eq(
  format('select requests, errors, total_ms::integer, buckets from public.route_latency_hourly where tenant_id = %L', :'ta'),
  $$values (3, 1, 10540, array[1,0,0,0,0,1,0,0,1])$$,
  'one row per municipality, hour and route, with its histogram');
select is((select buckets[1] from public.route_latency_hourly where tenant_id = :'tb'), 1, '0 ms falls in the first bucket');
select is(private.histogram_percentile(array[1,0,0,0,0,1,0,0,1], 0.5), 1600, 'p50 is the upper bound of its bucket');
select is(private.histogram_percentile(array[1,0,0,0,0,1,0,0,1], 0.95), 6401, 'p95 over 6.4 s is reported as 6401');
select is(private.histogram_percentile(array[0,0,0,0,0,0,0,0,0], 0.95), null, 'no requests, no percentile');
select is(private.histogram_percentile(array[95,5,0,0,0,0,0,0,0], 0.95), 50, 'p95 with 95 of 100 fast requests');

-- ── Errors ────────────────────────────────────────────────────────────────
set local role rikuy_worker;
select ok(worker_api.record_request_error(gen_random_uuid(), 'd1g3st', 'portal', :'ta', null,
  '/portal/[host]/destinos/[slug]', 'get', 'TypeError', 'fallo en https://x.test/a?token=secreto'),
  'a portal error is recorded with its municipality');
select ok(worker_api.record_request_error(gen_random_uuid(), null, 'admin', null, 'tenant-b',
  '/admin/o/[slug]', 'POST', 'Error', 'otro'), 'a panel error finds its municipality by slug');
select ok(worker_api.record_request_error(gen_random_uuid(), 'x', 'admin', null, 'no-existe',
  'no es una ruta', 'BORRAR!', '!!', null), 'an unknown slug and bad fields are recorded, sanitized');
select throws_ok($$select worker_api.record_request_error(gen_random_uuid(), null, 'otra', null, null, '/', 'GET', 'Error', '')$$,
  '23514', null, 'an unknown surface is refused');
reset role;
select is((select message from public.request_errors where digest = 'd1g3st'), 'fallo en https://x.test/a?…',
  'the message is cut at the query string');
select is((select method from public.request_errors where digest = 'd1g3st'), 'GET', 'the method is upper case');
select is((select tenant_id from public.request_errors where route = '/admin/o/[slug]'), :'tb'::uuid, 'slug → municipality');
select results_eq($$select tenant_id, route, method, kind from public.request_errors where digest = 'x'$$,
  $$values (null::uuid, '/', 'GET', 'Error')$$, 'unknown slug → platform error; route, method and kind sanitized');
insert into public.request_errors (tenant_id, request_id, surface, route, method, kind)
  select :'tp', gen_random_uuid(), 'portal', '/', 'GET', 'Error' from generate_series(1, 1000);
set local role rikuy_worker;
select ok(not worker_api.record_request_error(gen_random_uuid(), null, 'portal', :'tp', null, '/', 'GET', 'Error', ''),
  'at most 1,000 errors per municipality and hour are kept');
reset role;

-- ── Daily probe ───────────────────────────────────────────────────────────
select is(private.enqueue_portal_probes(), (select count(*)::integer from public.tenants where status = 'active'),
  'one probe per municipality online');
select is(private.enqueue_portal_probes(), 0, 'and only one per day');
select is((select count(*)::integer from public.background_jobs where kind = 'metrics.probe_portal' and tenant_id = :'tp'),
  0, 'a municipality in preparation is not probed');
select id as probe_job from public.background_jobs where kind = 'metrics.probe_portal' and tenant_id = :'ta' \gset
set local role rikuy_worker;
select throws_ok(
  format('select * from worker_api.portal_probe_target(%L, 1)',
         :'probe_job'),
  'PT409', null, 'the target is read only under the job''s lease');
reset role;
update public.background_jobs set status = 'running', fencing_token = 7, lease_owner = 'runner-test', lease_until = now() + interval '1 minute'
  where kind = 'metrics.probe_portal' and tenant_id = :'ta';
insert into storage.objects (bucket_id, name) values ('media-public', :'ta' || '/x/1/w480.webp');
set local role rikuy_worker;
select results_eq(
  format('select host, media_path from worker_api.portal_probe_target(%L, 7)',
         :'probe_job'),
  format('values (%L, %L)', 'tenant-a.localhost', :'ta' || '/x/1/w480.webp'),
  'the canonical host and the municipality''s latest public image');
select is(worker_api.record_portal_probe(
  :'probe_job', 7,
  '[{"target":"home","path":"/","status":200,"ttfbMs":80,"totalMs":120,"bytes":9000,"cache":"HIT","error":null},
    {"target":"map","path":"/mapa","status":null,"ttfbMs":null,"totalMs":null,"bytes":null,"cache":null,"error":"timeout"}]'),
  2, 'the results are stored');
select throws_ok(format('select worker_api.record_portal_probe(%L, 7, %L)',
  :'probe_job',
  '[{"target":"home","path":"/","status":null,"error":null}]'),
  '23514', null, 'a probe without a status needs its error');
reset role;

-- ── Estimated AI cost ─────────────────────────────────────────────────────
select results_eq($$select price_version, estimated_cost_usd::numeric(12,4)
                    from private.ai_execution_cost('groq', 'openai/gpt-oss-120b', now(), 1000000, 1000000, 0)$$,
  $$values ('groq-2026-10', 0.7500::numeric(12,4))$$, '1M in + 1M out of GPT-OSS 120B: 0.15 + 0.60 USD');
select results_eq($$select estimated_cost_usd::numeric(12,4)
                    from private.ai_execution_cost('groq', 'whisper-large-v3-turbo', now(), 0, 0, 3600)$$,
  $$values (0.0400::numeric(12,4))$$, 'one hour of dictation: 0.04 USD');
select is((select count(*)::integer from private.ai_execution_cost('groq', 'openai/gpt-oss-120b', '2026-09-01', 1, 1, 0)),
  0, 'no price before it was in force');
set local role rikuy_ai;
select request_id as r2 from ai_api.begin_request(:'ta', 'assistant', 1000, '203.0.113.8') \gset
select ai_api.finish_request(:'r2', 'answered', :'sim_call') as f2 \gset
select request_id as r1 from ai_api.begin_request(:'ta', 'assistant', 1000, '203.0.113.7') \gset
select ai_api.finish_request(:'r1', 'answered', :'ok_call') as f1 \gset
reset role;
select results_eq(format('select price_version, estimated_cost_usd::numeric(12,4) from public.ai_executions where request_id = %L', :'r1'),
  $$values ('groq-2026-10', 0.7500::numeric(12,4))$$, 'each new call gets its estimated cost and price version');
select results_eq(format('select price_version, estimated_cost_usd from public.ai_executions where request_id = %L', :'r2'),
  $$values (null::text, null::numeric)$$, 'a call without a price stays unpriced');

-- ── Integrity of what is published ────────────────────────────────────────
insert into public.assets (id, tenant_id, purpose) values (:'asset', :'ta', 'content');
insert into public.asset_versions (id, tenant_id, asset_id, version, status, declared_mime, declared_bytes,
                                   mime, bytes, width, height, sha256, ready_at, published_at)
values (:'ver', :'ta', :'asset', 1, 'ready', 'image/png', 1000, 'image/png', 1000, 800, 600, repeat('a', 64), now(), now());
set local role authenticated;
set local request.jwt.claims to :'a1c';
select content_id as item, revision_id as rev, edit_count as ec
  from public.create_content_item(:'ta', 'destination', 'mirador', 'Mirador') \gset
reset role;
insert into public.media_references (tenant_id, revision_id, asset_version_id, purpose, position, alt_text)
  values (:'ta', :'rev', :'ver', 'cover', 0, 'Vista del mirador');
update public.content_revisions set state = 'sealed', sealed_at = now() - interval '1 hour' where id = :'rev';
update public.content_items set published_revision_id = :'rev', published_at = now(), draft_revision_id = null where id = :'item';

select ok(private.check_publication(:'ta', 'daily') is not null, 'a check runs');
select results_eq(
  format('select p ->> ''kind'', p ->> ''title'' from public.publication_checks c, jsonb_array_elements(c.problems) p
          where c.tenant_id = %L order by 1', :'ta'),
  $$values ('not_indexed', 'Mirador'), ('photo_missing', 'Mirador')$$,
  'a published photo without its public copy and a revision the assistant has not read');
insert into storage.objects (bucket_id, name) values ('media-public', :'ta' || '/' || :'asset' || '/1/w960.webp');
insert into public.knowledge_indexed_revisions (tenant_id, content_revision_id, chunker_version, chunks, characters)
  values (:'ta', :'rev', 1, 1, 10);
select private.check_publication(:'ta', 'daily') as c2 \gset
select is((select problem_count from public.publication_checks where tenant_id = :'ta' order by checked_at desc, id limit 1),
  0, 'with the copy and the index, nothing is missing');
select is((select checked ->> 'photos' from public.publication_checks where tenant_id = :'ta' order by checked_at desc limit 1),
  '1', 'it says what it checked');
select is(private.check_publication_daily(), (select count(*)::integer from public.tenants where status = 'active'),
  'the daily run checks the municipalities online');
select throws_ok(format('select private.check_publication(%L, ''manual'', null)', :'tb'), '23514', null,
  'a manual check needs its operator');

-- ── Readings: operators with a second factor only ─────────────────────────
set local role authenticated;
set local request.jwt.claims to :'a1c';
select throws_ok('select public.platform_metrics_overview()', '42501', null, 'an owner is not an operator');
select throws_ok(format('select public.platform_check_publication(%L)', :'ta'), '42501', null, 'an owner cannot run a check');
set local request.jwt.claims to :'op_aal1';
select throws_ok(format('select public.platform_tenant_metrics(%L)', :'ta'), '42501', null,
  'an operator without the second factor reads nothing');
set local request.jwt.claims to :'op_aal2';
select is((select (e ->> 'errors24h')::integer from jsonb_array_elements(public.platform_metrics_overview() -> 'tenants') e
           where e ->> 'slug' = 'tenant-a'), 1, 'the overview counts each municipality''s errors');
select is((public.platform_tenant_metrics(:'ta') -> 'routes' -> 0 ->> 'p95Ms')::integer, 6401,
  'the detail has the routes with their percentiles');
select is((select count(*)::integer from public.platform_tenant_errors(:'ta', 'd1g3st')), 1,
  'an error is found by its reference code');
select ok(public.platform_check_publication(:'tb') is not null, '«Revisar ahora» runs a manual check');
select throws_ok(format('select public.platform_tenant_metrics(%L)', gen_random_uuid()), 'PT404', null,
  'an unknown municipality');

select * from finish();
rollback;
