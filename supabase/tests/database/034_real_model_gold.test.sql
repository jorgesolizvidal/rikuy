-- P6 · Paso 3 (ADR-045): evaluation runs with the real model. Only an operator with a second
-- factor starts, records, rates and reads them, against online commercial demos; each result
-- gets its estimated cost; the trap data («prueba-eval-…») is retired only in a demo.
begin;
set local client_min_messages to warning;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

\set op1 '00000000-0000-4000-8000-0000000000f1'
\set a1  '00000000-0000-4000-8000-0000000000a1'
\set ta  'aaaaaaaa-0000-4000-8000-000000000001'
\set tb  'bbbbbbbb-0000-4000-8000-000000000001'
\set tc  'cccccccc-0000-4000-8000-000000000001'
\set tp  'dddddddd-0000-4000-8000-000000000001'
\set op_aal2 '{"sub":"00000000-0000-4000-8000-0000000000f1","role":"authenticated","aal":"aal2"}'
\set op_aal1 '{"sub":"00000000-0000-4000-8000-0000000000f1","role":"authenticated","aal":"aal1"}'
\set a1c '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}'
\set result '{"split":"heldout","category":"destino","kind":"chat","pass":true,"problems":[],"answer":"Abre de 9:00 a 17:00.","cited":["destination:museo-comunitario"],"retrieved":["destination:museo-comunitario"],"inputTokens":1000000,"outputTokens":1000000,"latencyMs":900,"metrics":{"factsExpected":1,"factsFound":1,"leak":false}}'

insert into auth.users (id, email) values (:'op1', 'operador@example.test'), (:'a1', 'owner.a@example.test');
insert into public.platform_operators (user_id) values (:'op1');
insert into public.tenants (id, slug, display_name, status, default_locale, timezone) values
  (:'ta', 'demo-a', 'Demo A', 'provisioning', 'es', 'America/La_Paz'),
  (:'tb', 'demo-b', 'Demo B', 'provisioning', 'es', 'America/La_Paz'),
  (:'tc', 'real-c', 'Real C', 'provisioning', 'es', 'America/La_Paz'),
  (:'tp', 'demo-p', 'Demo P', 'provisioning', 'es', 'America/La_Paz');
insert into public.memberships (tenant_id, user_id, role, status, accepted_at)
select t, :'a1'::uuid, 'owner', 'active', now() from unnest(array[:'ta', :'tb', :'tc', :'tp']::uuid[]) t;
insert into public.tenant_domains (tenant_id, hostname, kind, status, verified_at)
select t.id, t.slug || '.localhost', 'platform', 'active', now() from public.tenants t
where t.id in (:'ta', :'tb', :'tc', :'tp');
update public.tenants t set canonical_domain_id = d.id
  from public.tenant_domains d where d.tenant_id = t.id and t.id in (:'ta', :'tb', :'tc', :'tp');
update public.tenants set status = 'active' where id in (:'ta', :'tb', :'tc');
update public.tenants set is_demo = true where id in (:'ta', :'tb', :'tp');
set constraints all immediate;

select plan(36);

-- ── Nobody touches the tables ─────────────────────────────────────────────
select ok(not has_table_privilege('authenticated', 'public.eval_runs', 'SELECT')
          and not has_table_privilege('authenticated', 'public.eval_results', 'INSERT')
          and not has_table_privilege('service_role', 'public.eval_results', 'SELECT')
          and not has_table_privilege('anon', 'public.eval_runs', 'SELECT'),
  'nobody reads or writes the evaluation tables directly');
select ok(not has_function_privilege('anon', 'public.platform_eval_start(text, text, uuid, uuid, text, text)', 'EXECUTE'),
  'visitors cannot start a run');

-- ── Starting a run ────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to :'op_aal1';
select throws_ok(format($$select public.platform_eval_start('assistant', 'rikuy-gold/v2#1', %L, %L, 'groq', 'openai/gpt-oss-120b')$$, :'ta', :'tb'),
  '42501', null, 'an operator without the second factor cannot start a run');
set local request.jwt.claims to :'a1c';
select throws_ok(format($$select public.platform_eval_start('assistant', 'rikuy-gold/v2#1', %L, null, 'groq', 'openai/gpt-oss-120b')$$, :'ta'),
  '42501', null, 'an owner of the demos is not an operator');
set local request.jwt.claims to :'op_aal2';
select throws_ok(format($$select public.platform_eval_start('assistant', 'rikuy-gold/v2#1', %L, null, 'groq', 'm')$$, :'tc'),
  '23514', null, 'a real municipality is never evaluated');
select throws_ok(format($$select public.platform_eval_start('assistant', 'rikuy-gold/v2#1', %L, %L, 'groq', 'm')$$, :'ta', :'tp'),
  '23514', null, 'a demo that is not online is not either');
select throws_ok(format($$select public.platform_eval_start('assistant', 'rikuy-gold/v2#1', %L, %L, 'groq', 'm')$$, :'ta', :'ta'),
  '23514', null, 'demo A and demo B are two demos');
select throws_ok(format($$select public.platform_eval_start('quiz', 'rikuy-gold/v2#1', %L, null, 'groq', 'm')$$, :'ta'),
  '23514', null, 'only the assistant and the Copilot are evaluated');
select public.platform_eval_start('assistant', 'rikuy-gold/v2#abc', :'ta', :'tb', 'groq', 'openai/gpt-oss-120b') as run \gset
select public.platform_eval_start('copilot', 'rikuy-copilot-gold/v1#abc', :'ta', null, 'simulated', 'simulated-1') as sim \gset
reset role;
select ok(exists (select 1 from public.audit_events where action = 'eval.started' and entity_id = :'run'
                  and actor_id = :'op1' and scope = 'platform'),
  'starting a run is audited');

-- ── Recording results ─────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to :'op_aal2';
select lives_ok(format($$select public.platform_eval_record(%L, 'H04', 1::smallint, %L::jsonb)$$, :'run', :'result'),
  'the operator records a result');
select lives_ok(format($$select public.platform_eval_record(%L, 'C01', 1::smallint, %L::jsonb)$$, :'sim', :'result'),
  'and one of a run with the simulated model');
reset role;
select results_eq(format('select price_version, estimated_cost_usd::numeric(12,4), pass, metrics ->> ''factsFound'' from public.eval_results where run_id = %L', :'run'),
  $$values ('groq-2026-10'::text, 0.7500::numeric(12,4), true, '1'::text)$$,
  'each result gets its estimated cost at the price in force, with its metrics');
select results_eq(format('select price_version, estimated_cost_usd from public.eval_results where run_id = %L', :'sim'),
  $$values (null::text, null::numeric)$$, 'the simulated model has no price');

set local role authenticated;
set local request.jwt.claims to :'op_aal2';
select lives_ok(format($$select public.platform_eval_rate(%L, 'H04', 1::smallint, 4::smallint)$$, :'run'),
  'the operator rates an answer');
select throws_ok(format($$select public.platform_eval_rate(%L, 'H04', 1::smallint, 6::smallint)$$, :'run'),
  '23514', null, 'a rating goes from 1 to 5');
select throws_ok(format($$select public.platform_eval_rate(%L, 'H05', 1::smallint, 3::smallint)$$, :'run'),
  'PT404', null, 'an answer that is not there cannot be rated');
select lives_ok(format($$select public.platform_eval_record(%L, 'H04', 1::smallint, %L::jsonb)$$, :'run',
  jsonb_set(:'result'::jsonb, '{pass}', 'false')),
  'running a case again replaces its result');
reset role;
select results_eq(format('select count(*)::integer, bool_and(pass = false), bool_and(rating is null) from public.eval_results where run_id = %L', :'run'),
  $$values (1, true, true)$$, 'one result per case and repetition, and the old rating goes with it');

set local role authenticated;
set local request.jwt.claims to :'op_aal2';
select throws_ok(format($$select public.platform_eval_record(%L, 'not a case', 1::smallint, %L::jsonb)$$, :'run', :'result'),
  '23514', null, 'a case id has its shape');
select throws_ok(format($$select public.platform_eval_record(%L, 'H01', 4::smallint, %L::jsonb)$$, :'run', :'result'),
  '23514', null, 'held-out cases run 3 times at most');
select throws_ok(format($$select public.platform_eval_record(%L, 'H01', 1::smallint, %L::jsonb)$$, :'run',
  jsonb_set(:'result'::jsonb, '{split}', '"secret"')),
  '23514', null, 'a split is one of the four');
select throws_ok(format($$select public.platform_eval_record(%L, 'H01', 1::smallint, %L::jsonb)$$, :'run',
  jsonb_set(:'result'::jsonb, '{metrics}', '[1]')),
  '23514', null, 'metrics are an object');
select throws_ok(format($$select public.platform_eval_record(%L, 'H01', 1::smallint, '[]'::jsonb)$$, :'run'),
  '22023', null, 'a result is an object');

-- ── Reading ───────────────────────────────────────────────────────────────
select is((select (r -> 0 ->> 'results')::integer from (select public.platform_eval_runs('assistant') r) x), 1,
  'the runs of a suite say how far they got');
select is((select r -> 0 ->> 'caseId' from (select public.platform_eval_results(:'run') r) x), 'H04',
  'the results of a run');
select is(public.platform_eval_results(gen_random_uuid()), null, 'an unknown run reads nothing');
set local request.jwt.claims to :'op_aal1';
select throws_ok(format($$select public.platform_eval_results(%L)$$, :'run'),
  '42501', null, 'without the second factor nothing is read');
set local request.jwt.claims to :'a1c';
select throws_ok($$select public.platform_eval_runs('assistant')$$, '42501', null,
  'nor by the owner of the demos');

-- ── Finishing ─────────────────────────────────────────────────────────────
set local request.jwt.claims to :'op_aal2';
select lives_ok(format($$select public.platform_eval_finish(%L)$$, :'run'), 'the operator finishes a run');
select throws_ok(format($$select public.platform_eval_record(%L, 'H02', 1::smallint, %L::jsonb)$$, :'run', :'result'),
  'PT409', null, 'a finished run takes no more results');
select throws_ok(format($$select public.platform_eval_finish(%L)$$, :'run'),
  'PT404', null, 'and is finished once');

-- ── Taking back the trap data ─────────────────────────────────────────────
set local request.jwt.claims to :'a1c';
select content_id as trap, revision_id as trap_rev
  from public.create_content_item(:'tb', 'knowledge', 'prueba-eval-indicaciones', 'Indicaciones') \gset
select content_id as guide, revision_id as guide_rev
  from public.create_content_item(:'tb', 'knowledge', 'guia-para-visitantes', 'Guía') \gset
select content_id as place, revision_id as place_rev
  from public.create_content_item(:'tb', 'destination', 'prueba-eval-lugar', 'Lugar de prueba') \gset
reset role;
update public.content_revisions set state = 'sealed', sealed_at = now() where id in (:'trap_rev', :'guide_rev', :'place_rev');
update public.content_items i set published_revision_id = i.draft_revision_id, published_at = now(), draft_revision_id = null
  where i.id in (:'trap', :'guide', :'place');

set local role authenticated;
set local request.jwt.claims to :'a1c';
select throws_ok(format($$select public.platform_eval_retire_fixtures(%L)$$, :'tb'),
  '42501', null, 'an owner of the demo cannot retire the trap data from here');
set local request.jwt.claims to :'op_aal2';
select throws_ok(format($$select public.platform_eval_retire_fixtures(%L)$$, :'tc'),
  '23514', null, 'a real municipality has no trap data to retire');
select is(public.platform_eval_retire_fixtures(:'tb'), 2, 'the operator retires the trap data of a demo');
reset role;
select results_eq(format('select slug, published_revision_id is null from public.content_items where tenant_id = %L order by slug', :'tb'),
  $$values ('guia-para-visitantes'::text, false), ('prueba-eval-indicaciones'::text, true), ('prueba-eval-lugar'::text, true)$$,
  'only «prueba-eval-…» loses its published version; the sample content stays');
select results_eq(format($q$select r.state::text, r.title, r.revision_no from public.content_items i
  join public.content_revisions r on r.id = i.draft_revision_id where i.id = %L$q$, :'place'),
  $$values ('draft'::text, 'Lugar de prueba'::text, 2)$$,
  'a retired place keeps a draft copy of its last version, so the next preparation finds it');

select * from finish();
rollback;
