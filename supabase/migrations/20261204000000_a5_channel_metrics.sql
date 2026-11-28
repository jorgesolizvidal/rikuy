-- A · Paso 5.1 — métricas por canal (ADR-074). Expand only.
--
-- Each answer of the visitor's assistant is kept as a turn: its channel (portal, the
-- municipality's website, a QR, WhatsApp later), what kind of answer it was, what it cited
-- (the topics) and what the visitor tapped in it afterwards. Nothing of the visitor and no
-- text: the turn belongs to its gateway request and goes with it after 90 days.

-- ── Tables ─────────────────────────────────────────────────────────────────

create table public.assistant_turns (
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  request_id uuid primary key,
  day        date not null,
  channel    text not null,
  kind       text not null,
  page_kind  text not null,
  created_at timestamptz not null default now(),

  constraint assistant_turns_tenant_request_key unique (tenant_id, request_id),
  constraint assistant_turns_request_fkey foreign key (tenant_id, request_id)
    references public.ai_requests (tenant_id, id) on delete cascade,
  constraint assistant_turns_channel check (channel in ('portal', 'embed', 'qr', 'whatsapp')),
  constraint assistant_turns_kind check (kind in ('answered', 'abstained', 'plan', 'notice')),
  constraint assistant_turns_page_kind check (page_kind in (
    'home', 'destinations', 'destination', 'destination_tour', 'agenda', 'event',
    'event_tour', 'map', 'general_tour', 'other'
  ))
);

create index assistant_turns_tenant_day_idx on public.assistant_turns (tenant_id, day);

create table public.assistant_turn_citations (
  tenant_id  uuid not null,
  request_id uuid not null,
  content_id uuid not null,

  primary key (request_id, content_id),
  constraint assistant_turn_citations_turn_fkey foreign key (tenant_id, request_id)
    references public.assistant_turns (tenant_id, request_id) on delete cascade,
  constraint assistant_turn_citations_content_fkey foreign key (tenant_id, content_id)
    references public.content_items (tenant_id, id) on delete cascade
);

create index assistant_turn_citations_content_idx
  on public.assistant_turn_citations (tenant_id, content_id);

create table public.assistant_turn_actions (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null,
  request_id uuid not null,
  action     text not null,
  content_id uuid,
  at         timestamptz not null default now(),

  constraint assistant_turn_actions_turn_fkey foreign key (tenant_id, request_id)
    references public.assistant_turns (tenant_id, request_id) on delete cascade,
  constraint assistant_turn_actions_content_fkey foreign key (tenant_id, content_id)
    references public.content_items (tenant_id, id) on delete cascade,
  constraint assistant_turn_actions_action check (
    action in ('place', 'tour', 'map', 'section', 'person')
  ),
  constraint assistant_turn_actions_once unique nulls not distinct (request_id, action, content_id)
);

create index assistant_turn_actions_turn_idx on public.assistant_turn_actions (tenant_id, request_id);

alter table public.assistant_turns enable row level security;
alter table public.assistant_turn_citations enable row level security;
alter table public.assistant_turn_actions enable row level security;
revoke all on public.assistant_turns, public.assistant_turn_citations,
  public.assistant_turn_actions from public, anon, authenticated, service_role;

-- ── Helpers ────────────────────────────────────────────────────────────────

-- The content a cited key names in this municipality: `kind:slug`; a tour counts for its place.
create function private.assistant_content_of(p_tenant_id uuid, p_key text)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_kind text;
  v_slug text;
  v_id uuid;
begin
  if p_key is null or p_key !~ '^[a-z_]+:[a-z0-9]+(-[a-z0-9]+)*$' then
    return null;
  end if;
  v_kind := split_part(p_key, ':', 1);
  v_slug := split_part(p_key, ':', 2);
  v_kind := case v_kind when 'destination_tour' then 'destination' when 'event_tour' then 'event'
                        else v_kind end;
  if v_kind not in ('destination', 'event', 'knowledge', 'notice', 'service', 'story') then
    return null;
  end if;
  select ci.id into v_id
  from public.content_items ci
  where ci.tenant_id = p_tenant_id and ci.kind::text = v_kind and ci.slug = v_slug;
  return v_id;
end;
$$;

revoke all on function private.assistant_content_of(uuid, text) from public;

-- ── Recording (only the AI role) ───────────────────────────────────────────

-- One answer of the visitor's assistant, after it is on its way: a request of this
-- municipality's assistant of the last 15 minutes, once. Its citations, up to 12.
create function ai_api.record_assistant_turn(
  p_tenant_id  uuid,
  p_request_id uuid,
  p_channel    text,
  p_kind       text,
  p_page_kind  text,
  p_cited      text[] default '{}'
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_timezone text;
  v_key text;
  v_content uuid;
begin
  if p_channel is null or p_channel not in ('portal', 'embed', 'qr', 'whatsapp') then
    raise exception 'unknown channel' using errcode = '22023';
  end if;
  if p_kind is null or p_kind not in ('answered', 'abstained', 'plan', 'notice') then
    raise exception 'unknown kind' using errcode = '22023';
  end if;
  if p_page_kind is null or p_page_kind not in (
    'home', 'destinations', 'destination', 'destination_tour', 'agenda', 'event',
    'event_tour', 'map', 'general_tour', 'other'
  ) then
    raise exception 'unknown page' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.ai_requests r
    where r.tenant_id = p_tenant_id and r.id = p_request_id and r.profile = 'assistant'
      and r.created_at > now() - interval '15 minutes'
  ) then
    return 'ignored';
  end if;

  select t.timezone into v_timezone from public.tenants t where t.id = p_tenant_id;
  insert into public.assistant_turns (tenant_id, request_id, day, channel, kind, page_kind)
  values (p_tenant_id, p_request_id, (now() at time zone v_timezone)::date, p_channel, p_kind, p_page_kind)
  on conflict (request_id) do nothing;
  if not found then
    return 'ignored';
  end if;

  foreach v_key in array coalesce(p_cited[1:12], '{}'::text[]) loop
    v_content := private.assistant_content_of(p_tenant_id, v_key);
    if v_content is not null then
      insert into public.assistant_turn_citations (tenant_id, request_id, content_id)
      values (p_tenant_id, p_request_id, v_content)
      on conflict do nothing;
    end if;
  end loop;
  return 'recorded';
end;
$$;

-- What the visitor tapped inside an answer: the answer was recorded, is of the last hour and of
-- the same visitor (the daily print of ADR-036). Once per answer, action and content; up to 20.
create function ai_api.record_assistant_action(
  p_tenant_id  uuid,
  p_request_id uuid,
  p_visitor    text,
  p_action     text,
  p_key        text default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_content uuid;
begin
  if p_action is null or p_action not in ('place', 'tour', 'map', 'section', 'person') then
    raise exception 'unknown action' using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.assistant_turns t
    join public.ai_requests r on r.tenant_id = t.tenant_id and r.id = t.request_id
    left join private.ai_visitor_salts s on s.day = private.ai_platform_day(r.created_at)
    where t.tenant_id = p_tenant_id and t.request_id = p_request_id
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

  v_content := case when p_action in ('place', 'tour') then private.assistant_content_of(p_tenant_id, p_key) end;
  if p_action = 'place' and v_content is null then
    return 'ignored';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('assistant-action:' || p_request_id::text, 0));
  if (select count(*) from public.assistant_turn_actions a where a.request_id = p_request_id) >= 20 then
    return 'capped';
  end if;
  insert into public.assistant_turn_actions (tenant_id, request_id, action, content_id)
  values (p_tenant_id, p_request_id, p_action, v_content)
  on conflict do nothing;
  return 'recorded';
end;
$$;

revoke all on function ai_api.record_assistant_turn(uuid, uuid, text, text, text, text[])
  from public, anon, authenticated, service_role;
grant execute on function ai_api.record_assistant_turn(uuid, uuid, text, text, text, text[])
  to rikuy_ai;
revoke all on function ai_api.record_assistant_action(uuid, uuid, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function ai_api.record_assistant_action(uuid, uuid, text, text, text)
  to rikuy_ai;

-- ── Reading ────────────────────────────────────────────────────────────────

-- The assistant of one period: by channel, the most cited contents and what was tapped.
create function private.assistant_statistics(p_tenant_id uuid, p_from date, p_to date)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with turns as (
    select t.*, coalesce(r.visitor_hash, t.request_id::text) as who
    from public.assistant_turns t
    join public.ai_requests r on r.tenant_id = t.tenant_id and r.id = t.request_id
    where t.tenant_id = p_tenant_id and t.day between p_from and p_to
  ),
  channels as (
    select t.channel,
           count(*)::bigint as conversations,
           count(distinct (t.day, t.who))::bigint as people,
           count(*) filter (where t.kind = 'answered')::bigint as answered,
           count(*) filter (where t.kind = 'abstained')::bigint as abstained,
           count(*) filter (where t.kind = 'plan')::bigint as plans,
           count(*) filter (where t.kind = 'notice')::bigint as notices,
           count(*) filter (where exists (
             select 1 from public.unanswered_questions q
             where q.tenant_id = t.tenant_id and q.request_id = t.request_id
               and q.asked_person_at is not null
           ))::bigint as asked_person,
           count(*) filter (where exists (
             select 1 from public.assistant_turn_actions a
             where a.tenant_id = t.tenant_id and a.request_id = t.request_id
           ))::bigint as with_action
    from turns t
    group by t.channel
  ),
  topics as (
    select c.content_id, count(*)::bigint as times,
           count(*) filter (where t.channel = 'portal')::bigint as portal,
           count(*) filter (where t.channel = 'embed')::bigint as embed,
           count(*) filter (where t.channel = 'qr')::bigint as qr,
           count(*) filter (where t.channel = 'whatsapp')::bigint as whatsapp
    from public.assistant_turn_citations c
    join turns t on t.request_id = c.request_id
    where c.tenant_id = p_tenant_id
    group by c.content_id
    order by times desc, c.content_id
    limit 20
  ),
  actions as (
    select a.action, count(*)::bigint as times, count(distinct a.request_id)::bigint as answers
    from public.assistant_turn_actions a
    join turns t on t.request_id = a.request_id
    where a.tenant_id = p_tenant_id
    group by a.action
  )
  select jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'since', (select min(t.day) from public.assistant_turns t where t.tenant_id = p_tenant_id),
    'channels', coalesce((
      select jsonb_agg(jsonb_build_object(
               'channel', c.channel, 'conversations', c.conversations, 'people', c.people,
               'answered', c.answered, 'abstained', c.abstained, 'plans', c.plans,
               'notices', c.notices, 'askedPerson', c.asked_person, 'withAction', c.with_action
             ) order by c.conversations desc, c.channel)
      from channels c
    ), '[]'::jsonb),
    'topics', coalesce((
      select jsonb_agg(jsonb_build_object(
               'contentId', tp.content_id, 'kind', ci.kind, 'slug', ci.slug,
               'title', coalesce(pub.title, draft.title, ci.slug),
               'published', ci.published_revision_id is not null,
               'times', tp.times,
               'channels', jsonb_build_object('portal', tp.portal, 'embed', tp.embed,
                                              'qr', tp.qr, 'whatsapp', tp.whatsapp)
             ) order by tp.times desc, coalesce(pub.title, draft.title, ci.slug))
      from topics tp
      join public.content_items ci on ci.tenant_id = p_tenant_id and ci.id = tp.content_id
      left join public.content_revisions pub
        on pub.tenant_id = p_tenant_id and pub.id = ci.published_revision_id
      left join public.content_revisions draft
        on draft.tenant_id = p_tenant_id and draft.id = ci.draft_revision_id
    ), '[]'::jsonb),
    'actions', coalesce((
      select jsonb_agg(jsonb_build_object('action', a.action, 'times', a.times, 'answers', a.answers)
                       order by a.times desc, a.action)
      from actions a
    ), '[]'::jsonb)
  );
$$;

revoke all on function private.assistant_statistics(uuid, date, date) from public;

-- For any member (owners and administrators with their second factor, ADR-043): up to 400 days.
create function public.tenant_assistant_statistics(p_tenant_id uuid, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.has_tenant_role(
    p_tenant_id, array['owner', 'admin', 'editor', 'analyst']::public.membership_role[]
  ) then
    raise exception 'not a member of this tenant' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then
    raise exception 'invalid period' using errcode = '22023';
  end if;
  return private.assistant_statistics(p_tenant_id, p_from, p_to);
end;
$$;

revoke all on function public.tenant_assistant_statistics(uuid, date, date) from public, anon, authenticated;
grant execute on function public.tenant_assistant_statistics(uuid, date, date) to authenticated;

-- The monthly report (ADR-055) also reads the assistant of the month and of the month before.
create or replace function worker_api.monthly_report_data(
  p_job_id uuid,
  p_fencing_token bigint,
  p_from date,
  p_to date,
  p_previous_from date,
  p_previous_to date
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.background_jobs;
  v_month date;
begin
  v_job := private.monthly_report_job(p_job_id, p_fencing_token);
  v_month := (v_job.payload ->> 'month')::date;
  if p_from is distinct from v_month or p_to is null or p_to < p_from
     or p_to >= (v_month + interval '1 month')::date
     or (p_previous_from is null) <> (p_previous_to is null)
     or (p_previous_from is not null and (
       p_previous_to < p_previous_from or p_previous_to >= p_from or p_previous_to - p_previous_from > 31
     )) then
    raise exception 'invalid period' using errcode = '22023';
  end if;
  return jsonb_build_object(
    'current', private.visit_statistics(v_job.tenant_id, p_from, p_to, false),
    'previous', case when p_previous_from is null then null
                     else private.visit_statistics(v_job.tenant_id, p_previous_from, p_previous_to, false) end,
    'questions', private.unanswered_questions_between(v_job.tenant_id, p_from, p_to),
    'review', coalesce((select jsonb_agg(to_jsonb(r)) from private.content_review(v_job.tenant_id) r), '[]'::jsonb),
    'snapshot', private.content_snapshot(v_job.tenant_id),
    'activity', private.content_activity(v_job.tenant_id, p_from, p_to),
    'passport', private.passport_statistics(v_job.tenant_id, p_from, p_to, false),
    'passportPrevious', case when p_previous_from is null then null
                             else private.passport_statistics(v_job.tenant_id, p_previous_from, p_previous_to, false) end,
    'assistant', private.assistant_statistics(v_job.tenant_id, p_from, p_to),
    'assistantPrevious', case when p_previous_from is null then null
                              else private.assistant_statistics(v_job.tenant_id, p_previous_from, p_previous_to) end,
    'modules', to_jsonb(private.tenant_module_keys(v_job.tenant_id))
  );
end;
$$;
