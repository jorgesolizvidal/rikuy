# Checkpoint

> Archivo de continuidad. Se actualiza al final de cada paso. Cualquier sesión de trabajo empieza leyendo esto.

## Estado actual

- **Fase:** P1 — Fundación
- **Último paso completado:** P1 · Paso 2 — Supabase local + esquema P1 con RLS (2026-10-17)
- **Rama del paso:** `feat/p1-step2-supabase-local` → PR hacia `main`

## Historial

### Paso 1 — base del repositorio ✅

Monorepo pnpm (`apps/web`, `apps/worker`, `packages/core|db|ui|config`), TypeScript strict, ESLint con regla de capas, Prettier, CI (format, lint, typecheck, test, build, gitleaks), `.env.example`, documentación base y ADR-019/020.

### Paso 2 — Supabase local y esquema P1 ✅

- Supabase CLI 2.121.0 como dependencia del proyecto (`pnpm db:*`). `supabase/config.toml`: Realtime y vector buckets desactivados, registro público desactivado, redirección de Auth solo al host de admin, MFA TOTP habilitado.
- Migración `20261017140000_p1_foundation.sql`:
  - Tablas: `tenants`, `tenant_domains`, `memberships`, `tenant_config_versions`, `audit_events`.
  - FK compuestas `(tenant_id, id)` para dominio canónico y configuración activa; `tenant_id` inmutable.
  - Invariantes en la base: tenant activo requiere owner activo; no se puede quitar el último owner (diferido, permite transferir); configuración sellada inmutable; dominio canónico debe estar activo; auditoría append-only; slugs reservados; hosts normalizados.
  - Privilegios: `anon` sin acceso a tablas; `authenticated` solo lectura, con columnas sensibles ocultas (`verification_token_hash`, `provider_domain_id`). Escrituras llegarán por RPC por intención.
  - RLS por membresía **actual** (revocación inmediata aunque el JWT siga vigente) con helper `private.has_tenant_role` (SECURITY DEFINER, `search_path` vacío, devuelve booleano).
  - `public.resolve_tenant_by_host(host)`: única entrada anónima; coincidencia exacta, solo dominios y tenants activos, sin tenant por defecto.
- Tests pgTAP (74 aserciones en 4 suites): estructura y privilegios, aislamiento por rol (anon, owner/admin/editor/analyst, revocado, miembro de A y B, externo), invariantes y resolución de tenant.
- Seed sintético: `demo-norte.localhost` y `demo-sur.localhost` (municipios ficticios, sin datos reales).
- CI: job de base de datos que levanta Postgres de Supabase, aplica migraciones + seed, corre pgTAP y `db lint`. El CI corre en cada push de cualquier rama.

Nota técnica: los helpers SECURITY DEFINER pertenecen al rol `postgres` (dueño de las tablas en Supabase). La ADR-014 sugería un dueño NOLOGIN dedicado; en Supabase gestionado eso exige atributos de rol no disponibles de forma portable, así que se compensa con `search_path` vacío, nombres calificados, retorno booleano y `EXECUTE` revocado a `PUBLIC`.

## Cómo verificarlo en tu PC

```powershell
git pull
pnpm install
pnpm db:start      # la primera vez descarga imágenes (varios minutos)
pnpm db:test       # debe terminar en "All tests successful"
pnpm db:status     # muestra API URL, Publishable key y Secret key locales
```

Copiar `.env.example` a `apps/web/.env.local` y pegar ahí la URL y las dos claves de `db:status`. Studio local: http://127.0.0.1:54323

## Siguiente paso — P1 · Paso 3 (requiere autorización)

Rama `feat/p1-step3-tenant-resolution`:

1. `packages/core`: normalización de host (minúsculas, IDNA, sin punto final, puertos solo en local) y tipo `TenantContext` inmutable, con tests.
2. `packages/db`: cliente Supabase por request (anon para resolución pública) y repositorio `TenantDirectory` que llama a `resolve_tenant_by_host`.
3. `apps/web`: `proxy.ts` de Next.js que separa host de admin y hosts de portal, elimina cabeceras internas entrantes y resuelve el tenant en servidor; 404 `noindex` para host desconocido, 503 si la base no responde; redirección 308 de alias a canónico.
4. Página de portal mínima que muestra el nombre del tenant resuelto (sin literales de municipio).
5. Tests: host válido/alias/desconocido/suspendido, spoofing de `X-Forwarded-Host`/`X-Tenant-*`, dos tenants en peticiones simultáneas.

## Decisiones pendientes del usuario

- Ninguna bloqueante para el Paso 3.
