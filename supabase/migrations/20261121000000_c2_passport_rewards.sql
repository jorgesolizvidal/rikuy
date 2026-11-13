-- C2 · Paso 3 — the prize of the tourist passport (ADR-058). Expand only.
--
-- A visitor who completed a circuit asks for its prize: the phone sends its stamps and the
-- database checks each signature (ADR-057) against the circuit's published stops. It answers
-- with a voucher with a short code, valid 30 days. The shop that gives the prize opens the
-- portal's «Canjear un premio» page and types the code and the shop's key, which the
-- municipality set for the circuit: the voucher is redeemed once. A passport gets the prize
-- of a circuit once; while a voucher is not redeemed, asking again gives the same one, or a
-- new one after it expired. Every stamp counts; the voucher says how many were located.

-- ── The shop's key ─────────────────────────────────────────────────────────

alter table public.passport_circuits
  add column redeem_pin_hash text,
  add column redeem_pin_set_at timestamptz,
  add constraint passport_circuits_redeem_pin
    check ((redeem_pin_hash is null) = (redeem_pin_set_at is null));

-- «Clave del local» (owners and admins): 4 to 8 digits, kept only as a bcrypt hash. Changing
-- it is how the municipality stops a shop that should no longer redeem.
create function public.set_passport_redeem_pin(p_tenant_id uuid, p_circuit_id uuid, p_pin text)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := now();
begin
  perform private.assert_content_role(p_tenant_id, array['owner', 'admin']::public.membership_role[]);
  if p_pin is null or p_pin !~ '^[0-9]{4,8}$' then
    raise exception 'the key is 4 to 8 digits' using errcode = '22023';
  end if;
  update public.passport_circuits c
  set redeem_pin_hash = extensions.crypt(p_pin, extensions.gen_salt('bf', 8)),
      redeem_pin_set_at = v_now
  where c.tenant_id = p_tenant_id and c.id = p_circuit_id;
  if not found then
    raise exception 'circuit not found' using errcode = 'P0002';
  end if;
  insert into public.audit_events (scope, tenant_id, actor_id, action, entity_type, entity_id, outcome, diff)
  values ('tenant', p_tenant_id, (select auth.uid()), 'passport.redeem_pin_set', 'passport_circuit',
          p_circuit_id, 'success', '{}'::jsonb);
  return v_now;
end;
$$;

revoke all on function public.set_passport_redeem_pin(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.set_passport_redeem_pin(uuid, uuid, text) to authenticated;

-- ── Vouchers ───────────────────────────────────────────────────────────────

create table public.passport_vouchers (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null,
  circuit_id      uuid not null,
  -- sha256 of the municipality and the phone's random passport id: one prize per passport.
  passport_hash   text not null,
  code            text not null,
  stamps_total    integer not null,
  stamps_located  integer not null,
  issued_at       timestamptz not null default now(),
  expires_at      timestamptz not null,
  redeemed_at     timestamptz,

  constraint passport_vouchers_code_key unique (tenant_id, code),
  constraint passport_vouchers_code_format check (code ~ '^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$'),
  constraint passport_vouchers_hash_format check (passport_hash ~ '^[0-9a-f]{64}$'),
  constraint passport_vouchers_stamps check (stamps_total >= 2 and stamps_located between 0 and stamps_total),
  constraint passport_vouchers_expiry check (expires_at > issued_at),
  constraint passport_vouchers_redeemed check (redeemed_at is null or redeemed_at >= issued_at),
  constraint passport_vouchers_circuit_fkey foreign key (tenant_id, circuit_id)
    references public.passport_circuits (tenant_id, id) on delete cascade
);

-- A passport redeems the prize of a circuit once.
create unique index passport_vouchers_one_redeemed
  on public.passport_vouchers (circuit_id, passport_hash) where redeemed_at is not null;
create index passport_vouchers_circuit_idx on public.passport_vouchers (circuit_id, passport_hash);

alter table public.passport_vouchers enable row level security;
revoke all on public.passport_vouchers from public, anon, authenticated, service_role;

-- Failed attempts at «Canjear un premio» per municipality and hour (a wrong code or key).
create table private.passport_redeem_failures (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  hour      timestamptz not null,
  failures  integer not null default 0,
  primary key (tenant_id, hour)
);

revoke all on private.passport_redeem_failures from public, anon, authenticated, service_role;

create function private.passport_hash(p_tenant_id uuid, p_passport text)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(sha256(convert_to(p_tenant_id::text || ':' || p_passport, 'UTF8')), 'hex');
$$;

revoke all on function private.passport_hash(uuid, text) from public;

-- 8 characters without 0, O, 1 or I (40 random bits): read aloud or typed without mistakes.
create function private.new_voucher_code()
returns text
language sql
volatile
set search_path = ''
as $$
  select string_agg(substr('23456789ABCDEFGHJKLMNPQRSTUVWXYZ', get_byte(b, i) % 32 + 1, 1), '' order by i)
  from (select extensions.gen_random_bytes(8) as b) r, generate_series(0, 7) i;
$$;

revoke all on function private.new_voucher_code() from public;

-- What the visitor sees of a voucher.
create function private.voucher_view(p_voucher public.passport_vouchers, p_status text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'status', p_status,
    'code', p_voucher.code,
    'circuit', c.slug,
    'circuitName', c.name,
    'reward', c.reward,
    'stampsTotal', p_voucher.stamps_total,
    'stampsLocated', p_voucher.stamps_located,
    'issuedAt', p_voucher.issued_at,
    'expiresAt', p_voucher.expires_at,
    'redeemedAt', p_voucher.redeemed_at
  )
  from public.passport_circuits c
  where c.id = p_voucher.circuit_id;
$$;

revoke all on function private.voucher_view(public.passport_vouchers, text) from public;

-- «Pedir mi premio» (anonymous). p_stamps: [{placeId, at, located, signature}]. Answers:
--   issued (a new voucher) · active (the one not redeemed yet) · redeemed (this passport
--   already got the prize) · incomplete (missing stops) · no_reward · not_found.
create function public.portal_request_voucher(
  p_tenant_id uuid, p_circuit_slug text, p_passport text, p_stamps jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_circuit public.passport_circuits;
  v_hash text;
  v_total integer;
  v_valid integer;
  v_located integer;
  v_voucher public.passport_vouchers;
  v_code text;
begin
  if p_passport is null or p_passport !~ '^[A-Za-z0-9_-]{22}$'
     or p_stamps is null or jsonb_typeof(p_stamps) <> 'array' or jsonb_array_length(p_stamps) > 60 then
    raise exception 'invalid passport or stamps' using errcode = '22023';
  end if;

  select c.* into v_circuit
  from public.passport_circuits c
  join public.tenants t on t.id = c.tenant_id and t.status = 'active'
  where c.tenant_id = p_tenant_id and c.slug = p_circuit_slug and c.status = 'published';
  if v_circuit.id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_circuit.reward = '' then
    return jsonb_build_object('status', 'no_reward');
  end if;

  -- The stops that count: published destinations, as the portal shows the circuit.
  with stops as (
    select s.content_id
    from public.passport_circuit_stops s
    join public.content_items i on i.tenant_id = s.tenant_id and i.id = s.content_id and i.kind = 'destination'
    join public.content_revisions r on r.id = i.published_revision_id and r.state = 'sealed'
    where s.circuit_id = v_circuit.id
  ),
  stamps as (
    select distinct on (st.content_id) st.content_id, x->'located' = 'true'::jsonb as located
    from stops st
    join jsonb_array_elements(p_stamps) x on x->>'placeId' = st.content_id::text
    where case
            when x->>'at' ~ '^[0-9]{1,12}$' and jsonb_typeof(x->'located') = 'boolean'
              then private.passport_stamp_valid(p_tenant_id, st.content_id, p_passport, (x->>'at')::bigint,
                                                x->'located' = 'true'::jsonb, x->>'signature')
            else false
          end
    order by st.content_id, x->'located' = 'true'::jsonb desc
  )
  select (select count(*) from stops), count(*), count(*) filter (where located)
  into v_total, v_valid, v_located
  from stamps;

  if v_total < 2 then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_valid < v_total then
    return jsonb_build_object('status', 'incomplete', 'missing', v_total - v_valid);
  end if;

  v_hash := private.passport_hash(p_tenant_id, p_passport);
  -- Two requests of the same phone at once get one voucher.
  perform pg_advisory_xact_lock(hashtextextended(v_circuit.id::text || v_hash, 0));

  select * into v_voucher from public.passport_vouchers v
  where v.circuit_id = v_circuit.id and v.passport_hash = v_hash and v.redeemed_at is not null;
  if v_voucher.id is not null then
    return private.voucher_view(v_voucher, 'redeemed');
  end if;

  select * into v_voucher from public.passport_vouchers v
  where v.circuit_id = v_circuit.id and v.passport_hash = v_hash and v.expires_at > now()
  order by v.issued_at desc limit 1;
  if v_voucher.id is not null then
    return private.voucher_view(v_voucher, 'active');
  end if;

  loop
    v_code := private.new_voucher_code();
    begin
      insert into public.passport_vouchers
        (tenant_id, circuit_id, passport_hash, code, stamps_total, stamps_located, expires_at)
      values (p_tenant_id, v_circuit.id, v_hash, v_code, v_total, v_located, now() + interval '30 days')
      returning * into v_voucher;
      exit;
    exception when unique_violation then
      -- Another voucher of the municipality has this code: draw again.
    end;
  end loop;
  return private.voucher_view(v_voucher, 'issued');
end;
$$;

revoke all on function public.portal_request_voucher(uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.portal_request_voucher(uuid, text, text, jsonb) to anon, authenticated;

-- «Canjear un premio» (anonymous: the shop has no account). With the code and the circuit's
-- key: p_redeem false only checks it; true marks it redeemed, once. Answers:
--   valid · redeemed (just now) · already_redeemed · expired · wrong (code or key) · no_pin ·
--   too_many (more than 30 failures this hour in the municipality).
create function public.portal_redeem_voucher(p_tenant_id uuid, p_code text, p_pin text, p_redeem boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_code text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  v_hour timestamptz := date_trunc('hour', now());
  v_failures integer;
  v_voucher public.passport_vouchers;
  v_circuit public.passport_circuits;
begin
  if not exists (select 1 from public.tenants t where t.id = p_tenant_id and t.status = 'active') then
    return jsonb_build_object('status', 'wrong');
  end if;
  select f.failures into v_failures from private.passport_redeem_failures f
  where f.tenant_id = p_tenant_id and f.hour = v_hour;
  if coalesce(v_failures, 0) >= 30 then
    return jsonb_build_object('status', 'too_many');
  end if;

  select v.* into v_voucher from public.passport_vouchers v
  where v.tenant_id = p_tenant_id and v.code = v_code
  for update;
  if v_voucher.id is not null then
    select c.* into v_circuit from public.passport_circuits c where c.id = v_voucher.circuit_id;
  end if;

  if v_voucher.id is not null and v_circuit.redeem_pin_hash is null then
    return jsonb_build_object('status', 'no_pin', 'circuitName', v_circuit.name);
  end if;
  if v_voucher.id is null or p_pin is null or p_pin !~ '^[0-9]{4,8}$'
     or extensions.crypt(p_pin, v_circuit.redeem_pin_hash) <> v_circuit.redeem_pin_hash then
    insert into private.passport_redeem_failures (tenant_id, hour, failures)
    values (p_tenant_id, v_hour, 1)
    on conflict (tenant_id, hour) do update set failures = private.passport_redeem_failures.failures + 1;
    return jsonb_build_object('status', 'wrong');
  end if;

  if v_voucher.redeemed_at is not null then
    return private.voucher_view(v_voucher, 'already_redeemed');
  end if;
  if v_voucher.expires_at <= now() then
    return private.voucher_view(v_voucher, 'expired');
  end if;
  if not coalesce(p_redeem, false) then
    return private.voucher_view(v_voucher, 'valid');
  end if;

  update public.passport_vouchers v set redeemed_at = now()
  where v.id = v_voucher.id
  returning * into v_voucher;
  insert into public.audit_events (scope, tenant_id, actor_id, action, entity_type, entity_id, outcome, diff)
  values ('tenant', p_tenant_id, null, 'passport.voucher_redeemed', 'passport_circuit', v_voucher.circuit_id,
          'success', jsonb_build_object('voucher', v_voucher.id));
  return private.voucher_view(v_voucher, 'redeemed');
end;
$$;

revoke all on function public.portal_redeem_voucher(uuid, text, text, boolean) from public, anon, authenticated;
grant execute on function public.portal_redeem_voucher(uuid, text, text, boolean) to anon, authenticated;

-- The panel: whether each circuit has its shop's key (any member; never the key).
create function public.tenant_passport_rewards(p_tenant_id uuid)
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
  return coalesce((
    select jsonb_agg(jsonb_build_object('circuitId', c.id, 'pinSetAt', c.redeem_pin_set_at) order by c.name)
    from public.passport_circuits c
    where c.tenant_id = p_tenant_id
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.tenant_passport_rewards(uuid) from public, anon, authenticated;
grant execute on function public.tenant_passport_rewards(uuid) to authenticated;

-- Vouchers are kept 400 days (the longest period of «Estadísticas», Paso 4); failures, 2 days.
create function private.forget_passport_vouchers()
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.passport_vouchers v where v.issued_at < now() - interval '400 days';
  delete from private.passport_redeem_failures f where f.hour < now() - interval '2 days';
$$;

revoke all on function private.forget_passport_vouchers() from public;

select cron.schedule('rikuy-forget-passport-vouchers', '47 8 * * *', 'select private.forget_passport_vouchers()');
