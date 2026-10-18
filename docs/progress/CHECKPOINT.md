# Checkpoint

> Archivo de continuidad. Se actualiza al final de cada paso. Cualquier sesión de trabajo empieza leyendo esto.

## Estado actual

- **Fase:** P1 — Fundación
- **Último paso completado:** P1 · Paso 4 — autenticación del panel de administración (2026-10-17)
- **Rama del paso:** `feat/p1-step4-admin-auth` → PR hacia `main`

## Historial

### Paso 1 — base del repositorio ✅

Monorepo pnpm (`apps/web`, `apps/worker`, `packages/core|db|ui|config`), TypeScript strict, ESLint con regla de capas, Prettier, CI (format, lint, typecheck, test, build, gitleaks), `.env.example`, documentación base y ADR-019/020.

### Paso 2 — Supabase local y esquema P1 ✅

Migración `20261017140000_p1_foundation.sql` (tenants, tenant_domains, memberships, tenant_config_versions, audit_events) con FK compuestas, invariantes en la base, RLS por membresía actual, grants mínimos y `resolve_tenant_by_host` como única entrada anónima. 74 aserciones pgTAP en CI y en local. Seed sintético `demo-norte` / `demo-sur`.

### Paso 3 — resolución de tenant por host ✅

`normalizeHost` / `classifyHost`, contrato `TenantContext`, caso de uso `resolvePortalTenant` (found · redirect · not_found · unavailable) con caché por instancia, adaptador RPC en `@rikuy/db` y `src/proxy.ts` (solo lee `Host`, elimina cabeceras internas entrantes, reescribe a `/admin`, `/platform` o `/portal/{host}`; 404 `noindex`, 503 `Retry-After`, 308 alias → canónico, 400 host inválido).

### Paso 4 — autenticación del panel de administración ✅

- `@rikuy/core`:
  - `normalizeEmail`, `normalizeOneTimeCode`; contratos `OrganizationMembership`, `Actor`, `ROLE_LABELS`.
  - Puertos `AuthGateway` y `MembershipReader`.
  - Casos de uso `requestSignInCode` (anti-enumeración: un correo no provisionado recibe la misma respuesta que uno válido), `verifySignInCode`, `listMyOrganizations`, `openOrganization`.
- `@rikuy/db`:
  - `createSessionClient`: cliente por request con `@supabase/ssr`, cookies host-only `HttpOnly` + `SameSite=Lax` (+ `Secure` fuera de `localhost`), sin `Domain` → nunca llegan a los hosts de portal.
  - `createSupabaseAuthGateway`: OTP por correo con `shouldCreateUser: false`; errores mapeados a resultados gruesos. Un error de configuración del servidor de Auth (`email_provider_disabled`) es `unavailable`, no se esconde tras el mensaje anti-enumeración.
  - `createMembershipReader`: membresías activas de tenants activos, leídas con el JWT del usuario (RLS).
- `apps/web` (host de admin):
  - `/login` con código de 6 dígitos y enlace mágico (`/auth/callback`, PKCE); `/logout` solo `POST` con verificación de `Origin`.
  - Lista de municipios en `/` y `/o/{slug}`: cada página revalida sesión y membresía actual en servidor (`requireAdminActor` → `openOrganization`; sin membresía → 404).
  - El proxy refresca la sesión solo en el host de admin y solo si hay cookies `sb-*`; cabeceras `noindex`, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`.
- Supabase local: registro público desactivado (`[auth] enable_signup = false`), proveedor de correo activo, plantilla en español (`supabase/templates/magic-link.html`), TOTP habilitado en el servidor.
- Seed: 4 usuarios sintéticos sin contraseña (dueño norte, dueño sur, editor en norte + analista en sur, admin revocado).
- CI: nuevo job **Auth integration** que levanta la pila real (GoTrue + PostgREST + Mailpit) y prueba inicio de sesión por código, aislamiento A/B por RLS, revocación aplicada a una sesión con token vigente, correo desconocido sin email y logout. Los fallos se publican como anotaciones del check.
- Tests: 92 unitarios (core 54, db 18, web 14, config 6) + 6 de integración + 74 pgTAP.

**Corrección posterior (`fix/admin-login-redirect`):** al verificar el código, el panel mostraba la página de la plataforma en `app.localhost:3000`. Causa: `redirect()` dentro de una Server Action hace que Next renderice el destino con un fetch interno a `http://localhost:3000`, saltándose la resolución por host. Ahora la acción devuelve `signed_in` y el navegador navega; ESLint prohíbe `redirect` en `actions.ts` y la regla quedó en CONTRIBUTING §1.2.

**Desviaciones respecto al plan:**

- Usuarios del seed escritos en `auth.users` + `auth.identities` desde `seed.sql` (no con la Auth Admin API) para que `pnpm db:reset` siga siendo un solo comando reproducible.
- MFA TOTP: habilitado en el servidor; la pantalla de enrolamiento y su exigencia para propietarios/administradores llegan con la gestión de miembros.
- Operador de plataforma: movido al Paso 6 (va junto al flujo de alta de tenants).

## Cómo verificarlo en tu PC

```powershell
git checkout main
git pull
pnpm install
pnpm db:stop
pnpm db:start      # aplica la nueva config de Auth
pnpm db:reset      # recarga el seed con los usuarios de prueba
pnpm dev
```

1. Abre http://app.localhost:3000 → redirige a «Iniciar sesión».
2. Escribe `owner@demo-norte.example.test` → «Recibir código».
3. Abre Mailpit en http://127.0.0.1:54324, copia el código de 6 dígitos (o pulsa el enlace del correo).
4. Debes ver solo «Municipio Demo Norte» (Propietario). Entra a `/o/demo-norte`; prueba `/o/demo-sur` → 404.
5. «Cerrar sesión» → vuelve a «Iniciar sesión».
6. Repite con `editor.ambos@example.test` (ve los dos municipios con roles distintos) y `revocado@demo-norte.example.test` (entra, pero no ve ningún municipio).
7. Un correo inventado muestra el mismo mensaje («Si … tiene acceso, te enviamos un código») y no llega nada a Mailpit.

Opcional, tests de integración contra tu pila local (PowerShell; las claves salen de `pnpm db:status`):

```powershell
$env:SUPABASE_PUBLISHABLE_KEY="<Publishable key>"; $env:SUPABASE_SECRET_KEY="<Secret key>"
pnpm --filter @rikuy/db test:integration
```

## Siguiente paso — P1 · Paso 5 (requiere autorización)

Rama `feat/p1-step5-white-label-config`:

1. Contrato `TenantPresentation` (Zod, versionado) en `@rikuy/core`: identidad (nombre, nombre corto, lema), tema (colores con validación de contraste WCAG AA), contactos, redes, SEO por defecto, datos del manifest PWA. Sin literales de municipio.
2. Casos de uso `saveConfigDraft` y `sealConfigVersion` (borrador → sellada; la versión activa siempre sellada, invariante ya en la base) con RPC transaccional y evento de auditoría.
3. Lectura pública de la versión activa sellada vía RPC anónima (solo campos públicos), cacheada por tenant + versión.
4. Portal: `TenantPresentation` aplicada en el layout (CSS variables del tema, metadatos SEO, `manifest.webmanifest` por host).
5. Admin: formulario de configuración en `/o/{slug}/configuracion` (solo propietario/administrador), con vista previa y botón «Publicar».
6. Tests: pgTAP (editor no puede sellar, analista no escribe, B no lee borradores de A, anónimo solo ve la sellada), unitarios de contraste y del contrato, e2e: dos tenants con marcas distintas en el mismo build.

## Decisiones pendientes del usuario

- Ninguna bloqueante para el Paso 5.
