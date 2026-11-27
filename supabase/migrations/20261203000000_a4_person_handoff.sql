-- A · Paso 4 — pasar a una persona (ADR-073). Expand only.
--
-- 1. The brand accepts «Atención al visitante» (helpDesk): a name, a WhatsApp and the hours.
-- 2. A question the visitor took to a person is kept, masked, in «Lo que preguntan los
--    visitantes» (ADR-053), marked «pidió una persona», also when the assistant answered it.
--    What already read those questions (the monthly report, the Copilot, the panel's summary)
--    keeps counting only the unanswered ones.

-- ── The brand ──────────────────────────────────────────────────────────────

create or replace function private.is_valid_presentation(p jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_item jsonb;
  v_radius integer;
begin
  if not private.has_exact_keys(p, array['identity', 'theme', 'contact', 'social', 'seo'], array['logo', 'crest', 'visitors', 'assistant', 'home', 'helpDesk']) then
    return false;
  end if;

  -- home (optional, ADR-062): the cover, figures and sections of the portal's home
  if p ? 'home' and not coalesce(private.is_valid_home(p -> 'home'), false) then
    return false;
  end if;

  -- logo (optional): a reference to an image asset version, never a URL
  if p ? 'logo' and not (
    private.has_exact_keys(p -> 'logo', array['assetId', 'version'])
    and jsonb_typeof(p #> '{logo,assetId}') = 'string'
    and coalesce((p #>> '{logo,assetId}') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', false)
    and jsonb_typeof(p #> '{logo,version}') = 'number'
    and coalesce((p #>> '{logo,version}') ~ '^[1-9][0-9]{0,5}$', false)
  ) then
    return false;
  end if;

  -- crest (optional, fix/interface-details): the municipality's coat of arms for the footer,
  -- an image reference like the logo, never a URL
  if p ? 'crest' and not (
    private.has_exact_keys(p -> 'crest', array['assetId', 'version'])
    and jsonb_typeof(p #> '{crest,assetId}') = 'string'
    and coalesce((p #>> '{crest,assetId}') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', false)
    and jsonb_typeof(p #> '{crest,version}') = 'number'
    and coalesce((p #>> '{crest,version}') ~ '^[1-9][0-9]{0,5}$', false)
  ) then
    return false;
  end if;

  -- visitors (optional): whole meters between 50 and 1000
  if p ? 'visitors' then
    if not (
      private.has_exact_keys(p -> 'visitors', array['nearbyRadius'])
      and jsonb_typeof(p #> '{visitors,nearbyRadius}') = 'number'
      and coalesce((p #>> '{visitors,nearbyRadius}') ~ '^[1-9][0-9]{1,3}$', false)
    ) then
      return false;
    end if;
    v_radius := (p #>> '{visitors,nearbyRadius}')::integer;
    if v_radius < 50 or v_radius > 1000 then
      return false;
    end if;
  end if;

  -- assistant (optional): the visitor assistant's persona. Plain lines only; the tone is one
  -- of two fixed values, so no text of the municipality ever becomes an instruction.
  if p ? 'assistant' and not (
    private.has_exact_keys(p -> 'assistant', array['name', 'greeting', 'tone'])
    and private.is_plain_line(p #> '{assistant,name}', 1, 40)
    and private.is_plain_line(p #> '{assistant,greeting}', 0, 240)
    and jsonb_typeof(p #> '{assistant,tone}') = 'string'
    and coalesce(p #>> '{assistant,tone}' in ('warm', 'formal'), false)
  ) then
    return false;
  end if;

  -- helpDesk (optional, ADR-073): «Atención al visitante», who answers the visitors who ask
  -- for a person. A name, an international WhatsApp number (as the services', ADR-069) and
  -- the opening hours of ADR-039.
  if p ? 'helpDesk' and not (
    private.has_exact_keys(p -> 'helpDesk', array['name'], array['whatsapp', 'hours'])
    and private.is_plain_line(p #> '{helpDesk,name}', 1, 60)
    and (
      not (p -> 'helpDesk' ? 'whatsapp')
      or (
        jsonb_typeof(p #> '{helpDesk,whatsapp}') = 'string'
        and coalesce((p #>> '{helpDesk,whatsapp}') ~ '^\+[0-9][0-9 ()-]{6,22}$', false)
      )
    )
    and (
      not (p -> 'helpDesk' ? 'hours')
      or coalesce(private.is_valid_opening_hours(p #> '{helpDesk,hours}'), false)
    )
  ) then
    return false;
  end if;

  -- identity
  if not (
    private.has_exact_keys(p -> 'identity', array['siteName', 'shortName', 'tagline'])
    and private.is_plain_line(p #> '{identity,siteName}', 1, 60)
    and private.is_plain_line(p #> '{identity,shortName}', 1, 12)
    and private.is_plain_line(p #> '{identity,tagline}', 0, 140)
  ) then
    return false;
  end if;

  -- theme: colors are lowercase #rrggbb, so they are safe inside CSS. The style (optional,
  -- ADR-061) is one of two fixed values; «immersive» exists only on a dark background.
  if not (
    private.has_exact_keys(p -> 'theme', array['mode', 'brand', 'accent'], array['style'])
    and coalesce(p #>> '{theme,mode}' in ('light', 'dark'), false)
    and coalesce((p #>> '{theme,brand}') ~ '^#[0-9a-f]{6}$', false)
    and coalesce((p #>> '{theme,accent}') ~ '^#[0-9a-f]{6}$', false)
    and jsonb_typeof(p #> '{theme,brand}') = 'string'
    and jsonb_typeof(p #> '{theme,accent}') = 'string'
    and (
      not (p -> 'theme' ? 'style')
      or (
        jsonb_typeof(p #> '{theme,style}') = 'string'
        and coalesce(p #>> '{theme,style}' in ('editorial', 'immersive'), false)
        and (p #>> '{theme,style}' <> 'immersive' or p #>> '{theme,mode}' = 'dark')
      )
    )
  ) then
    return false;
  end if;

  -- contact: every key optional
  if not private.has_exact_keys(p -> 'contact', array[]::text[], array['email', 'phone', 'address']) then
    return false;
  end if;
  if p -> 'contact' ? 'email' and not (
    private.is_plain_line(p #> '{contact,email}', 3, 254)
    and (p #>> '{contact,email}') ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  ) then
    return false;
  end if;
  if p -> 'contact' ? 'phone' and not (
    jsonb_typeof(p #> '{contact,phone}') = 'string'
    and (p #>> '{contact,phone}') ~ '^\+?[0-9][0-9 ()-]{5,29}$'
  ) then
    return false;
  end if;
  if p -> 'contact' ? 'address' and not private.is_plain_line(p #> '{contact,address}', 1, 160) then
    return false;
  end if;

  -- social: up to 5 https links, one per network
  if jsonb_typeof(p -> 'social') <> 'array' or jsonb_array_length(p -> 'social') > 5 then
    return false;
  end if;
  for v_item in select value from jsonb_array_elements(p -> 'social') loop
    if not (
      private.has_exact_keys(v_item, array['network', 'url'])
      and coalesce(v_item ->> 'network' in ('facebook', 'instagram', 'tiktok', 'youtube', 'x'), false)
      and private.is_plain_line(v_item -> 'url', 9, 300)
      -- https, no userinfo in the authority, no whitespace anywhere
      and (v_item ->> 'url') ~ '^https://[^/@?#[:space:]]+([/?#][^[:space:]]*)?$'
    ) then
      return false;
    end if;
  end loop;
  if (select count(distinct value ->> 'network') from jsonb_array_elements(p -> 'social'))
     <> jsonb_array_length(p -> 'social') then
    return false;
  end if;

  -- seo
  return private.has_exact_keys(p -> 'seo', array['description'])
    and private.is_plain_line(p #> '{seo,description}', 0, 160);
end;
$$;

revoke all on function private.is_valid_presentation(jsonb) from public;

-- ── The questions taken to a person ────────────────────────────────────────

-- answered: the assistant answered it (only a person request keeps those).
-- asked_person_at: when the visitor tapped WhatsApp, «Llamar» or the email.
alter table public.unanswered_questions
  add column answered boolean not null default false,
  add column asked_person_at timestamptz,
  add constraint unanswered_questions_answered_asked_person check (
    not answered or asked_person_at is not null
  );

create index unanswered_questions_asked_person_idx
  on public.unanswered_questions (tenant_id, day)
  where asked_person_at is not null;

-- The questions of one period, grouped by their words (ADR-053): the unanswered ones
-- (p_person false) or the ones taken to a person (p_person true). Each group also says how
-- many ended in a person and how many the assistant had answered.
create function private.question_groups_between(
  p_tenant_id uuid, p_from date, p_to date, p_person boolean
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_since date;
  v_total bigint;
  v_people bigint;
  v_asked_person bigint;
  v_groups jsonb;
begin
  select min(q.day) into v_since
  from public.unanswered_questions q
  where q.tenant_id = p_tenant_id
    and (case when p_person then q.asked_person_at is not null else not q.answered end);

  select count(*), count(distinct (q.day, coalesce(r.visitor_hash, q.id::text))),
         count(*) filter (where q.asked_person_at is not null)
  into v_total, v_people, v_asked_person
  from public.unanswered_questions q
  join public.ai_requests r on r.tenant_id = q.tenant_id and r.id = q.request_id
  where q.tenant_id = p_tenant_id and q.day between p_from and p_to
    and (case when p_person then q.asked_person_at is not null else not q.answered end);

  with asked as (
    select q.*, coalesce(r.visitor_hash, q.id::text) as who
    from public.unanswered_questions q
    join public.ai_requests r on r.tenant_id = q.tenant_id and r.id = q.request_id
    where q.tenant_id = p_tenant_id and q.day between p_from and p_to
      and (case when p_person then q.asked_person_at is not null else not q.answered end)
  ),
  grouped as (
    select a.question_key,
           count(*)::bigint as times,
           count(distinct (a.day, a.who))::bigint as people,
           count(*) filter (where a.asked_person_at is not null)::bigint as asked_person,
           count(*) filter (where a.answered)::bigint as answered,
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
           'askedPerson', g.asked_person,
           'answered', g.answered,
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
    'from', p_from, 'to', p_to, 'since', v_since,
    'total', v_total, 'people', v_people, 'askedPerson', v_asked_person, 'groups', v_groups
  );
end;
$$;

revoke all on function private.question_groups_between(uuid, date, date, boolean) from public;

-- The unanswered ones, as before (the monthly report, the Copilot and the panel read this):
-- a question the assistant answered and the visitor took to a person is not «sin respuesta».
create or replace function private.unanswered_questions_between(p_tenant_id uuid, p_from date, p_to date)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.question_groups_between(p_tenant_id, p_from, p_to, false);
$$;

revoke all on function private.unanswered_questions_between(uuid, date, date) from public;

-- The last p_days days (7, 30 or 90) of questions taken to a person, for any member.
create function public.tenant_person_requests(p_tenant_id uuid, p_days integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_to date;
begin
  if not private.has_tenant_role(
    p_tenant_id, array['owner', 'admin', 'editor', 'analyst']::public.membership_role[]
  ) then
    raise exception 'not a member of this tenant' using errcode = '42501';
  end if;
  if p_days is null or p_days not in (7, 30, 90) then
    raise exception 'invalid period' using errcode = '22023';
  end if;
  select (now() at time zone t.timezone)::date into v_to from public.tenants t where t.id = p_tenant_id;
  return private.question_groups_between(p_tenant_id, v_to - (p_days - 1), v_to, true);
end;
$$;

revoke all on function public.tenant_person_requests(uuid, integer) from public, anon, authenticated;
grant execute on function public.tenant_person_requests(uuid, integer) to authenticated;

-- An unanswered question kept after the visitor already took it to a person (a race of
-- seconds): it is unanswered after all, and keeps its mark.
create or replace function ai_api.record_unanswered_question(
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

  -- Already kept as taken to a person: now it is unanswered too.
  update public.unanswered_questions q
  set answered = false
  where q.tenant_id = p_tenant_id and q.request_id = p_request_id and q.answered;
  if found then
    return 'recorded';
  end if;

  if (
    select count(*) from public.unanswered_questions q
    where q.tenant_id = p_tenant_id and q.day = v_day
  ) >= private.unanswered_daily_limit() then
    return 'capped';
  end if;

  -- The place of the page, if it is one of this municipality's (published or not).
  if p_page_slug is not null and p_page_kind in ('destination', 'destination_tour', 'event', 'event_tour') then
    v_kind := (case when p_page_kind like 'destination%' then 'destination' else 'event' end)::public.content_kind;
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

-- The visitor tapped WhatsApp, «Llamar» or the email after this answer (ADR-073): its
-- question is kept, masked, marked «pidió una persona». Only for a request of this
-- municipality's assistant of the last hour, and of the same visitor (the same daily print
-- of ADR-036). A question already kept as unanswered is only marked.
create function ai_api.record_person_request(
  p_tenant_id  uuid,
  p_request_id uuid,
  p_visitor    text,
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

  -- This municipality's assistant answered (or tried to answer) this visitor in the last hour.
  if not exists (
    select 1
    from public.ai_requests r
    left join private.ai_visitor_salts s on s.day = private.ai_platform_day(r.created_at)
    where r.tenant_id = p_tenant_id and r.id = p_request_id and r.profile = 'assistant'
      and r.created_at > now() - interval '1 hour'
      and r.visitor_hash is not distinct from (
        case when p_visitor is null or s.salt is null then null
             else encode(sha256(convert_to(
               s.salt || ':' || p_tenant_id::text || ':' || p_visitor, 'UTF8')), 'hex')
        end
      )
  ) then
    return 'ignored';
  end if;

  select t.timezone into v_timezone from public.tenants t where t.id = p_tenant_id;
  v_day := (now() at time zone v_timezone)::date;

  perform pg_advisory_xact_lock(hashtextextended('unanswered:' || p_tenant_id::text, 0));

  -- Already kept (unanswered, or taken to a person before): only the mark.
  update public.unanswered_questions q
  set asked_person_at = coalesce(q.asked_person_at, now())
  where q.tenant_id = p_tenant_id and q.request_id = p_request_id;
  if found then
    return 'recorded';
  end if;

  v_text := left(btrim(regexp_replace(
    private.mask_question_text(coalesce(p_question, '')), '[[:space:]]+', ' ', 'g')), 500);
  v_key := left(private.question_key(v_text), 500);
  if v_text = '' or v_key = '' then
    return 'ignored';
  end if;

  if (
    select count(*) from public.unanswered_questions q
    where q.tenant_id = p_tenant_id and q.day = v_day
  ) >= private.unanswered_daily_limit() then
    return 'capped';
  end if;

  if p_page_slug is not null and p_page_kind in ('destination', 'destination_tour', 'event', 'event_tour') then
    v_kind := (case when p_page_kind like 'destination%' then 'destination' else 'event' end)::public.content_kind;
    select ci.id into v_content
    from public.content_items ci
    where ci.tenant_id = p_tenant_id and ci.kind = v_kind and ci.slug = p_page_slug;
  end if;
  if v_content is not null and p_scene_id is not null and p_page_kind like '%_tour' then
    select s.scene_id into v_scene
    from public.tour_scenes s
    join public.tour_revisions r on r.tenant_id = s.tenant_id and r.id = s.tour_revision_id
    join public.tours t on t.tenant_id = r.tenant_id and t.id = r.tour_id
    where s.tenant_id = p_tenant_id and s.scene_id = p_scene_id and t.content_id = v_content
    limit 1;
  end if;

  insert into public.unanswered_questions (
    tenant_id, request_id, day, question_text, question_key, lang, page_kind, content_id,
    scene_id, answered, asked_person_at
  ) values (
    p_tenant_id, p_request_id, v_day, v_text, v_key, p_lang, p_page_kind, v_content,
    v_scene, true, now()
  )
  on conflict (request_id) do update
    set asked_person_at = coalesce(public.unanswered_questions.asked_person_at, now());
  return 'recorded';
end;
$$;

revoke all on function ai_api.record_person_request(uuid, uuid, text, text, text, text, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function ai_api.record_person_request(uuid, uuid, text, text, text, text, text, uuid)
  to rikuy_ai;
