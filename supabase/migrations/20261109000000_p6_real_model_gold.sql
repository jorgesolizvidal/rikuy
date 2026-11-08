-- P6 · Paso 3 — gold with the real model (ADR-045). Expand only.
--
-- 1. eval_runs / eval_results: the operator's evaluation runs of the assistant and the
--    Copilot, case by case, with their estimated cost (ADR-044 prices) and a human rating.
-- 2. platform_eval_retire_fixtures: takes back what «Preparar los datos de prueba» published
--    in a demo (slugs «prueba-eval-…»), so the trap data is temporary.
--
-- Everything is read and written by an operator with a second factor; nobody touches the
-- tables directly. The answers are about sample content: no visitor data.

-- ── 1. Runs and results ────────────────────────────────────────────────────

create table public.eval_runs (
  id          uuid primary key default gen_random_uuid(),
  suite       text not null,
  dataset     text not null,
  tenant_a    uuid not null references public.tenants (id) on delete cascade,
  tenant_b    uuid references public.tenants (id) on delete cascade,
  provider    text not null,
  model       text not null,
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  finished_at timestamptz,

  constraint eval_runs_suite check (suite in ('assistant', 'copilot')),
  constraint eval_runs_dataset check (dataset ~ '^[a-z0-9][a-z0-9./#-]{2,79}$'),
  constraint eval_runs_provider check (provider ~ '^[a-z0-9_-]{1,40}$'),
  constraint eval_runs_model check (char_length(model) between 1 and 100),
  constraint eval_runs_two_tenants check (tenant_b is null or tenant_b <> tenant_a),
  constraint eval_runs_finished check (finished_at is null or finished_at >= created_at)
);

create index eval_runs_suite_time_idx on public.eval_runs (suite, created_at desc);

comment on table public.eval_runs is
  'An evaluation run of the assistant or the Copilot against demos (ADR-045).';

create table public.eval_results (
  run_id             uuid not null references public.eval_runs (id) on delete cascade,
  case_id            text not null,
  repetition         smallint not null,
  split              text not null,
  category           text not null,
  kind               text not null,
  pass               boolean,
  problems           text[] not null default '{}',
  answer             text not null default '',
  cited              text[] not null default '{}',
  retrieved          text[] not null default '{}',
  input_tokens       integer not null default 0,
  output_tokens      integer not null default 0,
  latency_ms         integer not null default 0,
  metrics            jsonb not null default '{}'::jsonb,
  price_version      text,
  estimated_cost_usd numeric(14, 8),
  rating             smallint,
  rated_by           uuid references auth.users (id) on delete set null,
  recorded_at        timestamptz not null default now(),

  primary key (run_id, case_id, repetition),
  constraint eval_results_case check (case_id ~ '^[A-Z][0-9]{2,3}$'),
  constraint eval_results_repetition check (repetition between 1 and 3),
  constraint eval_results_split check (split in ('dev', 'heldout', 'security', 'copilot')),
  constraint eval_results_category check (char_length(category) between 1 and 40),
  constraint eval_results_kind check (
    kind in ('chat', 'guide', 'plan', 'copilot_ask', 'copilot_propose')
  ),
  constraint eval_results_problems check (cardinality(problems) <= 20),
  constraint eval_results_answer check (char_length(answer) <= 4000),
  constraint eval_results_cited check (cardinality(cited) <= 20),
  constraint eval_results_retrieved check (cardinality(retrieved) <= 20),
  constraint eval_results_counts check (
    input_tokens >= 0 and output_tokens >= 0 and latency_ms >= 0
  ),
  constraint eval_results_metrics check (
    jsonb_typeof(metrics) = 'object' and octet_length(metrics::text) <= 2000
  ),
  constraint eval_results_rating check (rating is null or rating between 1 and 5)
);

comment on table public.eval_results is
  'One case of an evaluation run (ADR-045): pass, null when not evaluated (quota, provider).';

alter table public.eval_runs enable row level security;
alter table public.eval_results enable row level security;
revoke all on public.eval_runs, public.eval_results from public, anon, authenticated, service_role;

-- The estimated cost of each result, at the run's model and the price in force (ADR-044).
create function private.price_eval_result()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.eval_runs%rowtype;
begin
  select r.* into v_run from public.eval_runs r where r.id = new.run_id;
  new.price_version := null;
  new.estimated_cost_usd := null;
  select c.price_version, c.estimated_cost_usd into new.price_version, new.estimated_cost_usd
  from private.ai_execution_cost(
    v_run.provider, v_run.model, coalesce(new.recorded_at, now()),
    new.input_tokens, new.output_tokens, 0
  ) c;
  return new;
end;
$$;

revoke all on function private.price_eval_result() from public;

create trigger eval_results_price
  before insert or update of input_tokens, output_tokens on public.eval_results
  for each row execute function private.price_eval_result();

-- The demos of a run: online commercial demos.
create function private.assert_eval_tenant(p_tenant_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.tenants t
    where t.id = p_tenant_id and t.is_demo and t.status = 'active'
  ) then
    raise exception 'an online commercial demo is required' using errcode = '23514', hint = 'tenant';
  end if;
end;
$$;

revoke all on function private.assert_eval_tenant(uuid) from public;

create function public.platform_eval_start(
  p_suite text, p_dataset text, p_tenant_a uuid, p_tenant_b uuid, p_provider text, p_model text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.assert_operator();
  perform private.assert_eval_tenant(p_tenant_a);
  if p_tenant_b is not null then
    perform private.assert_eval_tenant(p_tenant_b);
  end if;

  insert into public.eval_runs (suite, dataset, tenant_a, tenant_b, provider, model, created_by)
  values (p_suite, p_dataset, p_tenant_a, p_tenant_b, p_provider, p_model, (select auth.uid()))
  returning id into v_id;

  insert into public.audit_events (scope, actor_id, action, entity_type, entity_id, outcome, diff)
  values ('platform', (select auth.uid()), 'eval.started', 'eval_run', v_id, 'success',
          jsonb_build_object('suite', p_suite, 'dataset', p_dataset, 'model', p_model,
                             'tenant_a', p_tenant_a, 'tenant_b', p_tenant_b));
  return v_id;
end;
$$;

-- One case's result; running a case again replaces it (and clears its rating).
create function public.platform_eval_record(
  p_run_id uuid, p_case_id text, p_repetition smallint, p_result jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.eval_runs%rowtype;
begin
  perform private.assert_operator();
  select r.* into v_run from public.eval_runs r where r.id = p_run_id for update;
  if not found then
    raise exception 'run not found' using errcode = 'PT404';
  end if;
  if v_run.finished_at is not null then
    raise exception 'the run is finished' using errcode = 'PT409';
  end if;
  if jsonb_typeof(p_result) is distinct from 'object' then
    raise exception 'result must be an object' using errcode = '22023';
  end if;

  insert into public.eval_results (
    run_id, case_id, repetition, split, category, kind, pass, problems, answer, cited,
    retrieved, input_tokens, output_tokens, latency_ms, metrics, recorded_at
  )
  values (
    p_run_id, p_case_id, p_repetition,
    p_result ->> 'split',
    p_result ->> 'category',
    p_result ->> 'kind',
    (p_result ->> 'pass')::boolean,
    coalesce(array(select jsonb_array_elements_text(p_result -> 'problems')), '{}'),
    coalesce(left(p_result ->> 'answer', 4000), ''),
    coalesce(array(select jsonb_array_elements_text(p_result -> 'cited')), '{}'),
    coalesce(array(select jsonb_array_elements_text(p_result -> 'retrieved')), '{}'),
    coalesce((p_result ->> 'inputTokens')::integer, 0),
    coalesce((p_result ->> 'outputTokens')::integer, 0),
    coalesce((p_result ->> 'latencyMs')::integer, 0),
    coalesce(p_result -> 'metrics', '{}'::jsonb),
    now()
  )
  on conflict (run_id, case_id, repetition) do update
  set split = excluded.split, category = excluded.category, kind = excluded.kind,
      pass = excluded.pass, problems = excluded.problems, answer = excluded.answer,
      cited = excluded.cited, retrieved = excluded.retrieved,
      input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
      latency_ms = excluded.latency_ms, metrics = excluded.metrics,
      recorded_at = excluded.recorded_at,
      rating = null, rated_by = null;
end;
$$;

-- The human rating (1–5) of an answer: clarity and cultural adequacy in Spanish.
create function public.platform_eval_rate(
  p_run_id uuid, p_case_id text, p_repetition smallint, p_rating smallint
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_operator();
  if p_rating is not null and p_rating not between 1 and 5 then
    raise exception 'rating must be 1 to 5' using errcode = '23514', hint = 'rating';
  end if;
  update public.eval_results e
  set rating = p_rating, rated_by = (select auth.uid())
  where e.run_id = p_run_id and e.case_id = p_case_id and e.repetition = p_repetition
    and e.pass is not null;
  if not found then
    raise exception 'result not found' using errcode = 'PT404';
  end if;
end;
$$;

create function public.platform_eval_finish(p_run_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_operator();
  update public.eval_runs r set finished_at = now()
  where r.id = p_run_id and r.finished_at is null;
  if not found then
    raise exception 'run not found or finished' using errcode = 'PT404';
  end if;
  insert into public.audit_events (scope, actor_id, action, entity_type, entity_id, outcome, diff)
  values ('platform', (select auth.uid()), 'eval.finished', 'eval_run', p_run_id, 'success',
          jsonb_build_object('results', (select count(*) from public.eval_results e
                                         where e.run_id = p_run_id)));
end;
$$;

-- The runs of a suite, newest first, with their tenants' names and how far they got.
create function public.platform_eval_runs(p_suite text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.assert_operator();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', r.id, 'suite', r.suite, 'dataset', r.dataset,
      'tenantA', jsonb_build_object('id', a.id, 'slug', a.slug, 'displayName', a.display_name),
      'tenantB', case when b.id is null then null
                      else jsonb_build_object('id', b.id, 'slug', b.slug, 'displayName', b.display_name) end,
      'provider', r.provider, 'model', r.model,
      'createdAt', r.created_at, 'finishedAt', r.finished_at,
      'results', (select count(*) from public.eval_results e where e.run_id = r.id)
    ) order by r.created_at desc)
    from public.eval_runs r
    join public.tenants a on a.id = r.tenant_a
    left join public.tenants b on b.id = r.tenant_b
    where r.suite = p_suite
    limit 20
  ), '[]'::jsonb);
end;
$$;

create function public.platform_eval_results(p_run_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.assert_operator();
  if not exists (select 1 from public.eval_runs r where r.id = p_run_id) then
    return null;
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'caseId', e.case_id, 'repetition', e.repetition, 'split', e.split,
      'category', e.category, 'kind', e.kind, 'pass', e.pass, 'problems', to_jsonb(e.problems),
      'answer', e.answer, 'cited', to_jsonb(e.cited), 'retrieved', to_jsonb(e.retrieved),
      'inputTokens', e.input_tokens, 'outputTokens', e.output_tokens,
      'latencyMs', e.latency_ms, 'metrics', e.metrics, 'priceVersion', e.price_version,
      'estimatedCostUsd', e.estimated_cost_usd, 'rating', e.rating,
      'recordedAt', e.recorded_at
    ) order by e.case_id, e.repetition)
    from public.eval_results e
    where e.run_id = p_run_id
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.platform_eval_start(text, text, uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.platform_eval_record(uuid, text, smallint, jsonb) from public, anon, authenticated;
revoke all on function public.platform_eval_rate(uuid, text, smallint, smallint) from public, anon, authenticated;
revoke all on function public.platform_eval_finish(uuid) from public, anon, authenticated;
revoke all on function public.platform_eval_runs(text) from public, anon, authenticated;
revoke all on function public.platform_eval_results(uuid) from public, anon, authenticated;
grant execute on function public.platform_eval_start(text, text, uuid, uuid, text, text) to authenticated;
grant execute on function public.platform_eval_record(uuid, text, smallint, jsonb) to authenticated;
grant execute on function public.platform_eval_rate(uuid, text, smallint, smallint) to authenticated;
grant execute on function public.platform_eval_finish(uuid) to authenticated;
grant execute on function public.platform_eval_runs(text) to authenticated;
grant execute on function public.platform_eval_results(uuid) to authenticated;

-- ── 2. Taking back the trap data ───────────────────────────────────────────

-- «Retirar los datos de prueba» (ADR-045): what «Preparar los datos de prueba» published in a
-- demo — only content whose address starts with «prueba-eval-» — loses its published
-- version. The search joins the published pointer, so the assistant stops reading it in the
-- same transaction; the portal 404s it. A retired event or destination keeps a draft copy of
-- its last version, so the panel still lists it and the next preparation publishes it again
-- (knowledge is listed as retired already). Drafts stay drafts (never visible).
create function public.platform_eval_retire_fixtures(p_tenant_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item record;
  v_draft uuid;
  v_ids uuid[] := '{}'::uuid[];
begin
  perform private.assert_operator();
  if not exists (select 1 from public.tenants t where t.id = p_tenant_id and t.is_demo) then
    raise exception 'only a commercial demo has trap data' using errcode = '23514', hint = 'tenant';
  end if;

  for v_item in
    select i.id, i.kind, i.published_revision_id, i.draft_revision_id
    from public.content_items i
    where i.tenant_id = p_tenant_id
      and i.slug like 'prueba-eval-%'
      and i.published_revision_id is not null
    order by i.id
    for update
  loop
    v_draft := v_item.draft_revision_id;
    if v_draft is null and v_item.kind <> 'knowledge' then
      insert into public.content_revisions (
        tenant_id, content_id, revision_no, title, summary, body, latitude, longitude,
        starts_local, ends_local, all_day, venue_content_id, document_version_id, opening_hours,
        created_by, updated_by
      )
      select r.tenant_id, r.content_id,
             (select max(x.revision_no) + 1 from public.content_revisions x where x.content_id = r.content_id),
             r.title, r.summary, r.body, r.latitude, r.longitude,
             r.starts_local, r.ends_local, r.all_day, r.venue_content_id, r.document_version_id,
             r.opening_hours, (select auth.uid()), (select auth.uid())
      from public.content_revisions r
      where r.id = v_item.published_revision_id
      returning id into v_draft;
    end if;
    update public.content_items i
    set published_revision_id = null, published_at = null, draft_revision_id = v_draft,
        updated_at = now()
    where i.id = v_item.id;
    v_ids := v_ids || v_item.id;
  end loop;

  insert into public.audit_events (scope, tenant_id, actor_id, action, entity_type, entity_id, outcome, diff)
  values ('tenant', p_tenant_id, (select auth.uid()), 'eval.fixtures_retired', 'tenant', p_tenant_id,
          'success', jsonb_build_object('content_ids', to_jsonb(v_ids)));
  return cardinality(v_ids);
end;
$$;

revoke all on function public.platform_eval_retire_fixtures(uuid) from public, anon, authenticated;
grant execute on function public.platform_eval_retire_fixtures(uuid) to authenticated;
