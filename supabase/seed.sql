-- Local development seed. Synthetic data only: fictional municipalities and example.test
-- users. No real people, credentials or media. Runs on `pnpm db:start` / `pnpm db:reset`.
--
-- Portals:  http://demo-norte.localhost:3000 · http://demo-sur.localhost:3000
-- Admin:    http://app.localhost:3000  — sign in with one of the emails below; the code
--           arrives in Mailpit (http://127.0.0.1:54324). Users have no password.
--
--   owner@demo-norte.example.test     owner of Demo Norte
--   owner@demo-sur.example.test       owner of Demo Sur
--   editor.ambos@example.test         editor in Demo Norte, analyst in Demo Sur
--   revocado@demo-norte.example.test  admin of Demo Norte whose access was revoked
--   operador@rikuy.example.test       platform operator (/plataforma; enrolls TOTP on first visit)
--
-- Users are written the way Supabase Auth stores them (auth.users + auth.identities) so
-- `db reset` stays a single reproducible command. Token columns are empty strings, not
-- NULL, as Auth expects.

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change, email_change_token_new,
  email_change_token_current, phone_change, phone_change_token, reauthentication_token
)
select
  '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', u.email, '', now(),
  '{"provider": "email", "providers": ["email"]}'::jsonb, '{}'::jsonb, now(), now(),
  '', '', '', '', '', '', '', ''
from (values
  ('5eed0000-0000-4000-8000-000000000001'::uuid, 'owner@demo-norte.example.test'),
  ('5eed0000-0000-4000-8000-000000000002'::uuid, 'owner@demo-sur.example.test'),
  ('5eed0000-0000-4000-8000-000000000003'::uuid, 'editor.ambos@example.test'),
  ('5eed0000-0000-4000-8000-000000000004'::uuid, 'revocado@demo-norte.example.test'),
  ('5eed0000-0000-4000-8000-000000000005'::uuid, 'operador@rikuy.example.test')
) as u (id, email)
on conflict (id) do nothing;

insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
select
  u.id, u.id, u.id::text, 'email',
  jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
  now(), now(), now()
from auth.users u
where u.id::text like '5eed0000-%'
on conflict do nothing;

-- Platform operator (separate from tenant memberships; acts only with a second factor).
insert into public.platform_operators (user_id) values ('5eed0000-0000-4000-8000-000000000005');

-- Municipalities follow the real onboarding order: provision → owner → domain → activate.
insert into public.tenants (id, slug, display_name, status, default_locale, timezone)
values
  ('5eed1000-0000-4000-8000-000000000001', 'demo-norte', 'Municipio Demo Norte', 'provisioning', 'es', 'America/La_Paz'),
  ('5eed1000-0000-4000-8000-000000000002', 'demo-sur', 'Municipio Demo Sur', 'provisioning', 'es', 'America/La_Paz');

insert into public.memberships (tenant_id, user_id, role, status, accepted_at, revoked_at)
values
  ('5eed1000-0000-4000-8000-000000000001', '5eed0000-0000-4000-8000-000000000001', 'owner', 'active', now(), null),
  ('5eed1000-0000-4000-8000-000000000002', '5eed0000-0000-4000-8000-000000000002', 'owner', 'active', now(), null),
  ('5eed1000-0000-4000-8000-000000000001', '5eed0000-0000-4000-8000-000000000003', 'editor', 'active', now(), null),
  ('5eed1000-0000-4000-8000-000000000002', '5eed0000-0000-4000-8000-000000000003', 'analyst', 'active', now(), null),
  ('5eed1000-0000-4000-8000-000000000001', '5eed0000-0000-4000-8000-000000000004', 'admin', 'revoked', now(), now());

insert into public.tenant_domains (id, tenant_id, hostname, kind, status, verified_at)
values
  ('5eed2000-0000-4000-8000-000000000001', '5eed1000-0000-4000-8000-000000000001', 'demo-norte.localhost', 'platform', 'active', now()),
  ('5eed2000-0000-4000-8000-000000000002', '5eed1000-0000-4000-8000-000000000002', 'demo-sur.localhost', 'platform', 'active', now());

-- Published (sealed) white-label presentation: two clearly different brands on one build.
insert into public.tenant_config_versions (id, tenant_id, version, state, sealed_at, created_by, branding)
values
  ('5eed3000-0000-4000-8000-000000000001', '5eed1000-0000-4000-8000-000000000001', 1, 'sealed', now(),
   '5eed0000-0000-4000-8000-000000000001',
   '{"identity": {"siteName": "Municipio Demo Norte", "shortName": "Demo Norte", "tagline": "Valles, ferias y caminos de herradura"},
     "theme": {"mode": "light", "brand": "#1f6f4a", "accent": "#a06f12"},
     "contact": {"email": "turismo@demo-norte.example.test", "phone": "+591 4 000 0001", "address": "Plaza principal s/n"},
     "social": [{"network": "facebook", "url": "https://facebook.example.test/demo-norte"},
                {"network": "instagram", "url": "https://instagram.example.test/demo-norte"}],
     "seo": {"description": "Destinos, ferias y recorridos 360° de un municipio de demostración del valle."}}'),
  ('5eed3000-0000-4000-8000-000000000002', '5eed1000-0000-4000-8000-000000000002', 1, 'sealed', now(),
   '5eed0000-0000-4000-8000-000000000002',
   '{"identity": {"siteName": "Municipio Demo Sur", "shortName": "Demo Sur", "tagline": "Lagunas, miradores y noches estrelladas"},
     "theme": {"mode": "dark", "brand": "#f0a868", "accent": "#7fb7d9"},
     "contact": {"email": "hola@demo-sur.example.test"},
     "social": [{"network": "youtube", "url": "https://youtube.example.test/@demo-sur"}],
     "seo": {"description": "Lagunas, miradores y cielos nocturnos de un municipio de demostración."}}');

update public.tenants t
set canonical_domain_id = d.id,
    active_config_id = c.id,
    status = 'active'
from public.tenant_domains d, public.tenant_config_versions c
where d.tenant_id = t.id and d.kind = 'platform'
  and c.tenant_id = t.id and c.state = 'sealed';

-- Destinations (synthetic). Demo Norte: one published destination with two sealed
-- revisions (the second is live), a second published one ~800 m away (to try «ordenar por
-- cercanía» and «Estás cerca de…») and one never-published draft. Demo Sur: one published.
insert into public.content_items (id, tenant_id, kind, slug, created_by)
values
  ('5eed4100-0000-4000-8000-000000000001', '5eed1000-0000-4000-8000-000000000001', 'destination', 'mirador-del-valle',
   '5eed0000-0000-4000-8000-000000000001'),
  ('5eed4100-0000-4000-8000-000000000002', '5eed1000-0000-4000-8000-000000000001', 'destination', 'feria-de-los-domingos',
   '5eed0000-0000-4000-8000-000000000003'),
  ('5eed4100-0000-4000-8000-000000000003', '5eed1000-0000-4000-8000-000000000002', 'destination', 'laguna-espejo',
   '5eed0000-0000-4000-8000-000000000002'),
  ('5eed4100-0000-4000-8000-000000000004', '5eed1000-0000-4000-8000-000000000001', 'destination', 'plaza-principal',
   '5eed0000-0000-4000-8000-000000000001');

insert into public.content_revisions
  (id, tenant_id, content_id, revision_no, state, title, summary, body, latitude, longitude, created_by, sealed_at, sealed_by)
values
  ('5eed4200-0000-4000-8000-000000000001', '5eed1000-0000-4000-8000-000000000001', '5eed4100-0000-4000-8000-000000000001',
   1, 'sealed', 'Mirador del Valle', 'Vista panorámica del valle al atardecer.',
   '[{"type": "paragraph", "children": [{"type": "text", "text": "Un mirador de demostración."}]}]',
   -17.3901, -66.1502, '5eed0000-0000-4000-8000-000000000001', now() - interval '2 days', '5eed0000-0000-4000-8000-000000000001'),
  ('5eed4200-0000-4000-8000-000000000002', '5eed1000-0000-4000-8000-000000000001', '5eed4100-0000-4000-8000-000000000001',
   2, 'sealed', 'Mirador del Valle', 'El mejor punto para ver el valle al atardecer, a 15 minutos de la plaza.',
   '[{"type": "heading", "level": 2, "children": [{"type": "text", "text": "Cómo llegar"}]},
     {"type": "paragraph", "children": [{"type": "text", "text": "Sube por el camino de herradura desde la plaza. "},
                                        {"type": "text", "text": "Lleva agua", "marks": ["bold"]},
                                        {"type": "text", "text": "."}]},
     {"type": "list", "ordered": false, "items": [[{"type": "text", "text": "Mejor hora: atardecer"}],
                                                  [{"type": "text", "text": "Entrada libre"}]]}]',
   -17.3901, -66.1502, '5eed0000-0000-4000-8000-000000000001', now() - interval '1 day', '5eed0000-0000-4000-8000-000000000001'),
  ('5eed4200-0000-4000-8000-000000000003', '5eed1000-0000-4000-8000-000000000001', '5eed4100-0000-4000-8000-000000000002',
   1, 'draft', 'Feria de los domingos', '', '[]', null, null, '5eed0000-0000-4000-8000-000000000003', null, null),
  ('5eed4200-0000-4000-8000-000000000004', '5eed1000-0000-4000-8000-000000000002', '5eed4100-0000-4000-8000-000000000003',
   1, 'sealed', 'Laguna Espejo', 'Una laguna de altura que refleja el cielo nocturno.',
   '[{"type": "paragraph", "children": [{"type": "text", "text": "Laguna de demostración para el municipio Sur."}]}]',
   -21.5302, -64.7298, '5eed0000-0000-4000-8000-000000000002', now() - interval '1 day', '5eed0000-0000-4000-8000-000000000002'),
  ('5eed4200-0000-4000-8000-000000000005', '5eed1000-0000-4000-8000-000000000001', '5eed4100-0000-4000-8000-000000000004',
   1, 'sealed', 'Plaza principal', 'El punto de partida: iglesia, mercado y la salida al mirador.',
   '[{"type": "paragraph", "children": [{"type": "text", "text": "Plaza de demostración del municipio Norte."}]}]',
   -17.3953, -66.1556, '5eed0000-0000-4000-8000-000000000001', now() - interval '3 days', '5eed0000-0000-4000-8000-000000000001');

update public.content_items i
set published_revision_id = v.published, published_at = v.published_at, draft_revision_id = v.draft
from (values
  ('5eed4100-0000-4000-8000-000000000001'::uuid, '5eed4200-0000-4000-8000-000000000002'::uuid, now() - interval '1 day', null::uuid),
  ('5eed4100-0000-4000-8000-000000000002'::uuid, null::uuid, null::timestamptz, '5eed4200-0000-4000-8000-000000000003'::uuid),
  ('5eed4100-0000-4000-8000-000000000003'::uuid, '5eed4200-0000-4000-8000-000000000004'::uuid, now() - interval '1 day', null::uuid),
  ('5eed4100-0000-4000-8000-000000000004'::uuid, '5eed4200-0000-4000-8000-000000000005'::uuid, now() - interval '3 days', null::uuid)
) as v (id, published, published_at, draft)
where i.id = v.id;

-- Events (synthetic), dated relative to today in each tenant's time zone so the agenda
-- always has something upcoming. Demo Norte: one upcoming (at a destination), one that
-- already ended, one draft. Demo Sur: one upcoming all-day event.
insert into public.content_items (id, tenant_id, kind, slug, created_by)
values
  ('5eed4100-0000-4000-8000-000000000011', '5eed1000-0000-4000-8000-000000000001', 'event', 'feria-del-choclo',
   '5eed0000-0000-4000-8000-000000000001'),
  ('5eed4100-0000-4000-8000-000000000012', '5eed1000-0000-4000-8000-000000000001', 'event', 'festival-de-invierno',
   '5eed0000-0000-4000-8000-000000000001'),
  ('5eed4100-0000-4000-8000-000000000013', '5eed1000-0000-4000-8000-000000000001', 'event', 'concierto-de-la-banda',
   '5eed0000-0000-4000-8000-000000000003'),
  ('5eed4100-0000-4000-8000-000000000014', '5eed1000-0000-4000-8000-000000000002', 'event', 'noche-de-estrellas',
   '5eed0000-0000-4000-8000-000000000002');

with today as (
  select t.id as tenant_id, date_trunc('day', now() at time zone t.timezone) as day
  from public.tenants t
)
insert into public.content_revisions
  (id, tenant_id, content_id, revision_no, state, title, summary, body, latitude, longitude,
   starts_local, ends_local, all_day, venue_content_id, created_by, sealed_at, sealed_by)
select v.id::uuid, v.tenant_id::uuid, v.content_id::uuid, 1, v.state::public.config_state, v.title, v.summary,
       v.body::jsonb, v.latitude, v.longitude,
       today.day + v.starts_offset::interval, today.day + v.ends_offset::interval, v.all_day,
       v.venue::uuid, v.created_by::uuid,
       case when v.state = 'sealed' then now() - interval '1 day' end,
       case when v.state = 'sealed' then v.created_by::uuid end
from (values
  ('5eed4200-0000-4000-8000-000000000011', '5eed1000-0000-4000-8000-000000000001', '5eed4100-0000-4000-8000-000000000011',
   'sealed', 'Feria del choclo', 'Productores del valle, comida y música en el mirador.',
   '[{"type": "paragraph", "children": [{"type": "text", "text": "Una feria de demostración con "},
                                         {"type": "text", "text": "entrada libre", "marks": ["bold"]},
                                         {"type": "text", "text": "."}]}]',
   -17.3901, -66.1502, '10 days 10 hours', '10 days 18 hours', false, '5eed4100-0000-4000-8000-000000000001',
   '5eed0000-0000-4000-8000-000000000001'),
  ('5eed4200-0000-4000-8000-000000000012', '5eed1000-0000-4000-8000-000000000001', '5eed4100-0000-4000-8000-000000000012',
   'sealed', 'Festival de invierno', 'Un evento que ya terminó: no aparece en la agenda.',
   '[]', -17.3925, -66.1540, '-40 days', '-38 days', true, null,
   '5eed0000-0000-4000-8000-000000000001'),
  ('5eed4200-0000-4000-8000-000000000013', '5eed1000-0000-4000-8000-000000000001', '5eed4100-0000-4000-8000-000000000013',
   'draft', 'Concierto de la banda', '', '[]', null, null, null, null, null, null,
   '5eed0000-0000-4000-8000-000000000003'),
  ('5eed4200-0000-4000-8000-000000000014', '5eed1000-0000-4000-8000-000000000002', '5eed4100-0000-4000-8000-000000000014',
   'sealed', 'Noche de estrellas', 'Observación del cielo junto a la laguna, con guías locales.',
   '[{"type": "paragraph", "children": [{"type": "text", "text": "Evento de demostración para el municipio Sur."}]}]',
   -21.5302, -64.7298, '20 days', '21 days', true, '5eed4100-0000-4000-8000-000000000003',
   '5eed0000-0000-4000-8000-000000000002')
) as v (id, tenant_id, content_id, state, title, summary, body, latitude, longitude,
        starts_offset, ends_offset, all_day, venue, created_by)
join today on today.tenant_id = v.tenant_id::uuid;

update public.content_items i
set published_revision_id = case when r.state = 'sealed' then r.id end,
    published_at = case when r.state = 'sealed' then now() - interval '1 day' end,
    draft_revision_id = case when r.state = 'draft' then r.id end
from public.content_revisions r
where r.content_id = i.id and i.kind = 'event';

insert into public.audit_events (scope, action, outcome, diff)
values ('platform', 'platform.seed_loaded', 'success', '{"tenants": 2, "users": 5, "operators": 1, "published_configs": 2, "destinations": 3, "events": 4}');
