-- Cloud demo on *.vercel.app (P3 · Paso 8). Run ONCE, after the first
-- `Deploy database` with "seed" checked, in the SQL editor of the cloud project.
--
-- The seed is written for local development (*.localhost hosts, a synthetic operator).
-- This moves the two demo municipalities to their public Vercel addresses and removes the
-- synthetic operator, whose example.test address can never receive a sign-in code.
-- Real people (the platform operator, the demo owners) are added afterwards with
-- `pnpm platform:add-operator` and «Miembros» in the panel; no personal email lives here.

begin;

update public.tenant_domains
set hostname = 'rikuy-demo-norte.vercel.app'
where id = '5eed2000-0000-4000-8000-000000000001' and hostname = 'demo-norte.localhost';

update public.tenant_domains
set hostname = 'rikuy-demo-sur.vercel.app'
where id = '5eed2000-0000-4000-8000-000000000002' and hostname = 'demo-sur.localhost';

delete from public.platform_operators
where user_id = '5eed0000-0000-4000-8000-000000000005';

commit;

-- Expected: the two hostnames above, both active.
select t.slug, d.hostname, d.status
from public.tenant_domains d
join public.tenants t on t.id = d.tenant_id
order by t.slug;
