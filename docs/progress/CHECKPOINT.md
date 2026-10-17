# Checkpoint

> Archivo de continuidad. Se actualiza al final de cada paso. Cualquier sesión de trabajo empieza leyendo esto.

## Estado actual

- **Fase:** P1 — Fundación
- **Último paso completado:** P1 · Paso 5 — marca white-label versionada (2026-10-17)
- **Rama del paso:** `feat/p1-step5-white-label-config` → PR hacia `main`

## Historial

### Paso 1 — base del repositorio ✅

Monorepo pnpm (`apps/web`, `apps/worker`, `packages/core|db|ui|config`), TypeScript strict, ESLint con regla de capas, Prettier, CI (format, lint, typecheck, test, build, gitleaks), `.env.example`, documentación base y ADR-019/020.

### Paso 2 — Supabase local y esquema P1 ✅

Migración `20261017140000_p1_foundation.sql` (tenants, tenant_domains, memberships, tenant_config_versions, audit_events) con FK compuestas, invariantes en la base, RLS por membresía actual, grants mínimos y `resolve_tenant_by_host` como única entrada anónima. 74 aserciones pgTAP en CI y en local. Seed sintético `demo-norte` / `demo-sur`.

### Paso 3 — resolución de tenant por host ✅

`normalizeHost` / `classifyHost`, contrato `TenantContext`, caso de uso `resolvePortalTenant` (found · redirect · not_found · unavailable) con caché por instancia, adaptador RPC en `@rikuy/db` y `src/proxy.ts` (solo lee `Host`, elimina cabeceras internas entrantes, reescribe a `/admin`, `/platform` o `/portal/{host}`; 404 `noindex`, 503 `Retry-After`, 308 alias → canónico, 400 host inválido).

### Paso 4 — autenticación del panel de administración ✅

Inicio de sesión en el host de admin con código de 6 dígitos o enlace mágico (BFF con cookies host-only `HttpOnly`/`SameSite=Lax`), sin registro público y sin enumeración de cuentas; lista de municipios y `/o/{slug}` con membresía revalidada en cada request (revocar quita el acceso al instante); logout solo `POST` con verificación de `Origin`. Seed con 4 usuarios sintéticos. Job de CI con la pila real de Supabase (GoTrue + PostgREST + Mailpit). Desviaciones: usuarios del seed en SQL (no Auth Admin API); enrolamiento MFA y operador de plataforma diferidos.

**Corrección posterior (`fix/admin-login-redirect`, PR #4):** `redirect()` dentro de una Server Action hacía que Next renderizara el destino con un fetch interno a `localhost:3000`, saltándose la resolución por host (el panel mostraba la página de la plataforma tras iniciar sesión). Ahora la acción devuelve estado y el navegador navega; ESLint prohíbe `redirect` en `actions.ts` (CONTRIBUTING §1.2).

### Paso 5 — marca white-label versionada ✅

- `@rikuy/core`:
  - Contrato `TenantPresentation` (Zod estricto, `schema_version` 1): identidad (nombre, nombre corto ≤ 12, lema), tema (modo claro/oscuro + color principal + acento), contacto, redes (https, una por red), descripción SEO. Solo texto de una línea, colores `#rrggbb`, sin HTML/CSS.
  - Contraste WCAG 2.x: color principal sobre fondo ≥ 4.5:1, texto de botones ≥ 4.5:1, acento ≥ 3:1. El resto de la paleta se deriva (`deriveTheme`), así ninguna marca produce un portal ilegible.
  - Casos de uso `loadBrandingEditor`, `saveBrandingDraft`, `publishBranding` (solo propietario/administrador), `resolvePortalPresentation` (si no hay versión publicada, es ilegible o la lectura falla → marca neutra, nunca la de otro tenant) y lector en caché por versión sellada (inmutable).
  - `buildWebManifest` y monograma para íconos.
- Base de datos (`20261017200000_p1_tenant_presentation.sql`, solo expand):
  - `revision`, `updated_at`, `updated_by`; como máximo un borrador por tenant.
  - `private.is_valid_presentation`: la base revalida la forma (no se puede saltar el contrato llamando al RPC directo).
  - RPC `save_tenant_config_draft` (concurrencia optimista → `PT409`), `publish_tenant_config` (sellar + mover puntero + auditoría en una transacción), `get_published_presentation` (anónimo: solo la versión activa sellada de un tenant activo). Tenants suspendidos: solo lectura.
  - Seed: dos marcas publicadas muy distintas (Norte claro/verde, Sur oscuro/naranja).
- `@rikuy/db`: `createTenantConfigRepository` (JWT del usuario, errores → `forbidden` / `conflict` / `invalid` / `not_found`) y `createSupabasePresentationReader` (anónimo, timeout 2 s).
- Portal:
  - Layout por tenant con variables CSS del tema, cabecera con monograma, pie con contacto y redes; portada con el nombre en grande sobre un mapa topográfico SVG generado a partir del id del tenant (sin imágenes ni JS).
  - Metadatos SEO por tenant (título, descripción, canonical, Open Graph, `theme-color`, indexable).
  - `/manifest.webmanifest` e íconos generados `/icon/{32|180|192|512}` (monograma sobre el color principal; caché inmutable con `?v=<versión>`). Portal instalable sin subir ningún logo.
  - Tipografía Bricolage Grotesque autoalojada (subset latino, 41 KB, `font-display: swap`).
- Admin: `/o/{slug}/configuracion` con formulario, vista previa en vivo y verificación de contraste; «Guardar borrador» y «Publicar». Editores y analistas ven la marca en solo lectura. Los cambios llegan a los visitantes en ≤ 60 s (caché del registro de dominios).
- Tests: 156 unitarios (core 100, db 33, web 17, config 6) + 9 de integración + 115 pgTAP (41 nuevos) + e2e de portales en CI (30 comprobaciones: dos marcas en el mismo build, manifest, ícono, host desconocido, admin sin sesión).
- Verificado localmente de punta a punta sobre las migraciones reales: publicar desde el panel cambia el portal Norte y no toca el Sur; editor en solo lectura; propietario de otro municipio y miembro revocado → 404.

## Cómo verificarlo en tu PC

```powershell
git checkout main
git pull
pnpm install
pnpm db:reset      # aplica la migración nueva y recarga el seed con las dos marcas
pnpm dev
```

1. http://demo-norte.localhost:3000 → portal claro y verde; http://demo-sur.localhost:3000 → portal oscuro y naranja. Mismo código.
2. Entra a http://app.localhost:3000 con `owner@demo-norte.example.test` (código en Mailpit, http://127.0.0.1:54324) → «Municipio Demo Norte» → «Marca del portal».
3. Cambia el color principal a un amarillo claro (`#ffd400`): la vista previa marca el contraste insuficiente y «Publicar» lo rechaza.
4. Elige otro color (por ejemplo `#7a2e8f`), cambia el lema y pulsa «Publicar». En menos de un minuto el portal Norte cambia; el Sur sigue igual.
5. Con `editor.ambos@example.test` la misma página aparece en solo lectura.

## Siguiente paso — P1 · Paso 6 (requiere autorización)

Rama `feat/p1-step6-tenant-onboarding`:

1. Operador de plataforma: tabla `platform_operators` (separada de las membresías), acceso solo con MFA TOTP (enrolamiento en el panel) y área `/platform` en el host de admin.
2. Caso de uso `provisionTenant` en una transacción RPC: tenant `provisioning` → dominio de plataforma (`{slug}.{dominio}` o alias `*.vercel.app` exacto) → invitación del primer propietario (Auth Admin API, solo en el adaptador de plataforma) → activación; auditoría en cada paso.
3. Aceptación de invitación por el propietario (primer inicio de sesión) y gestión básica de miembros (invitar, cambiar rol, revocar) con las reglas de último propietario ya presentes en la base.
4. Script de alta reproducible para Ucureña (datos del tenant, sin binarios; logos y fotos los sube Jorge desde el panel cuando exista Storage en P3) y un municipio demo sintético.
5. Ensayo ZC-01: dar de alta un tenant B desde el panel del operador sin tocar código ni variables de entorno, con test e2e en CI.

## Decisiones pendientes del usuario

- Ninguna bloqueante para el Paso 6. El PR #4 (corrección del redirect tras iniciar sesión) es independiente y puede mergearse antes o después de este.
