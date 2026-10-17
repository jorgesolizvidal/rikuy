# Checkpoint

> Archivo de continuidad. Se actualiza al final de cada paso. Cualquier sesión de trabajo empieza leyendo esto.

## Estado actual

- **Fase:** P1 — Fundación
- **Último paso completado:** P1 · Paso 3 — resolución de tenant por host (2026-10-17)
- **Rama del paso:** `feat/p1-step3-tenant-resolution` → PR hacia `main`

## Historial

### Paso 1 — base del repositorio ✅

Monorepo pnpm (`apps/web`, `apps/worker`, `packages/core|db|ui|config`), TypeScript strict, ESLint con regla de capas, Prettier, CI (format, lint, typecheck, test, build, gitleaks), `.env.example`, documentación base y ADR-019/020.

### Paso 2 — Supabase local y esquema P1 ✅

Migración `20261017140000_p1_foundation.sql` (tenants, tenant_domains, memberships, tenant_config_versions, audit_events) con FK compuestas, invariantes en la base, RLS por membresía actual, grants mínimos y `resolve_tenant_by_host` como única entrada anónima. 74 aserciones pgTAP en CI y en local. Seed sintético `demo-norte` / `demo-sur`.

### Paso 3 — resolución de tenant por host ✅

- `@rikuy/core`:
  - `normalizeHost` / `classifyHost`: minúsculas, IDNA, sin punto final; rechaza userinfo, rutas, IPv6, múltiples valores y puertos fuera de local. Superficies: `admin`, `platform`, `portal`, `invalid`.
  - Contrato `TenantContext` (Zod) y códec ASCII para la cabecera interna.
  - Caso de uso `resolvePortalTenant`: `found` · `redirect` (alias → canónico) · `not_found` · `unavailable`.
  - `createCachedTenantDirectory`: TTL 60 s / 10 s, sin cachear errores, deduplica búsquedas concurrentes, clave por host exacto.
- `@rikuy/db`: adaptador `createSupabaseTenantDirectory` (RPC con clave publicable, sin sesión, timeout 2 s, filas validadas con Zod).
- `@rikuy/config`: `parsePlatformEnv` (lo que necesita el proxy, sin secretos).
- `apps/web`:
  - `src/proxy.ts`: lee solo `Host`, elimina cabeceras internas entrantes, reescribe a `/admin`, `/platform` o `/portal/{host}`; 404 `noindex`, 503 con `Retry-After`, 308 de alias a canónico, 400 para host inválido.
  - Páginas: portal mínimo con el nombre del tenant resuelto (sin literales de municipio), panel de admin placeholder, sitio de plataforma.
- Supabase local: analytics desactivado (evita exponer el daemon de Docker en Windows). Tests pgTAP sin `NOTICE`.
- Tests: 60 unitarios/integración (core 37, db 6, web 11, config 6) + 74 pgTAP. Verificado de punta a punta con `next start` contra el esquema real: norte/sur resuelven su tenant, desconocido 404, admin y plataforma por host, spoofing ignorado, acceso directo a `/portal/...` 404, host inválido 400, registro caído 503 (y hosts en caché siguen sirviendo).

## Cómo verificarlo en tu PC

```powershell
git checkout main
git pull
pnpm install
pnpm db:stop
pnpm db:start      # reinicia sin analytics (ya no aparece la advertencia de Windows)
pnpm dev
```

- http://demo-norte.localhost:3000 → «Municipio Demo Norte»
- http://demo-sur.localhost:3000 → «Municipio Demo Sur»
- http://otro.localhost:3000 → 404 «Sitio no encontrado»
- http://app.localhost:3000 → panel de administración (placeholder)
- http://localhost:3000 → sitio de Rikuy

## Siguiente paso — P1 · Paso 4 (requiere autorización)

Rama `feat/p1-step4-admin-auth`:

1. Supabase Auth en el host de admin vía BFF: inicio de sesión con email (enlace mágico / OTP; Mailpit local en http://127.0.0.1:54324), cookies host-only `Secure`/`HttpOnly`/`SameSite=Lax`, refresh solo en servidor, logout.
2. Cliente Supabase por request con el JWT del usuario (`@rikuy/db`), sin reutilizar clientes entre usuarios.
3. Caso de uso `listMyOrganizations` y selector `/o/{slug}`; cada página verifica membresía actual en servidor.
4. Usuarios del seed provisionados con la Auth Admin API (reemplazan los placeholders SQL), un usuario miembro de dos tenants y uno revocado.
5. Protección CSRF/Origin en mutaciones; MFA TOTP preparado para administradores.
6. Tests: sin sesión → login; rol revocado con token vigente → sin acceso; usuario de A no ve B; cookie de admin nunca enviada a hosts de portal.

## Decisiones pendientes del usuario

- Ninguna bloqueante para el Paso 4.
