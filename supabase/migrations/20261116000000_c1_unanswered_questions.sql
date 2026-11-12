-- C1 · Paso 3 — what visitors ask without an answer (ADR-053). Expand only.
--
-- Until now the assistant kept no question at all (ADR-036/038). From here on it keeps the
-- text of the questions it could not answer because nothing published covered them — and
-- only those: never an answered question, never one left unanswered for quota or a provider
-- failure. Each one is kept without anything about the visitor, with personal data masked
-- ([correo], [teléfono], [número], [enlace]), and forgotten after 90 days.
--
--   - written only by the AI role (rikuy_ai), for an assistant request of the same
--     municipality that it just served;
--   - read by every member of the municipality, grouped by the same words.

-- ── Masking and grouping ────────────────────────────────────────────────────
-- The application masks first (emails, phones, document numbers written with spaces or
-- dashes, links); this is the database's own floor, so no caller can store an email, a link
-- or six digits in a row as they came.
create function private.mask_question_text(p text)
returns text
language sql
immutable
parallel safe
strict
set search_path = ''
as $$
  select regexp_replace(
    regexp_replace(
      regexp_replace(p, '[[:alnum:]._%+-]+@[[:alnum:].-]+\.[[:alpha:]]{2,}', '[correo]', 'g'),
      'https?://[^[:space:]]+', '[enlace]', 'gi'),
    '[0-9]{6,}', '[número]', 'g');
$$;

-- Questions that say the same thing group together: case, accents and punctuation apart.
create function private.question_key(p text)
returns text
language sql
immutable
parallel safe
strict
set search_path = ''
as $$
  select btrim(regexp_replace(lower(private.unaccent_text(p)), '[^a-z0-9]+', ' ', 'g'));
$$;

revoke all on function private.mask_question_text(text) from public;
revoke all on function private.question_key(text) from public;

-- ── The questions ───────────────────────────────────────────────────────────
create table public.unanswered_questions (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants (id) on delete cascade,
  -- The assistant request that could not answer it: one question per request, and gone with
  -- it (requests are deleted after 90 days too, ADR-036).
  request_id    uuid not null,
  asked_at      timestamptz not null default clock_timestamp(),
  -- The municipality's day it was asked.
  day           date not null,
  question_text text not null,
  question_key  text not null,
  lang          text not null,
  -- Where it was asked: the kind of page and, on a place's page, the place and the scene.
  page_kind     text not null,
  content_id    uuid,
  scene_id      uuid,

  constraint unanswered_questions_tenant_id_id_key unique (tenant_id, id),
  constraint unanswered_questions_request_key unique (request_id),
  constraint unanswered_questions_request_fkey foreign key (tenant_id, request_id)
    references public.ai_requests (tenant_id, id) on delete cascade,
  constraint unanswered_questions_content_fkey foreign key (tenant_id, content_id)
    references public.content_items (tenant_id, id) on delete set null (content_id),
  constraint unanswered_questions_text check (
    char_length(question_text) between 1 and 500
    and question_text !~ '[[:alnum:]._%+-]+@[[:alnum:].-]+\.[[:alpha:]]{2,}'
    and question_text !~ '[0-9]{6}'
  ),
  constraint unanswered_questions_key check (char_length(question_key) between 1 and 500),
  constraint unanswered_questions_lang check (lang in ('es', 'en')),
  constraint unanswered_questions_page check (page_kind in (
    'home', 'destinations', 'destination', 'destination_tour', 'agenda', 'event',
    'event_tour', 'map', 'general_tour', 'other'
  )),
  constraint unanswered_questions_place check (
    content_id is null or page_kind in ('destination', 'destination_tour', 'event', 'event_tour')
  ),
  constraint unanswered_questions_scene check (
    scene_id is null or page_kind in ('destination_tour', 'event_tour')
  )
);

create index unanswered_questions_tenant_day_idx
  on public.unanswered_questions (tenant_id, day, question_key);
create index unanswered_questions_asked_at_idx on public.unanswered_questions (asked_at);

-- No policies and no grants: every write and read goes through the functions below.
alter table public.unanswered_questions enable row level security;
revoke all on public.unanswered_questions from public, anon, authenticated, service_role;

-- At most this many questions per municipality and day (a flood never fills the table).
create function private.unanswered_daily_limit()
returns integer
language sql
immutable
set search_path = ''
as $$ select 1000 $$;

-- ── Writing: the AI role, right after an answer that could not help ─────────
-- recorded · ignored (no such recent assistant request of this municipality, already
-- recorded, nothing left after masking) · capped (the day's limit).
create function ai_api.record_unanswered_question(
  p_tenant_id  uuid,
  p_request_id uuid,
  p_question   text,
  p_lang       text,
  p_page_kind  text,
  p_page_slug  text default null,
  p_scene_id   uuid default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_timezone text;
  v_day date;
  v_text text;
  v_key text;
  v_kind public.content_kind;
  v_content uuid;
  v_scene uuid;
begin
  if p_lang is null or p_lang not in ('es', 'en') then
    raise exception 'unknown language' using errcode = '22023';
  end if;
  if p_page_kind is null or p_page_kind not in (
    'home', 'destinations', 'destination', 'destination_tour', 'agenda', 'event',
    'event_tour', 'map', 'general_tour', 'other'
  ) then
    raise exception 'unknown page' using errcode = '22023';
  end if;

  -- Only a question this municipality's assistant just failed to answer.
  if not exists (
    select 1 from public.ai_requests r
    where r.tenant_id = p_tenant_id and r.id = p_request_id and r.profile = 'assistant'
      and r.status in ('completed', 'reserved') and r.created_at > now() - interval '15 minutes'
  ) then
    return 'ignored';
  end if;

  v_text := left(btrim(regexp_replace(
    private.mask_question_text(coalesce(p_question, '')), '[[:space:]]+', ' ', 'g')), 500);
  v_key := left(private.question_key(v_text), 500);
  if v_text = '' or v_key = '' then
    return 'ignored';
  end if;

  select t.timezone into v_timezone from public.tenants t where t.id = p_tenant_id;
  v_day := (now() at time zone v_timezone)::date;

  -- The questions of one municipality line up, so two at once cannot both pass the limit.
  perform pg_advisory_xact_lock(hashtextextended('unanswered:' || p_tenant_id::text, 0));
  if (
    select count(*) from public.unanswered_questions q
    where q.tenant_id = p_tenant_id and q.day = v_day
  ) >= private.unanswered_daily_limit() then
    return 'capped';
  end if;

  -- The place of the page, if it is one of this municipality's (published or not).
  if p_page_slug is not null and p_page_kind in ('destination', 'destination_tour', 'event', 'event_tour') then
    v_kind := case when p_page_kind like 'destination%' then 'destination' else 'event' end;
    select ci.id into v_content
    from public.content_items ci
    where ci.tenant_id = p_tenant_id and ci.kind = v_kind and ci.slug = p_page_slug;
  end if;
  -- The scene, if that place's tour has it.
  if v_content is not null and p_scene_id is not null and p_page_kind like '%_tour' then
    select s.scene_id into v_scene
    from public.tour_scenes s
    join public.tour_revisions r on r.tenant_id = s.tenant_id and r.id = s.tour_revision_id
    join public.tours t on t.tenant_id = r.tenant_id and t.id = r.tour_id
    where s.tenant_id = p_tenant_id and s.scene_id = p_scene_id and t.content_id = v_content
    limit 1;
  end if;

  insert into public.unanswered_questions (
    tenant_id, request_id, day, question_text, question_key, lang, page_kind, content_id, scene_id
  ) values (
    p_tenant_id, p_request_id, v_day, v_text, v_key, p_lang, p_page_kind, v_content, v_scene
  )
  on conflict (request_id) do nothing;
  return case when found then 'recorded' else 'ignored' end;
end;
$$;

revoke all on function ai_api.record_unanswered_question(uuid, uuid, text, text, text, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function ai_api.record_unanswered_question(uuid, uuid, text, text, text, text, uuid)
  to rikuy_ai;

-- ── Reading: every member of the municipality ───────────────────────────────
-- The last p_days days of the municipality (7, 30 or 90): the questions grouped by their
-- words, the most asked first (at most 200 groups), with the newest wording, how many times,
-- by how many people (distinct per day, as in «Estadísticas»), when, in which languages and
-- from which pages. Nothing about who asked.
create function public.tenant_unanswered_questions(p_tenant_id uuid, p_days integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_timezone text;
  v_to date;
  v_from date;
  v_since date;
  v_total bigint;
  v_people bigint;
  v_groups jsonb;
begin
  if not private.has_tenant_role(
    p_tenant_id, array['owner', 'admin', 'editor', 'analyst']::public.membership_role[]
  ) then
    raise exception 'not a member of this tenant' using errcode = '42501';
  end if;
  if p_days is null or p_days not in (7, 30, 90) then
    raise exception 'invalid period' using errcode = '22023';
  end if;

  select t.timezone into v_timezone from public.tenants t where t.id = p_tenant_id;
  v_to := (now() at time zone v_timezone)::date;
  v_from := v_to - (p_days - 1);

  select min(q.day) into v_since from public.unanswered_questions q where q.tenant_id = p_tenant_id;

  select count(*), count(distinct (q.day, coalesce(r.visitor_hash, q.id::text)))
  into v_total, v_people
  from public.unanswered_questions q
  join public.ai_requests r on r.tenant_id = q.tenant_id and r.id = q.request_id
  where q.tenant_id = p_tenant_id and q.day between v_from and v_to;

  with asked as (
    select q.*, coalesce(r.visitor_hash, q.id::text) as who
    from public.unanswered_questions q
    join public.ai_requests r on r.tenant_id = q.tenant_id and r.id = q.request_id
    where q.tenant_id = p_tenant_id and q.day between v_from and v_to
  ),
  grouped as (
    select a.question_key,
           count(*)::bigint as times,
           count(distinct (a.day, a.who))::bigint as people,
           min(a.asked_at) as first_asked,
           max(a.asked_at) as last_asked,
           max(a.day) as last_day,
           array_agg(distinct a.lang order by a.lang) as langs,
           (array_agg(a.question_text order by a.asked_at desc))[1] as question_text
    from asked a
    group by a.question_key
    order by times desc, people desc, last_asked desc
    limit 200
  ),
  pages as (
    select a.question_key, a.page_kind, a.content_id, a.scene_id, count(*)::bigint as times,
           row_number() over (
             partition by a.question_key
             order by count(*) desc, a.page_kind, a.content_id nulls last, a.scene_id nulls last
           ) as rank
    from asked a
    where a.question_key in (select g.question_key from grouped g)
    group by a.question_key, a.page_kind, a.content_id, a.scene_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'key', g.question_key,
           'text', g.question_text,
           'times', g.times,
           'people', g.people,
           'firstAsked', g.first_asked,
           'lastAsked', g.last_asked,
           'lastDay', g.last_day,
           'langs', to_jsonb(g.langs),
           'pages', coalesce((
             select jsonb_agg(jsonb_build_object(
                      'pageKind', p.page_kind,
                      'contentId', p.content_id,
                      'kind', ci.kind,
                      'slug', ci.slug,
                      'title', coalesce(pub.title, draft.title),
                      'sceneTitle', scene.title,
                      'times', p.times
                    ) order by p.rank)
             from pages p
             left join public.content_items ci
               on ci.tenant_id = p_tenant_id and ci.id = p.content_id
             left join public.content_revisions pub
               on pub.tenant_id = p_tenant_id and pub.id = ci.published_revision_id
             left join public.content_revisions draft
               on draft.tenant_id = p_tenant_id and draft.id = ci.draft_revision_id
             left join lateral (
               select s.title
               from public.tour_scenes s
               join public.tour_revisions r on r.tenant_id = s.tenant_id and r.id = s.tour_revision_id
               join public.tours t on t.tenant_id = r.tenant_id and t.id = r.tour_id
               where p.scene_id is not null and s.tenant_id = p_tenant_id and s.scene_id = p.scene_id
               order by coalesce(t.published_revision_id = r.id, false) desc, r.revision_no desc
               limit 1
             ) scene on true
             where p.question_key = g.question_key and p.rank <= 3
           ), '[]'::jsonb)
         ) order by g.times desc, g.people desc, g.last_asked desc), '[]'::jsonb)
  into v_groups
  from grouped g;

  return jsonb_build_object(
    'from', v_from, 'to', v_to, 'since', v_since,
    'total', v_total, 'people', v_people, 'groups', v_groups
  );
end;
$$;

revoke all on function public.tenant_unanswered_questions(uuid, integer) from public, anon, authenticated;
grant execute on function public.tenant_unanswered_questions(uuid, integer) to authenticated;

-- ── Forgetting after 90 days ────────────────────────────────────────────────
create function private.forget_unanswered_questions()
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.unanswered_questions q where q.asked_at < now() - interval '90 days';
$$;

revoke all on function private.forget_unanswered_questions() from public;

select cron.schedule(
  'rikuy-forget-unanswered-questions', '27 8 * * *',
  $$select private.forget_unanswered_questions()$$
);
