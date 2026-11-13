-- C2 · Paso 2 — stamps of the tourist passport (ADR-057). Expand only.
--
-- Every destination that is a stop of a circuit has a stamp code: a random, unguessable value
-- printed as a QR at the place (`/sello/{code}` on the portal). Owners and admins renew it
-- (the printed one stops stamping) when it is shared where it should not be.
--
-- Scanning it gives the visitor's phone a stamp signed by the server (HMAC-SHA256 with a
-- per-municipality key that only these functions read): the place, when, a random passport
-- id the phone made up, and whether the phone said it was within the place's radius. The
-- phone keeps its stamps; the server keeps none of it (ADR-021: the position never leaves
-- the device; only «near: yes or no» does). In Paso 3, the prize checks the signatures.

create extension if not exists pgcrypto with schema extensions;

-- 22 characters of base64url: 128 random bits.
create function private.new_stamp_code()
returns text
language sql
volatile
set search_path = ''
as $$
  select rtrim(translate(encode(extensions.gen_random_bytes(16), 'base64'), '+/', '-_'), '=');
$$;

revoke all on function private.new_stamp_code() from public;

create table public.passport_stamp_codes (
  tenant_id  uuid not null,
  content_id uuid not null,
  code       text not null,
  version    integer not null default 1,
  created_at timestamptz not null default now(),
  renewed_at timestamptz,
  renewed_by uuid,

  primary key (tenant_id, content_id),
  constraint passport_stamp_codes_code_key unique (code),
  constraint passport_stamp_codes_code_format check (code ~ '^[A-Za-z0-9_-]{22}$'),
  constraint passport_stamp_codes_version check (version >= 1),
  constraint passport_stamp_codes_renewed check ((version > 1) = (renewed_at is not null)),
  constraint passport_stamp_codes_content_fkey foreign key (tenant_id, content_id)
    references public.content_items (tenant_id, id) on delete cascade
);

alter table public.passport_stamp_codes enable row level security;
revoke all on public.passport_stamp_codes from public, anon, authenticated, service_role;

-- The signing key of each municipality: 32 random bytes, read only by the functions below.
create table private.passport_keys (
  tenant_id  uuid primary key references public.tenants (id) on delete cascade,
  secret     bytea not null,
  created_at timestamptz not null default now(),
  constraint passport_keys_secret check (octet_length(secret) = 32)
);

revoke all on private.passport_keys from public, anon, authenticated, service_role;

-- A destination gets its code the first time it becomes a stop, and keeps it: taking it out
-- of a circuit and back does not change what is printed.
create function private.passport_stop_code()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.passport_stamp_codes (tenant_id, content_id, code)
  values (new.tenant_id, new.content_id, private.new_stamp_code())
  on conflict (tenant_id, content_id) do nothing;
  return new;
end;
$$;

revoke all on function private.passport_stop_code() from public;

create trigger passport_circuit_stops_code
  after insert or update of content_id on public.passport_circuit_stops
  for each row execute function private.passport_stop_code();

-- The stops that already exist.
insert into public.passport_stamp_codes (tenant_id, content_id, code)
select distinct on (s.tenant_id, s.content_id) s.tenant_id, s.content_id, private.new_stamp_code()
from public.passport_circuit_stops s
on conflict (tenant_id, content_id) do nothing;

-- ── Signatures ─────────────────────────────────────────────────────────────

-- The municipality's key, created the first time it signs.
create function private.passport_key(p_tenant_id uuid)
returns bytea
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_secret bytea;
begin
  insert into private.passport_keys (tenant_id, secret)
  values (p_tenant_id, extensions.gen_random_bytes(32))
  on conflict (tenant_id) do nothing;
  select k.secret into v_secret from private.passport_keys k where k.tenant_id = p_tenant_id;
  return v_secret;
end;
$$;

revoke all on function private.passport_key(uuid) from public;

-- base64url(HMAC-SHA256(key, "v1:{tenant}:{place}:{passport}:{at}:{near 1|0}")); null without a key.
create function private.passport_stamp_signature(
  p_tenant_id uuid, p_content_id uuid, p_passport text, p_at bigint, p_located boolean
)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select rtrim(translate(encode(extensions.hmac(
           convert_to(format('v1:%s:%s:%s:%s:%s', p_tenant_id, p_content_id, p_passport, p_at,
                             case when p_located then '1' else '0' end), 'UTF8'),
           k.secret, 'sha256'), 'base64'), '+/', '-_'), '=')
  from private.passport_keys k
  where k.tenant_id = p_tenant_id;
$$;

revoke all on function private.passport_stamp_signature(uuid, uuid, text, bigint, boolean) from public;

-- Whether a stamp kept by a phone is one this municipality signed (the prize, Paso 3).
create function private.passport_stamp_valid(
  p_tenant_id uuid, p_content_id uuid, p_passport text, p_at bigint, p_located boolean, p_signature text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    p_signature is not null
    and p_signature = private.passport_stamp_signature(p_tenant_id, p_content_id, p_passport, p_at, p_located),
    false);
$$;

revoke all on function private.passport_stamp_valid(uuid, uuid, text, bigint, boolean, text) from public;

-- ── The panel ──────────────────────────────────────────────────────────────

-- The stamp code of every destination that is a stop of a circuit, with the circuits that
-- use it. The codes are what gets printed: owners, admins and editors (not analysts).
create function public.tenant_passport_stamp_codes(p_tenant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.has_tenant_role(
    p_tenant_id, array['owner', 'admin', 'editor']::public.membership_role[]
  ) then
    raise exception 'not allowed to see the stamp codes' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'contentId', k.content_id,
             'slug', i.slug,
             'title', coalesce(pub.title, draft.title),
             'published', pub.id is not null,
             'code', k.code,
             'version', k.version,
             'createdAt', k.created_at,
             'renewedAt', k.renewed_at,
             'circuits', (
               select jsonb_agg(jsonb_build_object('name', c.name, 'status', c.status) order by c.name)
               from public.passport_circuit_stops s
               join public.passport_circuits c on c.id = s.circuit_id
               where s.tenant_id = k.tenant_id and s.content_id = k.content_id
             )
           ) order by coalesce(pub.title, draft.title))
    from public.passport_stamp_codes k
    join public.content_items i on i.tenant_id = k.tenant_id and i.id = k.content_id
    left join public.content_revisions pub on pub.id = i.published_revision_id
    left join public.content_revisions draft on draft.id = i.draft_revision_id
    where k.tenant_id = p_tenant_id
      and exists (
        select 1 from public.passport_circuit_stops s
        where s.tenant_id = k.tenant_id and s.content_id = k.content_id
      )
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.tenant_passport_stamp_codes(uuid) from public, anon, authenticated;
grant execute on function public.tenant_passport_stamp_codes(uuid) to authenticated;

-- «Renovar el QR» (owners and admins), with the version the person saw: a new code; the
-- printed one stops stamping. Stamps already on phones stay valid.
create function public.renew_passport_stamp_code(p_tenant_id uuid, p_content_id uuid, p_version integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code public.passport_stamp_codes;
begin
  perform private.assert_content_role(p_tenant_id, array['owner', 'admin']::public.membership_role[]);
  select * into v_code from public.passport_stamp_codes k
  where k.tenant_id = p_tenant_id and k.content_id = p_content_id
  for update;
  if v_code.content_id is null then
    raise exception 'stamp code not found' using errcode = 'P0002';
  end if;
  if v_code.version is distinct from p_version then
    raise exception 'the stamp code changed' using errcode = 'PT409', hint = 'stale';
  end if;
  update public.passport_stamp_codes k
  set code = private.new_stamp_code(), version = k.version + 1, renewed_at = now(), renewed_by = (select auth.uid())
  where k.tenant_id = p_tenant_id and k.content_id = p_content_id;
  insert into public.audit_events (scope, tenant_id, actor_id, action, entity_type, entity_id, revision, outcome, diff)
  values ('tenant', p_tenant_id, (select auth.uid()), 'passport.stamp_code_renewed', 'content', p_content_id,
          v_code.version + 1, 'success', '{}'::jsonb);
  return v_code.version + 1;
end;
$$;

revoke all on function public.renew_passport_stamp_code(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.renew_passport_stamp_code(uuid, uuid, integer) to authenticated;

-- ── The portal ─────────────────────────────────────────────────────────────

-- The place of a current code: a published destination of an online municipality that is a
-- stop of a published circuit. Anything else (renewed, unpublished, another municipality's
-- code) is no place.
create function private.passport_stamp_place(p_tenant_id uuid, p_code text)
returns table (content_id uuid, slug text, title text, summary text, latitude double precision,
               longitude double precision, revision_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select i.id, i.slug, r.title, r.summary, r.latitude, r.longitude, r.id
  from public.passport_stamp_codes k
  join public.tenants t on t.id = k.tenant_id and t.status = 'active'
  join public.content_items i on i.tenant_id = k.tenant_id and i.id = k.content_id and i.kind = 'destination'
  join public.content_revisions r on r.id = i.published_revision_id and r.content_id = i.id and r.state = 'sealed'
  where k.tenant_id = p_tenant_id
    and k.code = p_code
    and exists (
      select 1 from public.passport_circuit_stops s
      join public.passport_circuits c on c.id = s.circuit_id and c.status = 'published'
      where s.tenant_id = k.tenant_id and s.content_id = k.content_id
    );
$$;

revoke all on function private.passport_stamp_place(uuid, text) from public;

-- What the stamp page shows before stamping (anonymous); null for no place.
create function public.portal_stamp_place(p_tenant_id uuid, p_code text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
           'id', p.content_id,
           'slug', p.slug,
           'title', p.title,
           'summary', p.summary,
           'latitude', p.latitude,
           'longitude', p.longitude,
           'cover', (select private.public_image(m.asset_version_id, m.alt_text)
                     from public.media_references m
                     where m.revision_id = p.revision_id and m.purpose = 'cover')
         )
  from private.passport_stamp_place(p_tenant_id, p_code) p;
$$;

revoke all on function public.portal_stamp_place(uuid, text) from public, anon, authenticated;
grant execute on function public.portal_stamp_place(uuid, text) to anon, authenticated;

-- A stamp for the visitor's phone (anonymous): the place, now, the passport id the phone made
-- up and «near» as the phone measured it, signed. Nothing of it is stored. Null for no place.
create function public.portal_collect_stamp(p_tenant_id uuid, p_code text, p_passport text, p_located boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_place record;
  v_at bigint := floor(extract(epoch from now()))::bigint;
begin
  if p_passport is null or p_passport !~ '^[A-Za-z0-9_-]{22}$' or p_located is null then
    raise exception 'invalid passport or location' using errcode = '22023';
  end if;
  select * into v_place from private.passport_stamp_place(p_tenant_id, p_code);
  if v_place.content_id is null then
    return null;
  end if;
  perform private.passport_key(p_tenant_id);
  return jsonb_build_object(
    'id', v_place.content_id,
    'slug', v_place.slug,
    'title', v_place.title,
    'at', v_at,
    'located', p_located,
    'signature', private.passport_stamp_signature(p_tenant_id, v_place.content_id, p_passport, v_at, p_located)
  );
end;
$$;

revoke all on function public.portal_collect_stamp(uuid, text, text, boolean) from public, anon, authenticated;
grant execute on function public.portal_collect_stamp(uuid, text, text, boolean) to anon, authenticated;

-- The published circuits now also say which place each stop is (the phone keeps its stamps by
-- place, which survives a change of address, ADR-047). Otherwise as in 20261119000000.
create or replace function public.portal_passport(p_tenant_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with stops as (
    select s.circuit_id, s.position, s.content_id, i.slug, r.title, r.summary, r.latitude, r.longitude,
           (select private.public_image(m.asset_version_id, m.alt_text)
            from public.media_references m
            where m.revision_id = r.id and m.purpose = 'cover') as cover
    from public.passport_circuit_stops s
    join public.content_items i on i.tenant_id = s.tenant_id and i.id = s.content_id and i.kind = 'destination'
    join public.content_revisions r on r.id = i.published_revision_id and r.content_id = i.id and r.state = 'sealed'
    where s.tenant_id = p_tenant_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'slug', c.slug,
           'name', c.name,
           'summary', c.summary,
           'reward', c.reward,
           'publishedAt', c.published_at,
           'stops', (
             select jsonb_agg(jsonb_build_object(
                      'id', st.content_id,
                      'slug', st.slug,
                      'title', st.title,
                      'summary', st.summary,
                      'latitude', st.latitude,
                      'longitude', st.longitude,
                      'cover', st.cover
                    ) order by st.position)
             from stops st where st.circuit_id = c.id
           )
         ) order by c.published_at, c.name), '[]'::jsonb)
  from public.passport_circuits c
  join public.tenants t on t.id = c.tenant_id and t.status = 'active'
  where c.tenant_id = p_tenant_id
    and c.status = 'published'
    and (select count(*) from stops st where st.circuit_id = c.id) >= 2;
$$;
