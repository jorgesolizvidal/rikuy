# Checkpoint

> Archivo de continuidad. Se actualiza al final de cada paso. Cualquier sesión de trabajo empieza leyendo esto.

## Estado actual

- **Fase:** P1 — Fundación ✅ (completa). Siguiente fase: P3.
- **Último paso completado:** P1 · Paso 6 — alta de municipios, invitaciones y miembros (2026-10-17)
- **Rama del paso:** `feat/p1-step6-tenant-onboarding` → PR hacia `main`

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

Contrato `TenantPresentation` (identidad, tema con contraste WCAG AA, contacto, redes, SEO) versionado en `tenant_config_versions`: borrador con concurrencia optimista, publicación en una transacción (sellar + puntero + auditoría) y lectura anónima solo de la versión activa sellada; la base revalida la forma del JSON. Portal con tema por variables CSS, SEO por tenant, `manifest.webmanifest` e íconos generados; editor de marca con vista previa en `/o/{slug}/configuracion`. E2E en CI: dos marcas en un mismo build.

### Paso 6 — alta de municipios, invitaciones y miembros ✅

- Base de datos (`20261018000000_p1_platform_onboarding.sql`, solo expand):
  - `platform_operators` separado de las membresías; toda verificación de operador exige `aal2` (segundo factor) en el JWT. Sin acceso directo a la tabla.
  - `provision_tenant`: tenant `provisioning` + dominio de plataforma activo + puntero canónico + propietario **invitado** + auditoría, en una transacción. `set_tenant_status`: preparación → en línea (solo con propietario activo) ⇄ suspendido.
  - `my_pending_invitations` / `accept_membership_invitation`; `list_tenant_members`, `add_tenant_member`, `change_member_role`, `revoke_member` con reglas de rol (los administradores solo gestionan editores y analistas) y de último propietario.
  - `platform_user_id_by_email` solo para `service_role` (adaptador de identidad).
  - **Corrección encontrada en la prueba local:** los triggers diferidos de invariantes se ejecutaban al hacer COMMIT con el rol del operador y, por RLS, no veían el dominio ni la membresía recién creados → el alta fallaba. Ahora corren con derechos de propietario; el test pgTAP reproduce el momento del COMMIT.
  - Seed: operador sintético `operador@rikuy.example.test`.
- `@rikuy/core`: `operatorGate` (enroll / verify / granted), `provisionTenant` (verifica al operador **antes** de crear cualquier cuenta), `changeTenantStatus`, invitaciones, `inviteMember` / `changeMemberRole` / `revokeMember` con `canAssignRole`, `suggestSlug`.
- `@rikuy/db`: repositorios con la sesión del usuario, `createMfaGateway` (TOTP) y `createSupabaseIdentityAdmin`, el único adaptador con la clave secreta (crea cuentas confirmadas sin contraseña). Comandos `pnpm platform:add-operator <correo>` y `pnpm platform:provision <archivo.json>`.
- Panel:
  - `/plataforma`: verificación en dos pasos (enrolamiento con QR y verificación), lista de municipios con estado y propietario, «Poner en línea» / «Suspender». Para quien no es operador, no existe (404).
  - `/plataforma/nuevo`: alta con identificador y dirección sugeridos a partir del nombre.
  - Inicio: invitaciones pendientes con «Aceptar»; los municipios en preparación ya se pueden configurar (marca) antes de salir en línea.
  - `/o/{slug}/miembros`: invitar, cambiar rol y quitar acceso (con confirmación).
  - ESLint: la clave secreta solo se puede importar desde `src/server/identity-admin.ts`.
- Tests: 190 unitarios (core 125, db 42, web 17, config 6) + 12 de integración + 169 pgTAP (54 nuevos) + e2e de portales.
- **Ensayo ZC-01 en CI:** el operador entra con código por correo, enrola TOTP con un código real, da de alta «Ensayo ZC-01», su propietaria acepta, el operador lo pone en línea y el portal `zc-ensayo.localhost` responde desde el mismo build, sin tocar código ni variables de entorno.
- Verificado localmente de punta a punta en el navegador (MFA, alta, aceptación, puesta en línea, miembros, editor sin acceso a `/miembros` ni `/plataforma`).

**Desviaciones:**

- No se envía un correo de invitación todavía (no hay proveedor de correo transaccional). La persona invitada entra al panel con su correo, recibe el código de acceso habitual y ve la invitación. Llega con el proveedor de correo.
- La exigencia de MFA a propietarios y administradores de municipios queda para más adelante; hoy solo la tiene el operador.

## Cómo verificarlo en tu PC

```powershell
git checkout main
git pull
pnpm install
pnpm db:reset      # aplica la migración nueva y crea el operador de prueba
pnpm dev
```

Necesitas una app de autenticación en el celular (Google Authenticator, Microsoft Authenticator…) y la hora del PC y del celular correctas.

1. Entra a http://app.localhost:3000 con `operador@rikuy.example.test` (código en Mailpit, http://127.0.0.1:54324) → «Administrar la plataforma».
2. «Configurar la app de autenticación» → escanea el QR → escribe el código de 6 dígitos → ves la lista de municipios.
3. «Dar de alta un municipio»: nombre `Ucureña` (el identificador `ucurena` y la dirección `ucurena.localhost` se completan solos), correo del propietario `propietario@ucurena.example.test` → «Dar de alta».
4. Cierra sesión y entra con `propietario@ucurena.example.test` → «Invitaciones pendientes» → «Aceptar». Ya puedes abrir Ucureña y preparar su marca.
5. Vuelve como operador (te pedirá el código de la app) → «Poner en línea». En unos segundos http://ucurena.localhost:3000 muestra el portal.
6. Como propietario de Ucureña, «Miembros» → invita a alguien, cambia su rol y prueba quitar tu propio acceso (lo impide: debe quedar un propietario).

`pnpm db:reset` borra lo creado. Para recrear Ucureña sin el formulario, guarda en `seed-assets/tenants/ucurena.json` (carpeta ignorada por git):

```json
{
  "displayName": "Ucureña",
  "slug": "ucurena",
  "hostname": "ucurena.localhost",
  "ownerEmail": "propietario@ucurena.example.test"
}
```

y ejecuta `pnpm platform:provision seed-assets/tenants/ucurena.json` (después: aceptar como propietario y poner en línea como operador).

**Producción (cuando despleguemos):** el operador real se registra una sola vez con `pnpm platform:add-operator <tu-correo>` usando las variables del proyecto de producción; nunca se guarda en el repositorio.

## Siguiente paso — P3 · Paso 1 (requiere autorización)

P1 está completa. Según el roadmap, P3 va antes que P2. Rama `feat/p3-step1-tenant-media`:

1. Storage por ambiente: buckets `media-originals` (privado) y `media-public` (solo derivados publicados), rutas `{tenant_id}/{asset_id}/{version}/{variante}` sin nombres de municipio, políticas de Storage por membresía y tests negativos (B no lee ni escribe medios de A).
2. Tablas `assets` y `asset_versions` (FK compuestas, estados `uploading → ready → published`), casos de uso `requestImageUpload` (URL firmada emitida por el servidor, el binario no pasa por el BFF) y `confirmImageUpload` (validación de tipo real, peso y dimensiones).
3. Primer uso: **logo del municipio** en la marca (`TenantPresentation` v2 con `logoAssetId`, migración expand) mostrado en el portal y en el manifest; el monograma queda como respaldo.
4. Panel: subir y reemplazar el logo desde «Marca del portal», con vista previa.
5. Tests: pgTAP de Storage, unitarios de validación, integración (subida firmada real contra Supabase local) y e2e del logo en el portal.

## Decisiones pendientes del usuario

- Ninguna bloqueante. El correo real del propietario de Ucureña se cambia más adelante desde «Miembros» (invitar el correo real como propietario y quitar el ficticio).
