-- C1 · Paso 4 — the Copilot's recommendations from the metrics (ADR-054). Expand only.
--
-- On request («Generar recomendaciones», in «Estadísticas»), the platform computes a list of
-- labeled facts (H1, H2…) from four sources — visits and actions, the questions the assistant
-- could not answer, the content review and the agenda — and the Copilot's model writes up to
-- six recommendations, each naming the facts it rests on. Only the latest set is kept per
-- municipality, with its facts and its date.
--
--   - Every recommendation cites at least one fact, and every number it writes must appear in
--     the facts it cites: the application checks it and this database checks it again, so a
--     caller cannot store an invented figure.
--   - Nothing is ever published or changed: a recommendation is text with links to the
--     editors. The table keeps no prompt and no model reasoning.
--   - Any member generates and reads them (analysts already ask the Copilot); owners and
--     admins with their second factor (ADR-043).

-- ── Numbers ───────────────────────────────────────────────────────────────
-- The figures of a text, normalized: «1.234» and «1234» are the same, «09» is «9». A tour's
-- «360°» and a fact's own label («H2») are not figures.
create function private.recommendation_numbers(p text)
returns text[]
language sql
immutable
parallel safe
strict
set search_path = ''
as $$
  select coalesce(array_agg(distinct coalesce(nullif(ltrim(regexp_replace(m[1], '[.,]', '', 'g'), '0'), ''), '0')), '{}')
  from regexp_matches(
    regexp_replace(regexp_replace(p, '360[[:space:]]?°', ' ', 'g'), '\mH[0-9]+\M', ' ', 'g'),
    '([0-9]+(?:[.,][0-9]+)*)', 'g'
  ) as m;
$$;

revoke all on function private.recommendation_numbers(text) from public;

-- ── Table ─────────────────────────────────────────────────────────────────

create table public.copilot_recommendations (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants (id) on delete cascade,
  -- The visits period the facts were computed on (the municipality's days).
  period_from   date not null,
  period_to     date not null,
  -- [{"id": "H1", "source": "visits", "text": "…", "target": {…} | null}], at most 40.
  facts         jsonb not null,
  -- [{"title": "…", "why": "…", "facts": ["H1", "H4"]}], one to six.
  items         jsonb not null,
  ai_request_id uuid not null,
  created_by    uuid references auth.users (id) on delete set null,
  created_at    timestamptz not null default clock_timestamp(),

  -- Only the latest set of each municipality.
  constraint copilot_recommendations_tenant_key unique (tenant_id),
  constraint copilot_recommendations_tenant_id_id_key unique (tenant_id, id),
  -- Forgotten with the AI request behind it (90 days, ADR-036).
  constraint copilot_recommendations_request_fkey foreign key (tenant_id, ai_request_id)
    references public.ai_requests (tenant_id, id) on delete cascade,
  constraint copilot_recommendations_period check (
    period_to >= period_from and period_to - period_from <= 400
  ),
  constraint copilot_recommendations_facts check (
    jsonb_typeof(facts) = 'array' and jsonb_array_length(facts) between 1 and 40
    and octet_length(facts::text) <= 60000
  ),
  constraint copilot_recommendations_items check (
    jsonb_typeof(items) = 'array' and jsonb_array_length(items) between 1 and 6
    and octet_length(items::text) <= 16000
  )
);

create index copilot_recommendations_request_idx
  on public.copilot_recommendations (tenant_id, ai_request_id);

alter table public.copilot_recommendations enable row level security;
-- No policies and no grants: every read and write goes through the RPCs below.
revoke all on public.copilot_recommendations from public, anon, authenticated;

create trigger copilot_recommendations_tenant_immutable
  before update on public.copilot_recommendations
  for each row execute function private.forbid_tenant_change();

-- ── Validation ────────────────────────────────────────────────────────────

-- One plain line of text: a string, 1..max characters, no control characters.
create function private.is_recommendation_line(p jsonb, p_max integer)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    jsonb_typeof(p) = 'string'
    and char_length(btrim(p #>> '{}')) between 1 and p_max
    and (p #>> '{}') !~ '[[:cntrl:]]',
    false
  );
$$;

revoke all on function private.is_recommendation_line(jsonb, integer) from public;

-- Where a fact leads in the panel: a destination or event (of this municipality), a scene of
-- its tour, a visitor's question (to test in «Conocimiento del asistente») or the agenda.
create function private.is_valid_recommendation_target(p_tenant_id uuid, p jsonb)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  if p is null or jsonb_typeof(p) = 'null' then
    return true;
  end if;
  if jsonb_typeof(p) <> 'object' then
    return false;
  end if;
  case p ->> 'type'
    when 'content' then
      -- Checked one after the other: a uuid is cast only once its text is a uuid.
      if not (private.has_exact_keys(p, array['type', 'kind', 'contentId', 'proposable'])
              and p ->> 'kind' in ('destination', 'event')
              and jsonb_typeof(p -> 'proposable') = 'boolean'
              and coalesce(p ->> 'contentId' ~ v_uuid, false)) then
        return false;
      end if;
      return exists (
        select 1 from public.content_items i
        where i.tenant_id = p_tenant_id and i.id = (p ->> 'contentId')::uuid
          and i.kind::text = p ->> 'kind'
      );
    when 'scene' then
      if not (private.has_exact_keys(p, array['type', 'kind', 'contentId', 'tourId', 'sceneId'])
              and p ->> 'kind' in ('destination', 'event')
              and coalesce(p ->> 'contentId' ~ v_uuid and p ->> 'tourId' ~ v_uuid
                           and p ->> 'sceneId' ~ v_uuid, false)) then
        return false;
      end if;
      return exists (
        select 1 from public.tours t
        where t.tenant_id = p_tenant_id and t.id = (p ->> 'tourId')::uuid
          and t.content_id = (p ->> 'contentId')::uuid
      );
    when 'question' then
      return private.has_exact_keys(p, array['type', 'question'])
        and private.is_recommendation_line(p -> 'question', 500);
    when 'agenda' then
      return private.has_exact_keys(p, array['type']);
    else
      return false;
  end case;
end;
$$;

revoke all on function private.is_valid_recommendation_target(uuid, jsonb) from public;

-- ── Save ──────────────────────────────────────────────────────────────────

-- Replaces the municipality's recommendations with a new set, tied to a copilot request of
-- this same person in this municipality in the last hour. Every recommendation cites known
-- facts, and every number it writes is in those facts.
create function public.save_copilot_recommendations(
  p_tenant_id uuid,
  p_ai_request_id uuid,
  p_period_from date,
  p_period_to date,
  p_facts jsonb,
  p_items jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fact jsonb;
  v_item jsonb;
  v_ids text[] := '{}'::text[];
  v_cited text[];
  v_text text;
  v_id uuid;
begin
  perform private.assert_content_role(p_tenant_id, array['owner', 'admin', 'editor', 'analyst']::public.membership_role[]);

  if p_period_from is null or p_period_to is null
     or p_period_to < p_period_from or p_period_to - p_period_from > 400 then
    raise exception 'invalid period' using errcode = '22023';
  end if;

  if p_facts is null or jsonb_typeof(p_facts) <> 'array'
     or jsonb_array_length(p_facts) not between 1 and 40 or octet_length(p_facts::text) > 60000 then
    raise exception 'invalid facts' using errcode = '23514', hint = 'facts';
  end if;
  for v_fact in select f from jsonb_array_elements(p_facts) f loop
    if not private.has_exact_keys(v_fact, array['id', 'source', 'text', 'target'])
       or jsonb_typeof(v_fact -> 'id') <> 'string'
       or (v_fact ->> 'id') !~ '^H[1-9][0-9]?$'
       or (v_fact ->> 'id') = any (v_ids)
       or coalesce(v_fact ->> 'source', '') not in ('visits', 'questions', 'review', 'agenda')
       or not private.is_recommendation_line(v_fact -> 'text', 400)
       or not private.is_valid_recommendation_target(p_tenant_id, v_fact -> 'target') then
      raise exception 'invalid fact' using errcode = '23514', hint = 'facts';
    end if;
    v_ids := v_ids || (v_fact ->> 'id');
  end loop;

  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) not between 1 and 6 or octet_length(p_items::text) > 16000 then
    raise exception 'invalid recommendations' using errcode = '23514', hint = 'items';
  end if;
  for v_item in select i from jsonb_array_elements(p_items) i loop
    if not private.has_exact_keys(v_item, array['title', 'why', 'facts'])
       or not private.is_recommendation_line(v_item -> 'title', 160)
       or not private.is_recommendation_line(v_item -> 'why', 500)
       or jsonb_typeof(v_item -> 'facts') <> 'array'
       or jsonb_array_length(v_item -> 'facts') not between 1 and 8
       or exists (
         select 1 from jsonb_array_elements(v_item -> 'facts') c
         where jsonb_typeof(c) <> 'string' or (c #>> '{}') <> all (v_ids)
       ) then
      raise exception 'invalid recommendation' using errcode = '23514', hint = 'items';
    end if;
    v_text := (v_item ->> 'title') || ' ' || (v_item ->> 'why');
    if v_text ~* '(https?://|www\.)' then
      raise exception 'a recommendation has a link' using errcode = '23514', hint = 'items';
    end if;
    select array_agg(c #>> '{}') into v_cited from jsonb_array_elements(v_item -> 'facts') c;
    -- Every number written must be in the facts it cites.
    if not private.recommendation_numbers(v_text) <@ private.recommendation_numbers(coalesce((
      select string_agg(f ->> 'text', ' ')
      from jsonb_array_elements(p_facts) f
      where f ->> 'id' = any (v_cited)
    ), '')) then
      raise exception 'a recommendation has a number its facts do not have' using errcode = '23514', hint = 'numbers';
    end if;
  end loop;

  -- The model's answer behind it: a copilot request of this person, here, in the last hour.
  if not exists (
    select 1 from public.ai_requests a
    where a.tenant_id = p_tenant_id and a.id = p_ai_request_id
      and a.profile = 'copilot' and a.status = 'completed'
      and a.actor_id = (select auth.uid())
      and a.created_at > now() - interval '1 hour'
  ) then
    raise exception 'no copilot request behind these recommendations' using errcode = '23514', hint = 'request';
  end if;

  delete from public.copilot_recommendations r where r.tenant_id = p_tenant_id;
  insert into public.copilot_recommendations (
    tenant_id, period_from, period_to, facts, items, ai_request_id, created_by
  ) values (
    p_tenant_id, p_period_from, p_period_to, p_facts, p_items, p_ai_request_id, (select auth.uid())
  ) returning id into v_id;

  insert into public.audit_events (scope, tenant_id, actor_id, action, entity_type, entity_id, revision, outcome, diff)
  values ('tenant', p_tenant_id, (select auth.uid()), 'copilot.recommendations_generated', 'copilot_recommendations', v_id, null, 'success',
          jsonb_build_object('recommendations', jsonb_array_length(p_items), 'facts', jsonb_array_length(p_facts),
                             'from', p_period_from, 'to', p_period_to));

  return v_id;
end;
$$;

revoke all on function public.save_copilot_recommendations(uuid, uuid, date, date, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.save_copilot_recommendations(uuid, uuid, date, date, jsonb, jsonb) to authenticated;

-- ── Read ──────────────────────────────────────────────────────────────────

-- The municipality's latest recommendations (null: none yet). Any member.
create function public.latest_copilot_recommendations(p_tenant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if not private.has_tenant_role(
    p_tenant_id, array['owner', 'admin', 'editor', 'analyst']::public.membership_role[]
  ) then
    raise exception 'not a member of this tenant' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'id', r.id,
    'createdAt', r.created_at,
    'from', r.period_from,
    'to', r.period_to,
    'facts', r.facts,
    'items', r.items,
    'mine', r.created_by = (select auth.uid())
  ) into v_result
  from public.copilot_recommendations r
  where r.tenant_id = p_tenant_id;
  return v_result;
end;
$$;

revoke all on function public.latest_copilot_recommendations(uuid) from public, anon, authenticated;
grant execute on function public.latest_copilot_recommendations(uuid) to authenticated;
