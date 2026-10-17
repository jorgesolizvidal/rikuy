-- Local development seed. Synthetic data only: fictional municipalities, example.test
-- users, no real people, credentials or media. Runs on `pnpm db:reset`.
--
-- Portals after `pnpm dev`:  http://demo-norte.localhost:3000  ·  http://demo-sur.localhost:3000
--
-- The users below are placeholders so memberships satisfy the "active tenant has an
-- owner" invariant. They cannot sign in yet; login flows arrive in P1 · Paso 4,
-- which replaces them with users provisioned through the Auth Admin API.

insert into auth.users (id, email, aud, role)
values
  ('5eed0000-0000-4000-8000-000000000001', 'owner@demo-norte.example.test', 'authenticated', 'authenticated'),
  ('5eed0000-0000-4000-8000-000000000002', 'owner@demo-sur.example.test', 'authenticated', 'authenticated')
on conflict (id) do nothing;

insert into public.tenants (id, slug, display_name, status, default_locale, timezone)
values
  ('5eed1000-0000-4000-8000-000000000001', 'demo-norte', 'Municipio Demo Norte', 'provisioning', 'es', 'America/La_Paz'),
  ('5eed1000-0000-4000-8000-000000000002', 'demo-sur', 'Municipio Demo Sur', 'provisioning', 'es', 'America/La_Paz');

insert into public.memberships (tenant_id, user_id, role, status, accepted_at)
values
  ('5eed1000-0000-4000-8000-000000000001', '5eed0000-0000-4000-8000-000000000001', 'owner', 'active', now()),
  ('5eed1000-0000-4000-8000-000000000002', '5eed0000-0000-4000-8000-000000000002', 'owner', 'active', now());

insert into public.tenant_domains (id, tenant_id, hostname, kind, status, verified_at)
values
  ('5eed2000-0000-4000-8000-000000000001', '5eed1000-0000-4000-8000-000000000001', 'demo-norte.localhost', 'platform', 'active', now()),
  ('5eed2000-0000-4000-8000-000000000002', '5eed1000-0000-4000-8000-000000000002', 'demo-sur.localhost', 'platform', 'active', now());

-- Same order a real onboarding follows: provision → owner → domain → activate.
update public.tenants t
set canonical_domain_id = d.id, status = 'active'
from public.tenant_domains d
where d.tenant_id = t.id and d.kind = 'platform';

insert into public.audit_events (scope, action, outcome, diff)
values ('platform', 'platform.seed_loaded', 'success', '{"tenants": 2}');
