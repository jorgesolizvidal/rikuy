-- P5 · Paso 3 — the visitor's assistant in the portal (ADR-038). Expand only.
--
-- The assistant's persona is part of the white-label presentation (ADR-022):
--   "assistant": { "name": 1..40, "greeting": 0..240, "tone": "warm" | "formal" }
-- Absent: the portal uses a neutral name and a greeting built from the site's name. The
-- conversation itself is never stored here (it lives on the visitor's device, ADR-022);
-- the gateway's ai_requests keep only usage and latency (ADR-036).

-- Presentation contract: + optional assistant (mirror of tenantPresentationSchema).
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
  if not private.has_exact_keys(p, array['identity', 'theme', 'contact', 'social', 'seo'], array['logo', 'visitors', 'assistant']) then
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

  -- identity
  if not (
    private.has_exact_keys(p -> 'identity', array['siteName', 'shortName', 'tagline'])
    and private.is_plain_line(p #> '{identity,siteName}', 1, 60)
    and private.is_plain_line(p #> '{identity,shortName}', 1, 12)
    and private.is_plain_line(p #> '{identity,tagline}', 0, 140)
  ) then
    return false;
  end if;

  -- theme: colors are lowercase #rrggbb, so they are safe inside CSS
  if not (
    private.has_exact_keys(p -> 'theme', array['mode', 'brand', 'accent'])
    and coalesce(p #>> '{theme,mode}' in ('light', 'dark'), false)
    and coalesce((p #>> '{theme,brand}') ~ '^#[0-9a-f]{6}$', false)
    and coalesce((p #>> '{theme,accent}') ~ '^#[0-9a-f]{6}$', false)
    and jsonb_typeof(p #> '{theme,brand}') = 'string'
    and jsonb_typeof(p #> '{theme,accent}') = 'string'
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

-- Knowledge search (ADR-037), better ordered for the assistant (ADR-038): each word of the
-- question counts by how rare it is among the municipality's visible fragments, so a
-- specific word («wifi», «cajero») beats a common one («lugar», «hay»). Same signature,
-- same visibility rules: only what is published now.
create or replace function private.search_knowledge(p_tenant_id uuid, p_query text, p_limit integer)
returns table (
  chunk_id        uuid,
  source          text,
  source_id       uuid,
  source_version  integer,
  kind            public.content_kind,
  slug            text,
  title           text,
  heading         text,
  body            text,
  page_from       integer,
  page_to         integer,
  scene_id        uuid,
  hotspot_id      uuid,
  ended           boolean,
  score           real
)
language sql
stable
security definer
set search_path = ''
as $$
  with terms as (
    select t.terms,
           array_to_string(array(select quote_literal(x) from unnest(t.terms) x), ' | ')::tsquery as q
    from (select private.knowledge_terms(p_query) as terms) t
    where cardinality(t.terms) > 0
  ),
  visible as materialized (
    select c.id, 'content'::text as source, i.id as source_id, r.revision_no, i.kind, i.slug,
           c.title, c.heading, c.body, c.page_from, c.page_to, c.scene_id, c.hotspot_id,
           i.kind = 'event' and coalesce(private.event_ends_at(r.ends_local, r.all_day, tn.timezone) <= now(), false) as ended,
           c.search
    from public.knowledge_chunks c
    join public.content_items i
      on i.tenant_id = c.tenant_id and i.id = c.content_id and i.published_revision_id = c.content_revision_id
    join public.content_revisions r on r.id = c.content_revision_id
    join public.tenants tn on tn.id = c.tenant_id
    where c.tenant_id = p_tenant_id
    union all
    select c.id, 'tour'::text, t.id, tr.revision_no, i.kind, i.slug,
           c.title, c.heading, c.body, c.page_from, c.page_to, c.scene_id, c.hotspot_id,
           i.kind = 'event' and coalesce(private.event_ends_at(cr.ends_local, cr.all_day, tn.timezone) <= now(), false),
           c.search
    from public.knowledge_chunks c
    join public.tours t
      on t.tenant_id = c.tenant_id and t.id = c.tour_id and t.published_revision_id = c.tour_revision_id
    join public.tour_revisions tr on tr.id = c.tour_revision_id
    join public.content_items i on i.tenant_id = t.tenant_id and i.id = t.content_id
    join public.content_revisions cr on cr.id = i.published_revision_id and cr.state = 'sealed'
    join public.tenants tn on tn.id = c.tenant_id
    where c.tenant_id = p_tenant_id
  ),
  -- How rare each word is among what is visible now (BM25's idf): «wifi» weighs more than
  -- «lugar», which half the fragments have.
  weights as (
    select x.term,
           ln(1 + ((select count(*) from visible)::real - count(v.id) + 0.5) / (count(v.id) + 0.5))::real as idf
    from terms
    cross join unnest(terms.terms) as x(term)
    left join visible v on v.search @@ quote_literal(x.term)::tsquery
    group by x.term
  )
  select v.id, v.source, v.source_id, v.revision_no, v.kind, v.slug, v.title, v.heading, v.body,
         v.page_from, v.page_to, v.scene_id, v.hotspot_id, v.ended,
         (
           -- The question's words the fragment has, each by how rare it is; then how densely.
           (select coalesce(sum(w.idf), 0) from weights w where v.search @@ quote_literal(w.term)::tsquery)::real
           + ts_rank_cd(v.search, terms.q, 32)
         ) as score
  from visible v
  cross join terms
  where v.search @@ terms.q
  order by score desc, v.id
  limit greatest(1, least(coalesce(p_limit, 8), 20));
$$;

revoke all on function private.search_knowledge(uuid, text, integer) from public;
