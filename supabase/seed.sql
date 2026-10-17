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
  ('5eed0000-0000-4000-8000-000000000004'::uuid, 'revocado@demo-norte.example.test')
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

insert into public.audit_events (scope, action, outcome, diff)
values ('platform', 'platform.seed_loaded', 'success', '{"tenants": 2, "users": 4, "published_configs": 2}');
