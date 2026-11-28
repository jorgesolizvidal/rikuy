-- A · Paso 6 (ADR-075): the municipality's assistant on WhatsApp.
--
-- A WhatsApp Business number (Meta's «phone number ID») belongs to one municipality: only a
-- platform operator registers it. Meta signs every message it relays; the webhook resolves the
-- municipality from the number the message was sent to, here, never from anything the sender
-- says. Each message is answered once (Meta retries), and the conversation keeps its last six
-- messages for 24 hours, by a keyed hash of the sender's number: the number itself is never
-- stored. Only expand: new tables and functions.

-- ── The numbers ─────────────────────────────────────────────────────────────

create table public.whatsapp_numbers (
  phone_number_id text primary key,
  tenant_id       uuid not null references public.tenants (id) on delete cascade,
  -- How visitors see it («+591 67 680 091»), for the panel and a wa.me link; optional.
  display_phone   text,
  created_at      timestamptz not null default now(),
  created_by      uuid references auth.users (id) on delete set null,
  constraint whatsapp_numbers_id check (phone_number_id ~ '^[0-9]{5,30}$'),
  constraint whatsapp_numbers_display check (
    display_phone is null or display_phone ~ '^\+[0-9][0-9 ]{6,24}$'
  )
);

create index whatsapp_numbers_tenant on public.whatsapp_numbers (tenant_id);

comment on table public.whatsapp_numbers is
  'WhatsApp Business numbers of each municipality''s assistant (ADR-075); only platform functions write it.';

alter table public.whatsapp_numbers enable row level security;
revoke all on public.whatsapp_numbers from public, anon, authenticated;

create function private.tenant_whatsapp_numbers(p_tenant_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'phoneNumberId', n.phone_number_id,
        'displayPhone', n.display_phone,
        'createdAt', n.created_at
      )
      order by n.created_at, n.phone_number_id
    ),
    '[]'::jsonb
  )
  from public.whatsapp_numbers n
  where n.tenant_id = p_tenant_id;
$$;

revoke all on function private.tenant_whatsapp_numbers(uuid) from public;

create function public.platform_whatsapp_numbers(p_tenant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.assert_platform_actor();
  return private.tenant_whatsapp_numbers(p_tenant_id);
end;
$$;

revoke all on function public.platform_whatsapp_numbers(uuid) from public, anon, authenticated;
grant execute on function public.platform_whatsapp_numbers(uuid) to authenticated;

create function public.platform_add_whatsapp_number(
  p_tenant_id       uuid,
  p_phone_number_id text,
  p_display_phone   text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_display text := nullif(btrim(coalesce(p_display_phone, '')), '');
  v_owner uuid;
begin
  perform private.assert_platform_actor();
  -- Locks the municipality: two operators adding at once count one after the other.
  perform 1 from public.tenants t where t.id = p_tenant_id for update;
  if not found then
    raise exception 'tenant not found' using errcode = 'PT404', hint = 'tenant';
  end if;
  if p_phone_number_id is null or p_phone_number_id !~ '^[0-9]{5,30}$' then
    raise exception 'invalid phone number id' using errcode = '23514', hint = 'phone_number_id';
  end if;
  if v_display is not null and v_display !~ '^\+[0-9][0-9 ]{6,24}$' then
    raise exception 'invalid display phone' using errcode = '23514', hint = 'display_phone';
  end if;

  select n.tenant_id into v_owner
  from public.whatsapp_numbers n
  where n.phone_number_id = p_phone_number_id;
  if v_owner is not null and v_owner <> p_tenant_id then
    raise exception 'number of another municipality' using errcode = 'PT409', hint = 'taken';
  end if;
  if v_owner is null
     and (select count(*) from public.whatsapp_numbers n where n.tenant_id = p_tenant_id) >= 3
  then
    raise exception 'too many numbers' using errcode = 'PT409', hint = 'too_many';
  end if;

  insert into public.whatsapp_numbers (phone_number_id, tenant_id, display_phone, created_by)
  values (p_phone_number_id, p_tenant_id, v_display, (select auth.uid()))
  on conflict (phone_number_id) do update set display_phone = excluded.display_phone;

  insert into public.audit_events (
    scope, tenant_id, actor_id, action, entity_type, entity_id, outcome, diff
  )
  values (
    'tenant', p_tenant_id, (select auth.uid()), 'platform.whatsapp_number_added', 'tenant',
    p_tenant_id, 'success',
    jsonb_build_object('phoneNumberId', p_phone_number_id, 'displayPhone', v_display)
  );
  return private.tenant_whatsapp_numbers(p_tenant_id);
end;
$$;

revoke all on function public.platform_add_whatsapp_number(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.platform_add_whatsapp_number(uuid, text, text) to authenticated;

create function public.platform_remove_whatsapp_number(p_tenant_id uuid, p_phone_number_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_removed integer;
begin
  perform private.assert_platform_actor();
  perform 1 from public.tenants t where t.id = p_tenant_id for update;
  if not found then
    raise exception 'tenant not found' using errcode = 'PT404', hint = 'tenant';
  end if;

  delete from public.whatsapp_numbers n
  where n.tenant_id = p_tenant_id and n.phone_number_id = p_phone_number_id;
  get diagnostics v_removed = row_count;

  if v_removed > 0 then
    insert into public.audit_events (
      scope, tenant_id, actor_id, action, entity_type, entity_id, outcome, diff
    )
    values (
      'tenant', p_tenant_id, (select auth.uid()), 'platform.whatsapp_number_removed', 'tenant',
      p_tenant_id, 'success', jsonb_build_object('phoneNumberId', p_phone_number_id)
    );
  end if;
  return private.tenant_whatsapp_numbers(p_tenant_id);
end;
$$;

revoke all on function public.platform_remove_whatsapp_number(uuid, text)
  from public, anon, authenticated;
grant execute on function public.platform_remove_whatsapp_number(uuid, text) to authenticated;

-- Any member sees the assistant's numbers (the panel shows them with a wa.me link).
create function public.tenant_whatsapp_numbers(p_tenant_id uuid)
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
  return private.tenant_whatsapp_numbers(p_tenant_id);
end;
$$;

revoke all on function public.tenant_whatsapp_numbers(uuid) from public, anon, authenticated;
grant execute on function public.tenant_whatsapp_numbers(uuid) to authenticated;

-- ── Contacts, messages already answered and the conversation ───────────────

-- One secret for the keyed hash of a sender's number; only these functions read it.
create table private.whatsapp_secret (
  id     boolean primary key default true,
  secret bytea not null default extensions.gen_random_bytes(32),
  constraint whatsapp_secret_one check (id)
);

insert into private.whatsapp_secret default values;
revoke all on private.whatsapp_secret from public;

-- The sender of this municipality, as a hex HMAC-SHA256 of its number: stable while the
-- conversation lasts, never the number, and different in every municipality.
create function private.whatsapp_contact_key(p_tenant_id uuid, p_wa_id text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select encode(
    extensions.hmac(
      convert_to(p_tenant_id::text || ':' || p_wa_id, 'UTF8'),
      (select s.secret from private.whatsapp_secret s where s.id),
      'sha256'
    ),
    'hex'
  );
$$;

revoke all on function private.whatsapp_contact_key(uuid, text) from public;

-- A message Meta relayed, once: Meta retries a webhook it thinks failed.
create table public.whatsapp_inbound (
  message_id  text primary key,
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  received_at timestamptz not null default now(),
  constraint whatsapp_inbound_message_id check (char_length(message_id) between 1 and 200)
);

create index whatsapp_inbound_tenant_received on public.whatsapp_inbound (tenant_id, received_at);

alter table public.whatsapp_inbound enable row level security;
revoke all on public.whatsapp_inbound from public, anon, authenticated;

-- The last messages of each conversation (masked), for follow-up questions; 24 hours.
create table public.whatsapp_messages (
  id          bigint generated always as identity primary key,
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  contact_key text not null,
  role        text not null,
  body        text not null,
  created_at  timestamptz not null default now(),
  constraint whatsapp_messages_contact check (contact_key ~ '^[0-9a-f]{64}$'),
  constraint whatsapp_messages_role check (role in ('user', 'assistant')),
  constraint whatsapp_messages_body check (char_length(body) between 1 and 1000)
);

create index whatsapp_messages_contact on public.whatsapp_messages (tenant_id, contact_key, id);
create index whatsapp_messages_created on public.whatsapp_messages (created_at);

comment on table public.whatsapp_messages is
  'The last six messages of each WhatsApp conversation, masked, for 24 hours (ADR-075).';

alter table public.whatsapp_messages enable row level security;
revoke all on public.whatsapp_messages from public, anon, authenticated;

-- ── The webhook (only the AI role) ──────────────────────────────────────────

-- A message to a registered number: the municipality it belongs to and its portal's host,
-- the sender's key and the conversation so far. «duplicate» for a message already taken;
-- «unknown_number» for a number no municipality has; «unavailable» for a municipality that is
-- not online or has no host; «capped» past 5.000 messages in a day for one municipality.
create function ai_api.whatsapp_begin(
  p_phone_number_id text,
  p_message_id      text,
  p_wa_id           text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant uuid;
  v_host text;
  v_key text;
  v_taken integer;
begin
  if p_phone_number_id is null or p_phone_number_id !~ '^[0-9]{5,30}$'
     or p_message_id is null or char_length(p_message_id) not between 1 and 200
     or p_wa_id is null or p_wa_id !~ '^[0-9]{5,20}$'
  then
    raise exception 'invalid message' using errcode = '22023';
  end if;

  select n.tenant_id into v_tenant
  from public.whatsapp_numbers n
  where n.phone_number_id = p_phone_number_id;
  if v_tenant is null then
    return jsonb_build_object('status', 'unknown_number');
  end if;

  select d.hostname into v_host
  from public.tenants t
  join public.tenant_domains d on d.id = t.canonical_domain_id and d.status = 'active'
  where t.id = v_tenant and t.status = 'active';
  if v_host is null then
    return jsonb_build_object('status', 'unavailable');
  end if;

  if (
    select count(*) from public.whatsapp_inbound i
    where i.tenant_id = v_tenant and i.received_at > now() - interval '1 day'
  ) >= 5000 then
    return jsonb_build_object('status', 'capped');
  end if;

  insert into public.whatsapp_inbound (message_id, tenant_id)
  values (p_message_id, v_tenant)
  on conflict (message_id) do nothing;
  get diagnostics v_taken = row_count;
  if v_taken = 0 then
    return jsonb_build_object('status', 'duplicate');
  end if;

  v_key := private.whatsapp_contact_key(v_tenant, p_wa_id);
  return jsonb_build_object(
    'status', 'new',
    'tenantId', v_tenant,
    'host', v_host,
    'contactKey', v_key,
    'history', coalesce((
      select jsonb_agg(jsonb_build_object('role', h.role, 'text', h.body) order by h.id)
      from (
        select m.id, m.role, m.body
        from public.whatsapp_messages m
        where m.tenant_id = v_tenant and m.contact_key = v_key
          and m.created_at > now() - interval '24 hours'
        order by m.id desc
        limit 6
      ) h
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function ai_api.whatsapp_begin(text, text, text) from public;
grant execute on function ai_api.whatsapp_begin(text, text, text) to rikuy_ai;

-- The question and its answer, masked again here, cut to 1.000 characters; the conversation
-- keeps its last six messages.
create function ai_api.whatsapp_remember(
  p_tenant_id   uuid,
  p_contact_key text,
  p_question    text,
  p_answer      text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_question text := left(btrim(private.mask_question_text(coalesce(p_question, ''))), 1000);
  v_answer text := left(btrim(private.mask_question_text(coalesce(p_answer, ''))), 1000);
begin
  if p_contact_key is null or p_contact_key !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid contact' using errcode = '22023';
  end if;
  if not exists (select 1 from public.tenants t where t.id = p_tenant_id) then
    return;
  end if;
  if v_question <> '' then
    insert into public.whatsapp_messages (tenant_id, contact_key, role, body)
    values (p_tenant_id, p_contact_key, 'user', v_question);
  end if;
  if v_answer <> '' then
    insert into public.whatsapp_messages (tenant_id, contact_key, role, body)
    values (p_tenant_id, p_contact_key, 'assistant', v_answer);
  end if;
  delete from public.whatsapp_messages m
  where m.tenant_id = p_tenant_id and m.contact_key = p_contact_key
    and m.id not in (
      select k.id from public.whatsapp_messages k
      where k.tenant_id = p_tenant_id and k.contact_key = p_contact_key
      order by k.id desc
      limit 6
    );
end;
$$;

revoke all on function ai_api.whatsapp_remember(uuid, text, text, text) from public;
grant execute on function ai_api.whatsapp_remember(uuid, text, text, text) to rikuy_ai;

-- ── Forgetting ──────────────────────────────────────────────────────────────

create function private.forget_whatsapp()
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.whatsapp_messages m where m.created_at < now() - interval '24 hours';
  delete from public.whatsapp_inbound i where i.received_at < now() - interval '2 days';
$$;

revoke all on function private.forget_whatsapp() from public;

select cron.schedule(
  'rikuy-forget-whatsapp', '23 * * * *',
  $$select private.forget_whatsapp()$$
);
