-- Structural guarantees: RLS everywhere, anon locked out, definer helpers hardened.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(21);

-- RLS enabled on every P1 table
select ok(relrowsecurity, format('RLS enabled on %s', relname))
from pg_class
where oid in (
  'public.tenants'::regclass,
  'public.tenant_domains'::regclass,
  'public.memberships'::regclass,
  'public.tenant_config_versions'::regclass,
  'public.audit_events'::regclass
)
order by relname;

-- anon has no table privileges at all
select ok(
  not has_table_privilege('anon', t, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
  format('anon has no privileges on %s', t)
)
from unnest(array[
  'public.tenants', 'public.tenant_domains', 'public.memberships',
  'public.tenant_config_versions', 'public.audit_events'
]) as t
order by t;

-- authenticated is read-only on every P1 table
select ok(
  not has_table_privilege('authenticated', t, 'INSERT, UPDATE, DELETE, TRUNCATE'),
  format('authenticated cannot write %s directly', t)
)
from unnest(array[
  'public.tenants', 'public.tenant_domains', 'public.memberships',
  'public.tenant_config_versions', 'public.audit_events'
]) as t
order by t;

-- Domain registry secrets are not readable
select ok(
  not has_column_privilege('authenticated', 'public.tenant_domains', 'verification_token_hash', 'SELECT'),
  'authenticated cannot read verification_token_hash'
);
select ok(
  not has_column_privilege('authenticated', 'public.tenant_domains', 'provider_domain_id', 'SELECT'),
  'authenticated cannot read provider_domain_id'
);

-- SECURITY DEFINER functions: empty search_path, not executable by PUBLIC
select ok(
  bool_and(p.proconfig @> array['search_path=""']),
  'every SECURITY DEFINER function pins an empty search_path'
)
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where p.prosecdef and n.nspname in ('public', 'private');

select ok(
  not has_function_privilege('public', 'private.has_tenant_role(uuid, public.membership_role[])', 'EXECUTE'),
  'PUBLIC cannot execute private.has_tenant_role'
);

-- The private schema is not reachable by anon
select ok(not has_schema_privilege('anon', 'private', 'USAGE'), 'anon has no usage on schema private');

-- Tenant resolution is the only entry point for anon
select ok(
  has_function_privilege('anon', 'public.resolve_tenant_by_host(text)', 'EXECUTE'),
  'anon can execute resolve_tenant_by_host'
);

select * from finish();
rollback;
