-- P5 · Paso 6 (ADR-041): dictation of the visitor's assistant. Seconds of audio per day
-- per municipality, the platform's daily seconds, 10 dictations per hour per visitor (apart
-- from their questions), settlement with the seconds billed, and who can reach any of it.
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
\set op_aal2 '{"sub":"00000000-0000-4000-8000-0000000000f1","role":"authenticated","aal":"aal2"}'
\set a1c '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}'
\set b1c '{"sub":"00000000-0000-4000-8000-0000000000b1","role":"authenticated","aal":"aal2"}'
\set ok_call '[{"provider":"groq","model":"whisper-large-v3-turbo","status":"ok","audioSeconds":12,"latencyMs":400,"httpStatus":200}]'
\set two_failures '[{"provider":"groq","model":"whisper-large-v3-turbo","status":"unavailable","latencyMs":300,"httpStatus":503},{"provider":"groq","model":"whisper-large-v3-turbo","status":"timeout","latencyMs":20000}]'

insert into auth.users (id, email) values
  (:'op1', 'operador@example.test'), (:'a1', 'owner.a@example.test'), (:'b1', 'owner.b@example.test');
insert into public.platform_operators (user_id, status) values (:'op1', 'active');
insert into public.tenants (id, slug, display_name, status, default_locale, timezone) values
  (:'ta', 'tenant-a', 'Tenant A', 'provisioning', 'es', 'America/La_Paz'),
  (:'tb', 'tenant-b', 'Tenant B', 'provisioning', 'es', 'America/La_Paz'),
  (:'tp', 'tenant-p', 'Tenant P', 'provisioning', 'es', 'America/La_Paz');
insert into public.memberships (tenant_id, user_id, role, status, accepted_at) values
  (:'ta', :'a1', 'owner', 'active', now()), (:'tb', :'b1', 'owner', 'active', now()),
  (:'tp', :'a1', 'owner', 'active', now());
update public.tenants set status = 'active' where id in (:'ta', :'tb');
set constraints all immediate;
grant usage on schema extensions to rikuy_ai;

select plan(40);

-- ── Who can reach dictation ─────────────────────────────────────────────────
set local role anon;
select throws_ok(format('select * from ai_api.begin_dictation(%L, 30)', :'ta'), '42501', null,
  'a visitor cannot reserve dictation through the Data API');
set local role authenticated;
set local request.jwt.claims to :'a1c';
select throws_ok(format('select * from ai_api.begin_dictation(%L, 30)', :'ta'), '42501', null,
  'nor a member of the municipality');
set local role service_role;
select throws_ok(format('select * from ai_api.begin_dictation(%L, 30)', :'ta'), '42501', null,
  'nor the secret key');
reset role;

-- ── Reserve, settle, settle again ───────────────────────────────────────────
set local role rikuy_ai;
select request_id as d1, outcome as d1_outcome
  from ai_api.begin_dictation(:'ta', 30, '203.0.113.7') \gset
reset role;
select is(:'d1_outcome'::text, 'reserved', 'a dictation within the quota is reserved');
select is((select reserved from public.usage_buckets where tenant_id = :'ta' and resource = 'ai_audio_seconds'),
  30::bigint, 'its seconds are set aside in the municipality''s daily dictation');
select is((select array[audio_reserved, reserved] from public.ai_platform_days where day = private.ai_platform_day()),
  array[30, 0]::bigint[], 'and in the platform''s audio of the day, not in its tokens');
select is((select limit_amount from public.usage_buckets where tenant_id = :'ta' and resource = 'ai_audio_seconds'),
  1800::bigint, '30 minutes per day by default');
select ok((select period_end - period_start = interval '1 day' from public.usage_buckets
           where tenant_id = :'ta' and resource = 'ai_audio_seconds'), 'counted per day');

set local role rikuy_ai;
select is(ai_api.finish_dictation(:'d1', 'transcribed', :'ok_call'), 'settled', 'a transcription settles its dictation');
select is(ai_api.finish_dictation(:'d1', 'transcribed', :'ok_call'), 'already_finished', 'settling twice changes nothing');
reset role;
select is((select array[reserved, consumed] from public.usage_buckets where tenant_id = :'ta' and resource = 'ai_audio_seconds'),
  array[0, 12]::bigint[], 'the reservation becomes the seconds billed');
select is((select array[audio_reserved, audio_consumed] from public.ai_platform_days where day = private.ai_platform_day()),
  array[0, 12]::bigint[], 'also in the platform''s day');
select is((select array[status, outcome, profile] from public.ai_requests where id = :'d1'),
  array['completed', 'transcribed', 'dictation'], 'the dictation is transcribed');
select is((select array[reserved_tokens, input_tokens, output_tokens, audio_seconds]
           from public.ai_requests where id = :'d1'),
  array[0, 0, 0, 12]::bigint[], 'it counts seconds and no tokens');
select is((select audio_seconds from public.ai_executions where request_id = :'d1'), 12::bigint,
  'with its call recorded');

-- A failure: what failed calls billed (nothing) and why.
set local role rikuy_ai;
select request_id as d2 from ai_api.begin_dictation(:'ta', 30, '203.0.113.7') \gset
select is(ai_api.finish_dictation(:'d2', 'provider_unavailable', :'two_failures'), 'settled',
  'a provider that does not answer settles too');
select throws_ok(format('select ai_api.finish_dictation(%L, ''transcribed'', ''[]'')', :'d2'), '22023', null,
  'a transcription needs the call that produced it');
reset role;
select is((select array[status, outcome] from public.ai_requests where id = :'d2'),
  array['failed', 'provider_unavailable'], 'the dictation failed');
select is((select consumed from public.usage_buckets where tenant_id = :'ta' and resource = 'ai_audio_seconds'),
  12::bigint, 'and gave its reservation back');

-- Dictations and questions are settled each in its own way.
set local role rikuy_ai;
select request_id as q1 from ai_api.begin_request(:'ta', 'assistant', 500) \gset
select throws_ok(format('select ai_api.finish_dictation(%L, ''transcribed'', %L)', :'q1', :'ok_call'),
  '22023', null, 'a question is not settled in seconds');
select throws_ok(format('select ai_api.finish_request(%L, ''answered'', ''[]'')', :'d1'), '22023', null,
  'nor a dictation in tokens');
select throws_ok(format('select * from ai_api.begin_dictation(%L, 5)', :'ta'), '22023', null,
  'a dictation reserves at least the 10 s the provider bills');
select throws_ok(format('select * from ai_api.begin_request(%L, ''dictation'', 30)', :'ta'), '22023', null,
  'the assistant''s requests cannot be dictations');
reset role;

-- ── The visitor's hour: dictations and questions apart ──────────────────────
set local role rikuy_ai;
do $$
declare v_id uuid;
begin
  for i in 1..9 loop
    select request_id into v_id from ai_api.begin_dictation('aaaaaaaa-0000-4000-8000-000000000001', 30, '198.51.100.4');
    perform ai_api.finish_dictation(v_id, 'transcribed',
      '[{"provider":"groq","model":"whisper-large-v3-turbo","status":"ok","audioSeconds":12,"latencyMs":400,"httpStatus":200}]');
  end loop;
end $$;
reset role;
set local role rikuy_ai;
select outcome as tenth from ai_api.begin_dictation(:'ta', 30, '198.51.100.4') \gset
select outcome as eleventh from ai_api.begin_dictation(:'ta', 30, '198.51.100.4') \gset
select outcome as question from ai_api.begin_request(:'ta', 'assistant', 500, '198.51.100.4') \gset
select outcome as other from ai_api.begin_dictation(:'ta', 30, '192.0.2.9') \gset
reset role;
select is(:'tenth'::text, 'reserved', 'the 10th dictation of a visitor in an hour passes');
select is(:'eleventh'::text, 'visitor_limit', 'the 11th is refused');
select is(:'question'::text, 'reserved', 'and the visitor can still ask in writing');
select is(:'other'::text, 'reserved', 'another visitor can dictate');

-- ── The municipality's quota and the platform's cap ─────────────────────────
set local role authenticated;
set local request.jwt.claims to :'op_aal2';
select lives_ok(format('select public.platform_set_quota(%L, ''ai_audio_seconds'', 50)', :'tb'),
  'an operator lowers a municipality''s daily dictation');
reset role;
set local role rikuy_ai;
select outcome as b1 from ai_api.begin_dictation(:'tb', 30) \gset
select outcome as b2 from ai_api.begin_dictation(:'tb', 30) \gset
reset role;
select is(:'b1'::text, 'reserved', 'a dictation that fits passes');
select is(:'b2'::text, 'tenant_quota', 'one that does not fit is refused, without reserving');
select is((select reserved from public.usage_buckets where tenant_id = :'tb' and resource = 'ai_audio_seconds'),
  30::bigint, 'only the first is set aside');

update public.ai_platform_days set audio_consumed = limit_audio_seconds - 20 where day = private.ai_platform_day();
set local role rikuy_ai;
select outcome as capped from ai_api.begin_dictation(:'ta', 30) \gset
select outcome as preparing from ai_api.begin_dictation(:'tp', 30) \gset
reset role;
select is(:'capped'::text, 'platform_quota', 'the platform''s daily seconds stop every municipality');
select is((select reserved from public.usage_buckets where tenant_id = :'ta' and resource = 'ai_audio_seconds'),
  60::bigint, 'and the municipality''s reservation is given back (two still open)');
select is(:'preparing'::text, 'tenant_unavailable', 'a municipality not online has no dictation');
update public.ai_platform_days set audio_consumed = 12 where day = private.ai_platform_day();

-- ── Orphans and readers ─────────────────────────────────────────────────────
update public.ai_requests set created_at = now() - interval '11 minutes'
where tenant_id = :'tb' and status = 'reserved';
select ok(private.expire_ai_requests() >= 1, 'a dictation left open for 10 minutes expires');
select is((select array[reserved, consumed] from public.usage_buckets where tenant_id = :'tb' and resource = 'ai_audio_seconds'),
  array[0, 30]::bigint[], 'its reservation counts as used');

set local role authenticated;
set local request.jwt.claims to :'a1c';
select is((select array[consumed, transcribed_today, refused_today] from public.tenant_voice_usage(:'ta')),
  array[120, 10, 2]::bigint[], 'a member reads the dictation of the day: seconds, transcribed and refused');
select is((select refused_today from public.tenant_ai_usage(:'ta')), 0::bigint,
  'the AI reading counts only the assistant''s requests');
select ok(not exists (select 1 from public.tenant_usage(:'ta') where resource in ('ai_tokens', 'ai_audio_seconds')),
  'the usage reading keeps storage and compute only');
select throws_ok(format('select * from public.tenant_voice_usage(%L)', :'tb'), '42501', null,
  'another municipality''s dictation is not readable');
reset role;

select * from finish();
rollback;
