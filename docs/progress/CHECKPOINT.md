# Checkpoint

> Archivo de continuidad. Se actualiza al final de cada paso. Cualquier sesión de trabajo empieza leyendo esto.

## Estado actual

- **Fase:** P3 — Portal y administración del primer vertical (P1 ✅ completa).
- **Último paso completado:** P3 · Paso 3 — destinos en el portal, SEO, QR e instalación (2026-10-18)
- **Rama del paso:** `feat/p3-step3-portal-destinations` → PR hacia `main`

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

### P3 · Paso 3 — destinos en el portal, SEO, QR e instalación ✅

- Base de datos (`20261018300000_p3_portal_destinations.sql`, solo expand): `portal_destinations` y `portal_destination` devuelven lo que el portal muestra, con el **tamaño en píxeles** de cada foto para reservar su espacio; solo revisiones selladas de municipios activos y fotos publicadas. `tenant_portal_host` da la dirección del portal a los miembros (para el enlace y el QR). 13 aserciones pgTAP nuevas (borradores, otro municipio, municipio suspendido, anónimos sin acceso a la dirección).
- `@rikuy/core`: `PORTAL_PATHS` (una sola fuente para enlaces, sitemap y QR), variantes responsivas a partir del tamaño original (480/960/1600 sin agrandar), «Cómo llegar» (Google Maps) y OpenStreetMap, JSON-LD `TouristAttraction` con coordenadas y serialización segura, `sitemap.xml` y `robots.txt` por portal, lector público con caché por municipio y destino (30 s, sin cachear errores). `loadDestinationEditor` devuelve la dirección pública del destino publicado.
- Portal:
  - `/destinos` (listado) y `/destinos/{dirección}` (ficha SSR): texto enriquecido, portada con prioridad alta y galería diferida (`srcset` + `sizes` + ancho/alto), «Cómo llegar», «Compartir» (menú del teléfono o copia del enlace), ubicación en texto y fecha de actualización.
  - Inicio con «Lugares para visitar» (hasta 6) y enlace «Destinos» en la cabecera; 404 dentro del portal con su marca.
  - SEO: título, descripción, canonical, Open Graph con la portada, `sitemap.xml`, `robots.txt` y datos estructurados.
  - Botón «Instalar» cuando el navegador lo ofrece (en iPhone/iPad, los dos pasos de Safari); la cabecera no cambia de alto al aparecer (sin CLS).
  - `/privacidad` y `/terminos`: plantilla de la plataforma con los datos del municipio, fiel a lo que el portal hace hoy (sin cuentas ni cookies de seguimiento; la ubicación aún no se pide).
- Panel, editor del destino: «Para visitantes» con «Ver en el portal» y **código QR** (PNG 1200 px y SVG) cuando está publicado.
- Correcciones del Paso 2:
  - El mapa del editor avisa cuando no puede cargar sus imágenes (sin conexión, bloqueadas o caché vieja) y recuerda que las coordenadas funcionan igual.
  - El editor ya no reenvía al servidor la copia local del formulario (con URLs firmadas) al guardar: solo el estado necesario.
  - Las listas escritas sin espacio (`-Naturaleza`, `•Comida`) se reconocen; `-5 °C` sigue siendo texto.
  - El aviso `refresh_token_not_found` que aparece en la terminal tras `pnpm db:reset` no es un error de Rikuy: la cookie del navegador apunta a una sesión que la base recreada ya no tiene; la librería de Supabase lo escribe en consola, borra la sesión y el panel pide iniciar sesión. Se va solo al volver a entrar.
- Tests: 287 unitarios (core 198, db 69, web 18, config 6) + 280 pgTAP + e2e de portales ampliado (listado, ficha, 404 de otro municipio y de borradores, sitemap, robots, páginas legales, portada responsiva de la integración).
- Lighthouse local (móvil, con datos del seed): rendimiento 96–99, accesibilidad, buenas prácticas y SEO 100 en inicio, listado y fichas de los dos municipios; CLS ≤ 0,006.

**Desviaciones:**

- Fotos con `<img srcset>` sobre derivados ya optimizados en vez de `next/image` (evita un segundo redimensionado); las URLs son versionadas e inmutables.
- Las páginas del portal se renderizan por petición con una caché corta por instancia; la caché de CDN por municipio y versión llega con Lighthouse CI y los previews de Vercel (Paso 7).
- El portal de un municipio en preparación no está en línea: el panel muestra el QR con un aviso de que funcionará cuando lo esté.

## Cómo verificarlo en tu PC

```powershell
git checkout main
git pull
pnpm install       # instala qrcode
pnpm db:reset      # aplica la migración nueva y el seed
pnpm dev
```

1. Abre http://demo-norte.localhost:3000: aparece «Lugares para visitar» con «Mirador del Valle». En la cabecera, «Destinos».
2. Entra a la ficha: texto con formato, «Cómo llegar» (abre Google Maps con el punto) y «Compartir» (en la computadora copia el enlace). Si tiene fotos, la portada y la galería se ven nítidas en el celular y en la computadora.
3. Prueba que no hay fugas: http://demo-norte.localhost:3000/destinos/laguna-espejo (es de Demo Sur) y …/destinos/feria-de-los-domingos (borrador) muestran «No encontramos esta página».
4. Mira http://demo-norte.localhost:3000/sitemap.xml y /robots.txt, y al pie «Privacidad» y «Términos de uso».
5. En el panel (http://app.localhost:3000) como `owner@demo-norte.example.test`, abre un destino publicado: a la derecha, «Para visitantes» con «Ver en el portal» y el código QR (escanéalo con el celular si está en tu red, o descarga PNG/SVG).
6. Publica un destino nuevo con portada y galería: aparece en el portal en menos de 30 segundos.
7. En Chrome (o Edge), si el navegador lo ofrece, aparece «Instalar» junto a «Destinos».
8. Opcional: en el editor escribe una lista como `-Naturaleza` (sin espacio) y mira la vista previa.

## Siguiente paso — P3 · Paso 4 (requiere autorización)

Rama `feat/p3-step4-events`:

1. Base de datos: `event` como nuevo tipo de contenido con revisiones (mismo modelo que destinos), inicio y fin con **zona horaria del municipio**, todo el día o con hora, lugar (destino existente o coordenadas propias), portada; RPC por intención y lecturas públicas que **no listan eventos terminados** sin intervención de nadie.
2. Panel: «Agenda» con lista (próximos / pasados / borradores), editor con fechas y horas validadas (fin ≥ inicio), reutilizando texto, fotos, ubicación e historial.
3. Portal: `/agenda` con los próximos eventos agrupados por mes, ficha del evento (fecha legible en la hora local, «Añadir al calendario» `.ics`, «Cómo llegar», compartir, QR en el panel), sección en el inicio y en el sitemap; datos estructurados `Event`.
4. Tests: pgTAP (vigencia por zona horaria, aislamiento, borradores), unitarios de fechas, e2e de agenda en los dos municipios y un evento vencido que desaparece solo.

## Decisiones pendientes del usuario

- Ninguna bloqueante. El correo real del propietario de Ucureña se cambia más adelante desde «Miembros» (invitar el correo real como propietario y quitar el ficticio).
