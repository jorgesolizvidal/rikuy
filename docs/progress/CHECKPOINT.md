# Checkpoint

> Archivo de continuidad. Se actualiza al final de cada paso. Cualquier sesión de trabajo empieza leyendo esto.

## Estado actual

- **Fase:** P3 — Portal y administración del primer vertical (P1 ✅ completa).
- **Último paso completado:** P3 · Paso 2 — destinos con revisiones, ubicación y fotos (2026-10-18)
- **Rama del paso:** `feat/p3-step2-content-items` → PR hacia `main`

## Historial

### P1 · Paso 1 — base del repositorio ✅

Monorepo pnpm (`apps/web`, `apps/worker`, `packages/core|db|ui|config`), TypeScript strict, ESLint con regla de capas, Prettier, CI (format, lint, typecheck, test, build, gitleaks), `.env.example`, documentación base y ADR-019/020.

### P1 · Paso 2 — Supabase local y esquema P1 ✅

Migración `20261017140000_p1_foundation.sql` (tenants, tenant_domains, memberships, tenant_config_versions, audit_events) con FK compuestas, invariantes en la base, RLS por membresía actual, grants mínimos y `resolve_tenant_by_host` como única entrada anónima. 74 aserciones pgTAP en CI y en local. Seed sintético `demo-norte` / `demo-sur`.

### P1 · Paso 3 — resolución de tenant por host ✅

`normalizeHost` / `classifyHost`, contrato `TenantContext`, caso de uso `resolvePortalTenant` (found · redirect · not_found · unavailable) con caché por instancia, adaptador RPC en `@rikuy/db` y `src/proxy.ts` (solo lee `Host`, elimina cabeceras internas entrantes, reescribe a `/admin`, `/platform` o `/portal/{host}`; 404 `noindex`, 503 `Retry-After`, 308 alias → canónico, 400 host inválido).

### P1 · Paso 4 — autenticación del panel de administración ✅

Inicio de sesión en el host de admin con código de 6 dígitos o enlace mágico (BFF con cookies host-only `HttpOnly`/`SameSite=Lax`), sin registro público y sin enumeración de cuentas; lista de municipios y `/o/{slug}` con membresía revalidada en cada request (revocar quita el acceso al instante); logout solo `POST` con verificación de `Origin`. Seed con 4 usuarios sintéticos. Job de CI con la pila real de Supabase (GoTrue + PostgREST + Mailpit). Desviaciones: usuarios del seed en SQL (no Auth Admin API); enrolamiento MFA y operador de plataforma diferidos.

**Corrección posterior (`fix/admin-login-redirect`, PR #4):** `redirect()` dentro de una Server Action hacía que Next renderizara el destino con un fetch interno a `localhost:3000`, saltándose la resolución por host (el panel mostraba la página de la plataforma tras iniciar sesión). Ahora la acción devuelve estado y el navegador navega; ESLint prohíbe `redirect` en `actions.ts` (CONTRIBUTING §1.2).

### P1 · Paso 5 — marca white-label versionada ✅

Contrato `TenantPresentation` (identidad, tema con contraste WCAG AA, contacto, redes, SEO) versionado en `tenant_config_versions`: borrador con concurrencia optimista, publicación en una transacción (sellar + puntero + auditoría) y lectura anónima solo de la versión activa sellada; la base revalida la forma del JSON. Portal con tema por variables CSS, SEO por tenant, `manifest.webmanifest` e íconos generados; editor de marca con vista previa en `/o/{slug}/configuracion`. E2E en CI: dos marcas en un mismo build.

### P1 · Paso 6 — alta de municipios, invitaciones y miembros ✅

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

### P3 · Paso 1 — medios por municipio y logo en la marca ✅

- Base de datos (`20261018100000_p3_tenant_media.sql`, solo expand):
  - Buckets `media-originals` (privado, 10 MB, PNG/JPEG/WebP) y `media-public` (solo derivados publicados, WebP/PNG). Rutas `{tenant_id}/{asset_id}/{versión}/{archivo}`, sin nombres de municipio.
  - Tablas `assets` y `asset_versions` (FK compuestas, estados `uploading → ready | rejected`, `published_at`), RLS de lectura por membresía.
  - Políticas de Storage: una persona solo puede escribir **el original exacto** de una versión `uploading` que ella pidió y para la que su rol alcanza (logo: propietario/administrador); los originales los leen solo miembros del municipio. Sin update/delete para personas.
  - `create_image_upload` (límite de 20 subidas pendientes por hora y municipio), y solo para el servidor: `media_complete_upload`, `media_reject_upload`, `media_publish_version`.
  - La marca acepta `logo: { assetId, version }` (nunca una URL). Guardar exige que la versión exista, sea del mismo municipio y esté lista; publicar exige además que el logo esté publicado.
- `@rikuy/core`: identificación de imágenes por sus bytes (PNG, JPEG, WebP; SVG rechazado), reglas del logo (≤ 2 MB, 64–4096 px), casos de uso `requestLogoUpload` / `confirmLogoUpload`; `publishBranding` publica los derivados del logo antes que la marca.
- `@rikuy/db`: repositorio de medios con la sesión del usuario, `createSupabaseMediaAdmin` (clave secreta, aislado en `src/server/media-admin.ts`; ESLint lo impide en cualquier otro módulo) y procesador con sharp (máx. 512 px, WebP + PNG, sin EXIF/GPS, rechaza archivos corruptos y bombas de descompresión).
- Panel, «Marca del portal»: subir, reemplazar y quitar el logo, con mensajes claros (tipo, peso, tamaño, archivo que no es lo que dice ser) y vista previa. El archivo va directo del navegador a Storage con una URL firmada de un solo uso; el servidor solo revisa.
- Portal: logo en la cabecera (las iniciales quedan como respaldo), `og:image` y los íconos del portal (favicon, Apple, PWA) generados a partir del logo.
- Tests: 224 unitarios (core 149, db 51, web 18, config 6) + 210 pgTAP (41 nuevos) + integración con Storage real (subida firmada, rechazo de un HTML disfrazado de PNG, aislamiento entre municipios y anónimos, editor sin permiso) + e2e del logo en el portal (`--logo`).
- Verificado localmente en el navegador: archivo falso y logo diminuto rechazados, logo válido publicado, visible en el portal y en el ícono, Demo Sur sin cambios, editor sin botón activo, «Quitar logo» vuelve a las iniciales.

**Desviaciones:**

- Las imágenes se procesan en el momento de confirmar la subida (sin cola de trabajos): suficiente para logos e imágenes simples; panoramas y GLB llegan con P2.
- Una versión de logo rechazada o abandonada queda registrada sin binario; la limpieza programada de versiones huérfanas llega con los jobs de P2.

### Revisión de paridad con el sistema anterior (documentación) ✅

Revisión de solo lectura de la auditoría (`auditoria-saas`, 01–14) y del código del sistema anterior. Resultado en [paridad funcional](../paridad-funcional.md): cada capacidad del sistema anterior con su fase en Rikuy, los fallos que no se repiten y mejoras propuestas.

- Faltaba en el roadmap la **ubicación del visitante**: nuevo P3 · Paso 6 en tiempo real ([ADR-021](../adr/ADR-021-visitor-location.md)); las coordenadas de los destinos entran en el Paso 2 (ya previstas en el esquema piloto de la auditoría).
- El asistente del visitante queda detallado en P5 con pasos ([ADR-022](../adr/ADR-022-tourist-assistant.md)): una sola conversación (portal + tours), «qué hay cerca», «plan para hoy», «ruta sugerida», español/inglés y **voz** (adelantada desde E3).
- Decisión del usuario: el nombre del asistente es dato de la marca de cada municipio; **«Chaski» es el de Ucureña** y no aparece en el código.
- P3 · Paso 3 suma «Cómo llegar», compartir, QR por destino, botón «Instalar» y páginas de privacidad y términos por municipio.

### P3 · Paso 2 — destinos con revisiones, ubicación y fotos ✅

- Base de datos (`20261018200000_p3_content_items.sql`, solo expand):
  - PostGIS en el esquema `extensions`. `content_items` (identidad + dirección única por municipio + punteros a borrador y versión publicada), `content_revisions` (revisiones numeradas; el borrador se edita con concurrencia optimista y al publicar queda **sellado e inmutable**) y `media_references` (portada y galería por versión de imagen, con **descripción obligatoria**).
  - Ubicación en latitud/longitud con un punto `geography` generado e índice GiST (ADR-021).
  - Texto enriquecido como AST permitido (párrafos, títulos 2–3, listas, negrita/cursiva, enlaces https); la base lo revalida, sin HTML.
  - RPC por intención: `create_content_item`, `save_content_draft`, `publish_content` (exige resumen, ubicación y fotos publicadas), `restore_content_revision` (volver a una versión sellada), `discard_content_draft`; lecturas anónimas `list_published_destinations` y `get_published_destination` solo de municipios activos.
  - Editores crean y guardan borradores y suben fotos; solo propietarios y administradores publican y vuelven a versiones anteriores. Todo queda en `audit_events`.
  - Seed: Demo Norte con un destino publicado en su versión 2 y un borrador nunca publicado; Demo Sur con uno publicado.
- `@rikuy/core`: contrato `richText` y formato de escritura tipo Markdown limitado (`## título`, `- lista`, `**negrita**`, `*cursiva*`, `[texto](https://…)`) que va y vuelve al AST sin pérdidas; `destinationDocument`; `parseCoordinates` (decimal y grados/minutos/segundos, como los copia Google Maps); casos de uso de destinos; perfiles de imagen comunes a logo y fotos.
- `@rikuy/db`: repositorio de contenido, lector público anónimo, derivados de fotos 480/960/1600 px WebP sin metadatos y firmas de vista previa en lote.
- Panel: «Destinos» en la página del municipio; lista con estado (borrador / publicado / con cambios); editor con vista previa del texto, ubicación (mapa Leaflet cargado bajo demanda, campos numéricos, pegar coordenadas, «usar mi ubicación actual»), portada y galería (varias fotos a la vez, reordenar, descripción obligatoria), guardar borrador, publicar, descartar borrador y historial con «Volver a esta versión». Aviso al salir con cambios sin guardar.
- `pnpm db:lint` revisa solo nuestros esquemas (`public`, `private`): PostGIS trae cientos de avisos propios en `extensions`.
- Tests: 280 unitarios (core 189, db 67, web 18, config 6) + 267 pgTAP (57 nuevos) + integración con Supabase real (borrador → publicar → editar → publicar → volver a la versión 1 sin tocar el resto; editor sin permiso de publicar; aislamiento entre municipios; imagen de otro municipio rechazada).
- Verificado en el navegador: crear con dirección sugerida (`plaza-central-de-nuflo`), enlace `http://` señalado con su línea, coordenadas pegadas, foto pequeña rechazada, descripción obligatoria, publicar, versión 2, volver a la 1, descartar borrador, analista en solo lectura y celular sin desbordes.

**Desviaciones:**

- La ficha pública del destino llega en el Paso 3 (este paso deja listas las lecturas públicas y su prueba).
- La dirección (`slug`) se elige al crear el destino y no se cambia todavía desde el editor: cambiarla rompería enlaces ya compartidos; llegará con redirecciones.
- El mapa del editor usa las teselas estándar de OpenStreetMap (uso ligero, con atribución); el portal elegirá proveedor en el Paso 5.

## Cómo verificarlo en tu PC

```powershell
git checkout main
git pull
pnpm install       # instala leaflet
pnpm db:reset      # aplica la migración (PostGIS, destinos) y el seed con destinos de ejemplo
pnpm dev
```

1. Entra a http://app.localhost:3000 con `editor.ambos@example.test` (código en Mailpit, http://127.0.0.1:54324) → Municipio Demo Norte → «Destinos». Verás «Mirador del Valle» (publicado) y «Feria de los domingos» (borrador).
2. Crea «Plaza Central»: la dirección se sugiere sola. En el editor escribe un resumen y un texto con `## Qué ver`, una lista con `- ` y algo en `**negrita**`; mira la vista previa.
3. Ubicación: en Google Maps, clic derecho sobre un lugar → copia las coordenadas → pégalas en «Pegar coordenadas» → «Usar». También puedes hacer clic en el mapa.
4. Sube una portada y una o dos fotos a la galería, escribe la descripción de cada una → «Guardar borrador». Como editor no ves «Publicar».
5. Cierra sesión y entra como `owner@demo-norte.example.test` → abre «Plaza Central» → «Publicar». Cambia el resumen → «Publicar» otra vez (versión 2).
6. En «Historial de publicaciones», en la versión 1 → «Volver a esta versión» → confirmar: la versión 1 vuelve a ser la publicada.
7. Opcional: en «Mirador del Valle» cambia el nombre → «Guardar borrador» → «Descartar borrador y volver a lo publicado».

La ficha pública del destino en el portal llega con el Paso 3.

## Siguiente paso — P3 · Paso 3 (requiere autorización)

Rama `feat/p3-step3-portal-destinations`:

1. Portal: listado de destinos y ficha SSR (`/destinos` y `/destinos/{slug}`) con el texto enriquecido, portada y galería responsivas (`srcset` 480/960/1600, dimensiones reservadas, carga diferida) y caché por municipio y versión publicada.
2. SEO por municipio y destino: título, descripción, canonical, Open Graph con la portada, `sitemap.xml`, `robots.txt` y datos estructurados (`TouristAttraction` con coordenadas).
3. «Cómo llegar» (abre la app de mapas con las coordenadas), «Compartir» y **código QR por destino** en el panel para carteles en el lugar.
4. Botón «Instalar» del portal y páginas de privacidad y términos por municipio (contenido del municipio, plantilla de la plataforma).
5. Tests: e2e de listado y ficha en los dos municipios (sin fugas), Lighthouse ≥ 90 en inicio y ficha con datos del seed, accesibilidad de la galería.

## Decisiones pendientes del usuario

- Ninguna bloqueante. El correo real del propietario de Ucureña se cambia más adelante desde «Miembros» (invitar el correo real como propietario y quitar el ficticio).
