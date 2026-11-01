-- P5 · Paso 1 (ADR-036): the AI gateway's reservations, its daily quota per municipality,
-- the platform's cap, the visitor's hourly limit and who can reach any of it.
begin;
set local client_min_messages to warning;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

\set op1 '00000000-0000-4000-8000-0000000000f1'
\set a1  '00000000-0000-4000-8000-0000000000a1'
\set b1  '00000000-0000-4000-8000-0000000000b1'
\set ta  'aaaaaaaa-0000-4000-8000-000000000001'
\set tb  'bbbbbbbb-0000-4000-8000-000000000001'
\set tp  'cccccccc-0000-4000-8000-000000000001'
\set ts  'dddddddd-0000-4000-8000-000000000001'
\set op_aal2 '{"sub":"00000000-0000-4000-8000-0000000000f1","role":"authenticated","aal":"aal2"}'
\set op_aal1 '{"sub":"00000000-0000-4000-8000-0000000000f1","role":"authenticated","aal":"aal1"}'
\set a1c '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated"}'
\set b1c '{"sub":"00000000-0000-4000-8000-0000000000b1","role":"authenticated"}'
\set ok_call '[{"provider":"groq","model":"openai/gpt-oss-120b","status":"ok","inputTokens":120,"outputTokens":30,"latencyMs":700,"httpStatus":200}]'
\set two_failures '[{"provider":"groq","model":"openai/gpt-oss-120b","status":"unavailable","latencyMs":300,"httpStatus":503},{"provider":"groq","model":"openai/gpt-oss-120b","status":"timeout","latencyMs":20000}]'

insert into auth.users (id, email) values
  (:'op1', 'operador@example.test'), (:'a1', 'owner.a@example.test'), (:'b1', 'owner.b@example.test');
insert into public.platform_operators (user_id, status) values (:'op1', 'active');
insert into public.tenants (id, slug, display_name, status, default_locale, timezone) values
  (:'ta', 'tenant-a', 'Tenant A', 'provisioning', 'es', 'America/La_Paz'),
  (:'tb', 'tenant-b', 'Tenant B', 'provisioning', 'es', 'America/La_Paz'),
  (:'tp', 'tenant-p', 'Tenant P', 'provisioning', 'es', 'America/La_Paz'),
  (:'ts', 'tenant-s', 'Tenant S', 'provisioning', 'es', 'America/La_Paz');
insert into public.memberships (tenant_id, user_id, role, status, accepted_at) values
  (:'ta', :'a1', 'owner', 'active', now()), (:'tb', :'b1', 'owner', 'active', now()),
  (:'tp', :'a1', 'owner', 'active', now()), (:'ts', :'a1', 'owner', 'active', now());
update public.tenants set status = 'active' where id in (:'ta', :'tb', :'ts');
update public.tenants set status = 'suspended' where id = :'ts';
set constraints all immediate;
grant usage on schema extensions to rikuy_ai;
do $$ begin execute format('grant temporary on database %I to rikuy_ai', current_database()); end $$;

select plan(50);

-- ── Who can reach the gateway ───────────────────────────────────────────────
set local role anon;
select throws_ok(format('select * from ai_api.begin_request(%L, ''assistant'', 100)', :'ta'), '42501', null,
  'a visitor cannot reserve AI through the Data API');
set local role authenticated;
set local request.jwt.claims to :'a1c';
select throws_ok(format('select * from ai_api.begin_request(%L, ''assistant'', 100)', :'ta'), '42501', null,
  'nor a member of the municipality');
set local role service_role;
select throws_ok(format('select * from ai_api.begin_request(%L, ''assistant'', 100)', :'ta'), '42501', null,
  'nor the secret key');
set local role rikuy_ai;
select throws_ok('select count(*) from public.ai_requests', '42501', null,
  'and the AI role reads no table directly');
reset role;

-- ── Reserve, settle, settle again ───────────────────────────────────────────
set local role rikuy_ai;
select request_id as r1, outcome as r1_outcome
  from ai_api.begin_request(:'ta', 'assistant', 1000, '203.0.113.7') \gset
reset role;
select is(:'r1_outcome'::text, 'reserved', 'a request within the quota is reserved');
select is((select reserved from public.usage_buckets where tenant_id = :'ta' and resource = 'ai_tokens'),
  1000::bigint, 'its tokens are set aside in the municipality''s quota');
select is((select reserved from public.ai_platform_days where day = private.ai_platform_day()),
  1000::bigint, 'and in the platform''s day');
select ok((select visitor_hash ~ '^[0-9a-f]{64}$' and visitor_hash <> '203.0.113.7'
           from public.ai_requests where id = :'r1'), 'the visitor is kept only as a hash');

set local role rikuy_ai;
select is(ai_api.finish_request(:'r1', 'answered', :'ok_call'), 'settled', 'an answer settles its request');
reset role;
select is((select array[reserved, consumed] from public.usage_buckets where tenant_id = :'ta' and resource = 'ai_tokens'),
  array[0, 150]::bigint[], 'the reservation becomes what the call really used');
select is((select array[reserved, consumed] from public.ai_platform_days where day = private.ai_platform_day()),
  array[0, 150]::bigint[], 'also in the platform''s day');
select is((select array[status, outcome] from public.ai_requests where id = :'r1'),
  array['completed', 'answered'], 'the request is answered');
select is((select count(*) from public.ai_executions where request_id = :'r1'), 1::bigint, 'with its call recorded');

set local role rikuy_ai;
select is(ai_api.finish_request(:'r1', 'answered', :'ok_call'), 'already_finished', 'settling twice changes nothing');
reset role;
select is((select consumed from public.usage_buckets where tenant_id = :'ta' and resource = 'ai_tokens'),
  150::bigint, 'nor counts the tokens again');

set local role rikuy_ai;
select request_id as r2 from ai_api.begin_request(:'ta', 'assistant', 800) \gset
select throws_ok(format('select ai_api.finish_request(%L, ''answered'', ''[]'')', :'r2'), '22023', null,
  'an answer needs the call that produced it');
select is(ai_api.finish_request(:'r2', 'provider_unavailable', :'two_failures'), 'settled',
  'a provider that fails twice settles as failed');
reset role;
select is((select array[status, outcome] from public.ai_requests where id = :'r2'),
  array['failed', 'provider_unavailable'], 'with its outcome');
select is((select count(*) from public.ai_executions where request_id = :'r2'), 2::bigint, 'and both attempts');
select is((select reserved from public.usage_buckets where tenant_id = :'ta' and resource = 'ai_tokens'),
  0::bigint, 'and nothing left reserved');

-- ── The municipality's quota ────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to :'op_aal2';
select lives_ok(format('select public.platform_set_quota(%L, ''ai_tokens'', 500)', :'ta'),
  'an operator lowers a municipality''s AI quota');
reset role;
select is((select diff ->> 'resource' from public.audit_events where action = 'platform.quota_changed' and tenant_id = :'ta'),
  'ai_tokens', 'and it is audited');
set local role rikuy_ai;
select request_id as r3, outcome as r3_outcome from ai_api.begin_request(:'ta', 'assistant', 1000) \gset
reset role;
select is(:'r3_outcome'::text, 'tenant_quota', 'a request that does not fit is refused');
select is((select array[status, reserved_tokens::text] from public.ai_requests where id = :'r3'),
  array['rejected', '0'], 'recorded as refused, reserving nothing');
select is((select reserved from public.usage_buckets where tenant_id = :'ta' and resource = 'ai_tokens'),
  0::bigint, 'and the quota is untouched');

-- ── The platform's cap ──────────────────────────────────────────────────────
update public.ai_platform_days set limit_tokens = consumed + reserved + 50 where day = private.ai_platform_day();
set local role rikuy_ai;
select outcome as r4_outcome from ai_api.begin_request(:'tb', 'assistant', 100) \gset
reset role;
select is(:'r4_outcome'::text, 'platform_quota', 'past the platform''s daily cap, any municipality is refused');
select is((select coalesce(sum(reserved), 0) from public.usage_buckets where tenant_id = :'tb' and resource = 'ai_tokens'),
  0::numeric, 'and its own reservation is given back');
update public.ai_platform_days set limit_tokens = 180000 where day = private.ai_platform_day();

-- ── The visitor's hourly limit ──────────────────────────────────────────────
set local role rikuy_ai;
select count(*) filter (where r.outcome = 'reserved') as ten
from generate_series(1, 10) s, lateral ai_api.begin_request(:'tb', 'assistant', 100 + 0 * s, 'visitor-1') r \gset
select outcome as eleventh from ai_api.begin_request(:'tb', 'assistant', 100, 'visitor-1') \gset
select outcome as other_visitor from ai_api.begin_request(:'tb', 'assistant', 100, 'visitor-2') \gset
select outcome as other_tenant from ai_api.begin_request(:'ta', 'assistant', 100, 'visitor-1') \gset
reset role;
select is(:'ten'::int, 10, 'a visitor gets ten questions in an hour');
select is(:'eleventh'::text, 'visitor_limit', 'not an eleventh');
select is(:'other_visitor'::text, 'reserved', 'another visitor still can');
select is(:'other_tenant'::text, 'reserved', 'and the same visitor in another municipality too');

-- ── The municipality's state ────────────────────────────────────────────────
set local role rikuy_ai;
select outcome as suspended from ai_api.begin_request(:'ts', 'probe', 10) \gset
select outcome as preparing_assistant from ai_api.begin_request(:'tp', 'assistant', 10) \gset
select outcome as preparing_probe from ai_api.begin_request(:'tp', 'probe', 10) \gset
select throws_ok(format('select * from ai_api.begin_request(%L, ''chat'', 10)', :'ta'), '22023', null,
  'an unknown profile is refused');
select throws_ok(format('select * from ai_api.begin_request(%L, ''probe'', 0)', :'ta'), '22023', null,
  'and so is an empty reservation');
select throws_ok('select * from ai_api.begin_request(''eeeeeeee-0000-4000-8000-000000000001'', ''probe'', 10)',
  'PT404', null, 'and an unknown municipality');
reset role;
select is(:'suspended'::text, 'tenant_unavailable', 'a suspended municipality gets no AI');
select is(:'preparing_assistant'::text, 'tenant_unavailable', 'a municipality not yet online has no visitor assistant');
select is(:'preparing_probe'::text, 'reserved', 'but its operator can still test the AI');

-- ── Orphan reservations ─────────────────────────────────────────────────────
set local role rikuy_ai;
select request_id as orphan from ai_api.begin_request(:'tb', 'probe', 70) \gset
reset role;
update public.ai_requests set created_at = now() - interval '11 minutes' where id = :'orphan';
select ok(private.expire_ai_requests() >= 1, 'a reservation left open for 10 minutes expires');
select is((select array[status, outcome] from public.ai_requests where id = :'orphan'),
  array['expired', 'abandoned'], 'as abandoned');
select is((select schedule from cron.job where jobname = 'rikuy-expire-ai-requests'), '*/15 * * * *',
  'checked every 15 minutes');
select throws_ok(
  format('insert into public.ai_requests (tenant_id, profile, status, outcome) values (%L, ''probe'', ''completed'', ''pending'')', :'ta'),
  '23514', null, 'a request cannot be in an inconsistent state');

-- ── Reading ─────────────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to :'a1c';
select is((select array_agg(resource::text order by resource) from public.tenant_usage(:'ta')),
  array['storage_bytes', 'media_compute_seconds'], 'the existing usage reading keeps storage and compute only');
select is((select array[limit_amount, answered_today] from public.tenant_ai_usage(:'ta')),
  array[500, 1]::bigint[], 'a member reads the AI usage of today');
select is((select period_end - period_start from public.tenant_ai_usage(:'ta')), interval '1 day',
  'which renews every day');
select is((select (period_start at time zone 'America/La_Paz')::time from public.tenant_ai_usage(:'ta')), '00:00'::time,
  'at midnight in the municipality');
set local request.jwt.claims to :'b1c';
select throws_ok(format('select * from public.tenant_ai_usage(%L)', :'ta'), '42501', null,
  'another municipality''s owner cannot');
set local request.jwt.claims to :'op_aal2';
select ok((select count(*) >= 4 from public.platform_ai_usage()), 'the operator reads every municipality''s AI usage');
select is((select (public.platform_operations() #>> '{ai,limit}')::bigint), 180000::bigint,
  'and the platform''s cap in the operations snapshot');
select ok(not exists (
  select 1 from jsonb_array_elements(public.platform_operations() -> 'quotas') q where q ->> 'resource' = 'ai_tokens'
), 'whose storage and compute quotas never list AI');
set local request.jwt.claims to :'op_aal1';
select throws_ok('select * from public.platform_ai_usage()', '42501', null, 'not without the second factor');
reset role;

select * from finish();
rollback;
