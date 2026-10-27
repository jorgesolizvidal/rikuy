# Checkpoint

> Archivo de continuidad. Se actualiza al final de cada paso. Cualquier sesión de trabajo empieza leyendo esto.

## Estado actual

- **Fase:** P4 ✅ (tours 360°, hotspots y GLB). P1, P2 y P3 ✅. Siguiente: ★ Hito Demo / Portafolio.
- **Último paso completado:** P4 · Paso 7 — contratos de los tours y medición (2026-10-27)
- **Rama:** `feat/p4-step7-tour-contracts` → PR hacia `main`

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

### P3 · Paso 4 — eventos y agenda ✅

- Base de datos (`20261019000000_p3_event_kind.sql` y `20261019000100_p3_events.sql`, solo expand):
  - `event` como nuevo tipo de contenido con el mismo modelo de revisiones que los destinos (borrador → publicar → volver a una versión).
  - Fecha **en hora local del municipio** (`starts_local`/`ends_local`, todo el día o con hora; en todo el día, el último día cuenta entero). Se convierte a instantes con la zona horaria del municipio al leer. La base rechaza fechas que no existen (30 de febrero, 24:00), un fin antes del inicio y eventos de más de un año.
  - Lugar opcional: un destino del mismo municipio (otro municipio o un evento → rechazado). El evento guarda sus propias coordenadas.
  - `save_content_draft` y `publish_content` validan según el tipo; publicar un evento exige resumen, fecha y ubicación.
  - `list_content_events` (panel) y, anónimas, `portal_events` (solo los que **no terminaron**, sin que nadie los despublique) y `portal_event` (también los terminados, marcados como tales).
  - Las zonas horarias de los municipios se validan al guardarlas.
  - Seed: Demo Norte con un evento próximo en el Mirador, uno que ya terminó y un borrador; Demo Sur con un evento de todo el día. Las fechas son relativas al día en que se carga el seed.
  - 34 aserciones pgTAP nuevas (validación, permisos, lugar, terminado por zona horaria —una hora atrás en Bolivia sigue «en el futuro» si se leyera como UTC—, todo el día hasta medianoche, aislamiento, suspensión).
- `@rikuy/core`: contrato `eventDocument` y `eventSchedule`, fechas legibles en español sin desfases (`formatEventSchedule`, «Sábado, 2 de noviembre de 2026, 19:00–22:00»), agrupación por mes, casos de uso de eventos (`createEvent`, `loadAgenda`, `saveEventDraft`, `publishEvent`) sobre un flujo editorial común a destinos y eventos (`editing.ts`), `.ics` (RFC 5545: instantes UTC, fechas en todo el día, texto escapado y líneas plegadas), JSON-LD `Event` y sitemap con la agenda.
- Panel: «Agenda» en la página del municipio, con lista en tres grupos (próximos y en curso, sin fecha, pasados) y nuevo evento. Editor con los mismos campos de texto, fotos, ubicación e historial que los destinos, más «Fecha y hora» (todo el día, vista previa de cómo se mostrará) y «Lugar» (al elegir un destino se copia su ubicación). QR y «Ver en el portal» al publicar.
- Portal: «Agenda» en la cabecera; `/agenda` agrupada por mes; ficha del evento con fecha y lugar enlazado, «Cómo llegar», **«Añadir al calendario»** (.ics), «Compartir», fotos y JSON-LD. Un evento terminado conserva su página con el aviso «Este evento ya terminó» y sale de buscadores y del sitemap. «Próximos eventos» en el inicio.
- Corrección del mapa del editor: las imágenes del mapa ahora envían el origen del panel a OpenStreetMap (`referrerPolicy: strict-origin`), que es lo que exige su política. Antes la cabecera `Referrer-Policy: same-origin` del panel las dejaba sin `Referer` y respondían «403 Access blocked». Verificado que cada petición del mapa lleva `http://app.localhost:3000/`.
- Otras mejoras: los campos de latitud y longitud se actualizan cuando la ubicación cambia desde fuera (al elegir un lugar). En celulares, la navegación del portal va en su propia fila, así el nombre del municipio no se aprieta cuando aparece «Instalar».
- CI: el lint de SQL del CI (Postgres 17) rechazaba la validación de fechas declarada `IMMUTABLE`, cuando depende de la configuración de la sesión: ahora es `STABLE`. Si el lint vuelve a fallar, sus hallazgos aparecen como anotaciones del job (los logs no siempre se pueden descargar).
- Tests: 308 unitarios (core 211, db 73, web 18, config 6) + 314 pgTAP + integración de eventos con Supabase real + e2e de portales con agenda (126 verificaciones).
- Lighthouse local (móvil): inicio, agenda y fichas de evento y destino con rendimiento 95–98, accesibilidad, buenas prácticas y SEO 100, CLS 0.

**Desviaciones:**

- Un evento tiene una sola ocurrencia, como dice el roadmap. Los eventos que se repiten (cada domingo, cada año) quedan para más adelante.
- La hora se escribe en la hora del municipio y no se muestra la zona horaria. Para visitantes de otro país, «Añadir al calendario» la convierte a la hora de su teléfono.
- El mapa pequeño en cada ficha queda propuesto para el Paso 5, junto con el mapa del portal.

### P3 · Paso 5 — mapa del portal ✅

- Decisión del usuario: **OpenFreeMap con MapLibre** para el portal ([ADR-023](../adr/ADR-023-portal-map-provider.md)); gratis, sin clave y con uso comercial permitido. El estilo es configuración (`NEXT_PUBLIC_MAP_STYLE_URL`), así que cambiar de proveedor no toca código. El panel sigue con Leaflet + OpenStreetMap. También pidió el mapa pequeño en cada ficha.
- Base de datos (`20261019100000_p3_portal_map.sql`, solo expand): `portal_map_places` devuelve los destinos publicados y los eventos que no terminaron **dentro de una zona** (oeste, sur, este, norte), por capas y con tope (≤ 500), usando el índice GiST del punto. Rechaza zonas inválidas. `portal_map_extent` da la zona que los contiene a todos. Solo municipios activos. 16 aserciones pgTAP nuevas (zona, capas, tope, eventos terminados, borradores, otro municipio en el mismo punto, suspensión).
- `@rikuy/core`: zonas (`parseBoundingBox`, redondeo a una cuadrícula de ~1 km para compartir caché, márgenes), lector del mapa con caché que recorta a la zona pedida, `PORTAL_PATHS.map`, `/mapa` en el sitemap.
- Portal:
  - **`/mapa`**: capas «Destinos» y «Eventos próximos», mapa con pines (botones con nombre accesible; al tocarlos se abre la ficha resumida con enlace) y, al lado, **la lista con los mismos lugares**, que se actualiza al mover el mapa (solo se piden los lugares de la zona visible, `GET /mapa/lugares?area=…`). Un evento en un destino comparte el punto: los pines se separan para poder tocar los dos. «Ver todos» vuelve a encuadrar todo.
  - **Mapa pequeño en cada ficha** de destino y evento, en la sección «Ubicación», con las coordenadas, «Ver en el mapa del municipio» (abre `/mapa` centrado ahí) y OpenStreetMap.
  - Si el mapa no puede cargar (sin WebGL o el servicio caído), la página lo dice y la lista sigue funcionando.
  - «Mapa» en la cabecera; la página de privacidad explica que las imágenes del mapa vienen de OpenFreeMap.
- Rendimiento: MapLibre **no está en el bundle inicial** de ninguna página (verificado en el e2e) y se carga solo en `/mapa` y, en las fichas, cuando el visitante llega al mapa pequeño (al desplazarse o tocarlo). Su _worker_ se sirve desde `/vendor/maplibre-gl/6.11.2/` (copiado al compilar, fuera de git, caché inmutable).
- Corrección del Paso 4: en «Añadir al calendario», el lugar se escribe «Mirador del Valle · Municipio…» (antes la app de calendario de algunos celulares mostraba «\,»).
- Tests: 315 unitarios (core 216, db 75, web 18, config 6) + 330 pgTAP + integración del mapa con Supabase real + e2e de portales (155 verificaciones: `/mapa` y `/mapa/lugares` por municipio sin fugas, zona inválida rechazada, MapLibre fuera del bundle inicial de inicio y ficha, _worker_ servido con caché inmutable).
- Verificado en el navegador (con un estilo de prueba local, porque el entorno de pruebas no tiene internet): mapa con pines, ventana del pin con el ratón y con el teclado, capas, petición por zona al mover el mapa, mapa pequeño al desplazarse, aviso cuando el mapa falla, celular sin desbordes.
- Lighthouse local (móvil): inicio 98, destino 95–99, evento 99 (accesibilidad, buenas prácticas y SEO 100, CLS 0). `/mapa` ~60–70 por el arranque del mapa (ver [presupuesto](../performance-budget.md)).

**Desviaciones:**

- `/mapa` no tiene todavía un objetivo de Lighthouse propio: el mapa es el contenido de la página y su arranque pesa en un celular simulado lento. Se mide en dispositivos reales en el Paso 7.
- El mapa pequeño se carga al llegar a él **y** al usar la página (desplazarse o tocar), o con su botón «Mostrar el mapa», para no cargar el mapa al abrir la ficha.
- OpenFreeMap no ofrece garantía de servicio; si un municipio la exige, se cambia el estilo por uno pagado o propio (ADR-023).

### P3 · Paso 6 — ubicación del visitante en tiempo real ✅

- Todo se calcula **en el dispositivo** ([ADR-021](../adr/ADR-021-visitor-location.md)): la posición no llega al servidor ni se guarda.
- Base de datos (`20261019200000_p3_visitor_location.sql`, solo expand): la marca acepta `visitors.nearbyRadius` (radio de «Estás cerca de…», 50–1000 m; sin él, 150 m). 15 aserciones pgTAP nuevas (límites, decimales, texto, claves extra, guardado por la RPC y ninguna columna que guarde posiciones).
- `@rikuy/core` (`domain/geo/proximity`): distancia en línea recta (haversine), tiempos estimados a pie y en auto (con factor de desvío y rotulados como estimación), formato en español («80 m», «1,2 km», «1.250 km»), orden por cercanía, filtro de lecturas que no cambian nada (< 10 m), «Estás cerca de…» con margen para no repetir el aviso en el borde e ignorando lecturas imprecisas, y el círculo de precisión.
- Portal:
  - **«Usar mi ubicación»**: el permiso se pide solo al pulsarlo. `watchPosition` mientras la página está a la vista; al ocultar la pestaña se detiene y al volver sigue. «Dejar de usar mi ubicación» lo apaga.
  - En la pestaña solo se recuerda que se activó (no la posición), para que la página siguiente siga sin preguntar, y solo si el navegador dice que el permiso está concedido.
  - **`/mapa`**: punto azul con círculo de precisión, «Seguirme» (arrastrar el mapa lo apaga) y la lista del más cercano al más lejano con su distancia. Si el visitante está lejos del municipio, se dice a qué distancia está y el mapa no se mueve.
  - **Ninguna petición lleva la posición:** mientras la vista está dentro de la zona del municipio, el navegador filtra los lugares que ya tiene; con «Seguirme» nunca se pregunta al servidor por la zona.
  - **Destinos**: «Ordenar por cercanía» y distancia en cada tarjeta. **Agenda**: distancia en cada evento y «Ordenar: por fecha / por cercanía». **Fichas**: «A 790 m en línea recta · ~14 min a pie · ~2 min en auto (estimado)» en «Ubicación». El inicio muestra distancias si ya se activó en la pestaña.
  - **«Estás cerca de…»**: aviso al entrar en el radio de un destino (mapa, destinos, agenda y fichas), con enlace a su ficha; uno por lugar hasta que el visitante se aleja.
  - Mensajes para permiso denegado, señal no disponible, http (la ubicación exige https) y navegadores sin ubicación; sin permiso todo funciona igual.
  - Página de privacidad actualizada: qué se usa, que no sale del dispositivo, que solo funciona con la página abierta, qué se recuerda en la pestaña y que las imágenes del mapa de esa zona se piden a OpenFreeMap.
- Panel, «Marca del portal»: nuevo apartado «Visitantes» con el radio del aviso «Estás cerca de…».
- Seed: Demo Norte suma «Plaza principal», a ~800 m del Mirador, para probar el orden por cercanía y el aviso.
- Correcciones: el mapa pequeño de las fichas se salía de la pantalla en celulares angostos (390 px); los avisos «Image … could not be loaded» del estilo del mapa ya no aparecen.
- Tests: 341 unitarios (core 232, db 75, web 28, config 6) + 345 pgTAP + e2e de portales (159 verificaciones) + **e2e RC-06 en un navegador real** (29 verificaciones, en CI con el Chrome del runner): permiso concedido, denegado y desconocido (sin responder y sin Permissions API); nada se pide al cargar; sin permiso todo funciona en el orden del municipio; seguir sin pedir zonas al servidor; ninguna petición ni almacenamiento del navegador contiene la posición.
- Lighthouse local (móvil): inicio 95, destinos 97, ficha de destino 96, agenda 98, ficha de evento 97 (accesibilidad, buenas prácticas y SEO 100, CLS 0).

**Desviaciones:**

- El aviso «Estás cerca de…» es para destinos (como dice el ADR); los eventos muestran su distancia, sin aviso propio.
- No hay aviso en segundo plano (ni notificaciones push): solo con la página abierta, como prevé el ADR.
- En el celular hace falta https para probar la ubicación (los navegadores no la dan en `http://192.168…`). Se podrá probar en los previews de Vercel del Paso 7, o con un túnel https si se quiere antes.

**Corrección posterior (`fix/visitor-location-reveal`):** al activar la ubicación lejos de los lugares del municipio (por ejemplo, a 33 km), el mapa no se movía y el punto quedaba fuera de la vista. Ahora el mapa encuadra a la vez al visitante y a los lugares (o solo al visitante si está a más de 300 km), «Seguirme» se ofrece también en ese caso y, en el celular, la página baja hasta el mapa. Ese encuadre tampoco pide zonas al servidor. El e2e RC-06 lo comprueba (35 verificaciones: el punto queda dentro del mapa, cerca, lejos y en un celular).

### P3 · Paso 7 — Lighthouse CI y contratos de regresión ✅

- Decisión del usuario: el CI mide en **GitHub Actions** (compilación de producción + Supabase local con el seed), sin costo. Vercel, Supabase en la nube y la caché de CDN pasan al **Paso 8 (despliegue)**: la organización gratuita de Supabase ya tiene sus 2 proyectos activos y Vercel está en el plan Hobby (uso no comercial).
- Nuevo job de CI **«Contracts (RC-09/10/11/12) · Lighthouse budget»**, en paralelo con los demás, sobre una base limpia con solo el seed:
  - **Lighthouse** (`e2e/lighthouse.mjs`): inicio, destinos, ficha de destino, agenda, ficha de evento y mapa de los dos municipios, móvil con 4G y CPU ×4 simulados, mediana de 3 corridas. Los umbrales están en `apps/web/lighthouse-budget.json` (rendimiento ≥ 90, LCP ≤ 2,5 s, CLS ≤ 0,1, JS ≤ 170 KB; accesibilidad, buenas prácticas y SEO ≥ 95). El PR falla si una página lo rompe; la tabla sale en el resumen del job y los informes quedan como artefacto 14 días.
  - **Contratos en un navegador real** (`e2e/contracts.e2e.mjs`, 189 verificaciones), de la auditoría `14-regression-contracts-evals` (leída en modo solo lectura):
    - RC-09: sin desborde horizontal a 360, 390, 768 y 1280 px en 9 páginas por portal y 8 del panel (como propietario).
    - RC-10: axe sin hallazgos críticos ni graves (390 y 1280 px), «Saltar al contenido» con el primer Tab y foco visible, nada animado con «reducir movimiento», y en `/mapa` una fila de la lista por cada pin con nombre accesible.
    - RC-11: rastreo de todos los enlaces internos de cada portal y del panel, sin ninguno roto.
    - RC-12: título renderizado en el servidor, descripción, canonical en su propio dominio y Open Graph únicos por municipio y página; 404 con `noindex`; el panel con `X-Robots-Tag` y meta `noindex`.
  - Inicio de sesión del panel en el e2e con el código real que llega a Mailpit.
- **RC-15** (`rc15-access-matrix.int.test.ts`, en el job de integración): matriz propietario / editor / revocado / propietario de otro municipio / visitante sobre los datos privados de Demo Norte, por la Data API, las RPC y Storage. Las escrituras usan un número de edición viejo: quien tiene permiso choca con la concurrencia (PT409) y quien no, con la autorización (42501), sin cambiar nada del seed.
- Lo que encontraron las pruebas, ya corregido:
  - Las páginas del portal cargaban **35 KB de zod** que el navegador no usa (los componentes de ubicación importaban la entrada principal de `@rikuy/core`). Nueva entrada `@rikuy/core/geo` sin esquemas: JS inicial de **177–179 KB a 142–144 KB**.
  - La tabla de «Miembros» desbordaba celulares (las etiquetas ocultas de la tabla se salían de su caja): ahora se desplaza dentro de su propio recuadro, que también se recorre con el teclado.
  - El color de acento del panel tenía un contraste de 4,48:1 (mínimo 4,5): ahora `#9e4723` (5,6:1).
  - El mapa del editor estaba oculto para lectores de pantalla pero recibía el foco: ahora es una región con nombre que remite a los campos de coordenadas.
  - La página 404 del portal tenía dos etiquetas `robots` contradictorias; el panel no tenía «Saltar al contenido».
- Lighthouse local (móvil, mediana de 3): inicio 98, destinos 98, fichas 98–100, agenda 98 en los dos municipios, CLS 0. `/mapa` 66–69 (sin umbral de rendimiento hasta medirlo en un celular real).

**Desviaciones:**

- Las mediciones son de laboratorio en el runner de GitHub, no en previews de Vercel ni con usuarios reales: eso llega en el Paso 8 (previews + Speed Insights).
- La caché de CDN por municipio, idioma y versión queda para el Paso 8: solo tiene sentido con el CDN de Vercel delante.
- RC-10 es una revisión automática más teclado básico; no equivale a declarar conformidad WCAG completa (como advierte la propia auditoría).

### P3 · Paso 8 — despliegue ✅

- Decisiones del usuario (2026-10-19): Supabase en **São Paulo** (`sa-east-1`); direcciones gratuitas **`*.vercel.app`**; Lighthouse en Vercel **sobre producción tras cada merge** (los PR siguen bloqueados por el job del Paso 7). Pausó `el-chavo-pos` para liberar el proyecto gratuito y permitió `*.vercel.app` y `*.supabase.co` en mi entorno.
- Proyecto Supabase `rikuy` creado (ref `jltzysyxqureudfavgpj`, São Paulo, plan gratuito); tablas y demo cargadas en la parte 2.
- **Caché por municipio ([ADR-024](../adr/ADR-024-portal-page-cache.md)):** las páginas del portal se generan en la primera visita y se guardan por host (ISR, `revalidate = 120`); publicar contenido o la marca, o volver a una versión, invalida solo las páginas de ese municipio. La página resuelve su municipio desde el host de la ruta (registro sin caché) en lugar de la cabecera interna. `/mapa` sigue dinámico. Las lecturas de destinos y eventos ya no tienen caché por instancia.
- **Speed Insights** solo en Vercel (`VERCEL=1`); `_vercel/` fuera del proxy; página de privacidad actualizada.
- Workflows nuevos: **«Deploy database»** (`supabase db push`, con seed opcional la primera vez; en cada merge a `main` con migraciones) y **«Lighthouse on production»** (tras cada merge a `main`, mismo `lighthouse-budget.json`; `e2e/lighthouse.mjs` acepta `LIGHTHOUSE_ORIGINS`).
- [`docs/deploy.md`](../deploy.md): configuración única de Supabase, GitHub y Vercel, y el primer despliegue. `supabase/demo/vercel-demo.sql` pasa la demo a `rikuy-demo-norte.vercel.app` y `rikuy-demo-sur.vercel.app`.
- Verificado local: publicar un lema se ve en la siguiente visita (MISS → página nueva) y el otro municipio conserva su caché (HIT); portales 159, ubicación 35 y contratos 189 verificaciones en verde.

**Desviaciones:**

- El conector de Vercel no tiene permiso de escritura en la cuenta: el proyecto Vercel lo crea el usuario desde el panel (pasos en `docs/deploy.md`).
- El correo incluido de Supabase solo envía códigos a miembros del equipo de la organización: para la demo se entra con un correo del equipo; para municipios reales hace falta SMTP propio.

**Parte 2 — puesta en marcha (2026-10-19/20):**

- El usuario configuró Supabase, GitHub y Vercel siguiendo `docs/deploy.md`. `rikuy.vercel.app` y `rikuy-admin.vercel.app` estaban tomados: quedaron **`rikuy-app.vercel.app`** (plataforma) y **`rikuy-app-admin.vercel.app`** (panel); la demo en `rikuy-demo-norte.vercel.app` y `rikuy-demo-sur.vercel.app`. Tras cambiar las variables de dominio hizo falta un _redeploy_ sin caché.
- «Deploy database» con seed, `vercel-demo.sql`, operador con `pnpm platform:add-operator` y propietario de los dos municipios de demo (ahora `supabase/demo/grant-demo-owner.sql`, con el correo como dato a reemplazar). Inicio de sesión con código, publicar → visible en la siguiente visita, `/plataforma` con TOTP y ubicación en el celular con https: verificados por el usuario.
- En producción, las páginas del portal salen de la caché de Vercel (`x-vercel-cache: HIT`) y el panel lleva `X-Robots-Tag: noindex`.
- Vercel no emite eventos de despliegue a GitHub: «Lighthouse on production» ahora corre en cada push a `main` y **espera a que producción sirva ese commit** (nueva cabecera `X-Rikuy-Version`). Primera corrida manual: en verde.
- Corrección del medidor: Lighthouse reutilizaba un mismo Chrome entre páginas y los scripts en caché hacían ver algunas páginas con 16–26 KB. Ahora cada corrida usa un navegador nuevo.
- Lighthouse sobre producción (móvil, caché vacía, mediana de 3): inicio 99, destinos 97–99, fichas 99–100, agenda 99 en los dos municipios; LCP 1,2–1,7 s; JS 149–151 KB (incluye Speed Insights); accesibilidad, buenas prácticas y SEO 100; CLS 0. `/mapa` 68.

**Desviaciones:**

- Los previews por PR no se miden (sus direcciones no identifican un municipio, decisión del usuario): los PR los bloquea el job del Paso 7 y producción se mide tras cada merge.
- Correo: el servidor incluido de Supabase envía códigos solo a miembros del equipo y pocos por hora. Para municipios reales hace falta SMTP propio.
- Vercel Hobby es para uso no comercial: antes de un municipio real, plan Pro.

**Corrección posterior (`fix/lighthouse-production`):** la primera corrida automática de «Lighthouse on production» tras el merge falló en 11 s sin informes. Al repetirla con el medidor mejorado, el motivo fue que `rikuy-demo-sur.vercel.app/destinos` respondió **503**: las funciones corrían en Washington (`x-vercel-id: iad1::iad1::…`) y no en São Paulo, así que cada consulta al registro de municipios cruzaba el continente y, con la función en frío, superaba el límite de 2 s del proxy.

- `apps/web/vercel.json` fija la región **gru1** (junto a la base) en el código, en vez de depender del panel.
- El registro de municipios repite **una vez** la consulta si el fallo es transitorio (red, tiempo agotado o 5xx); un 4xx no se repite. 4 tests nuevos.
- El medidor reintenta una corrida fallida una vez, visita cada página antes de medir (para que la CDN regenere la versión nueva), muestra la salida de Chrome si no arranca y deja el motivo como **anotación** en GitHub, que se puede leer aunque el log no se pueda descargar. El workflow comprueba qué Chrome hay en el runner.

### P2 · Paso 1 — ledger de trabajos durables ✅

- Pasos de P2 en el [roadmap](../roadmap.md), confirmados por el usuario: 1 ledger, 2 ejecutor en Vercel, 3 panoramas, 4 GLB, 5 cuotas.
- Base de datos (`20261020000000_p2_job_ledger.sql`, solo expand), según el contrato de ADR-014 con el ajuste de ADR-019:
  - `background_jobs` (outbox + ledger, idempotente por municipio + tipo + clave lógica, _payload_ ≤ 8 KB), `job_attempts` (historial sin borrado ni cambios en intentos cerrados), `job_kinds` y `job_queues` (intentos, arrendamiento, presupuesto de tiempo, concurrencia global por cola y por municipio). RLS sin políticas: nadie toca las tablas, ni siquiera `service_role`.
  - Rol **`rikuy_worker`**: sin permisos sobre tablas, solo el esquema `worker_api` (`claim_jobs`, `heartbeat`, `complete_job`, `fail_job`, `reap_expired_jobs`). Se crea **sin permiso de iniciar sesión**; ninguna clave de la API puede convertirse en él.
  - Reclamo atómico con **arrendamiento y número de _fencing_** creciente; latidos, puntos de control y resultados solo con el número vigente y el arrendamiento vivo. Arrendamientos vencidos → intento registrado como perdido y el trabajo vuelve a la cola (o a fallidos sin intentos). Reintentos con espera exponencial (5 s → 5 min, con variación aleatoria, `Retry-After` hasta 1 h); fallos permanentes y agotados → **cola de fallidos**. Presupuesto de tiempo por intento. Equidad: concurrencia por cola y por municipio al reclamar, atendiendo primero a quien tiene menos en curso. Los mensajes de error se recortan en el `?` (sin URLs firmadas).
  - Para operadores con segundo factor: resumen (con el reloj de la base), lista sin _payload_, intentos, **reintento** (ronda nueva, auditado) y **sonda** `system.probe` (normal, falla una vez, falla siempre; auditada).
  - Seed: una sonda terminada (Demo Norte) y una fallida tras 3 intentos (Demo Sur).
- `@rikuy/core`: contratos de trabajos, `JobFailure` (transitorio / permanente, mensajes sin URLs firmadas), `runClaimedJob` (latido, pérdida del arrendamiento, presupuesto, sin reportar si el ledger no responde) y `drainJobs` (presupuesto de tiempo, concurrencia, solo los tipos que sabe procesar); casos de uso del panel; ledger en memoria para pruebas (`@rikuy/core/testing`).
- `apps/worker`: procesador `system.probe` y registro de procesadores.
- `@rikuy/db`: `createJobAdminRepository` (sesión del operador) y, aparte, `@rikuy/db/worker` con `createPostgresJobLedger` (`postgres.js` 3.4.9, conexión directa como `rikuy_worker`, apta para el _pooler_). El panel no carga esa entrada.
- Panel: **`/plataforma/trabajos`** (enlace desde «Plataforma»): resumen, alarma si hay trabajos listos esperando más de 5 min, filtros por estado, último error, «Reintentar» con confirmación, «Ver intentos» y «Probar el ejecutor». Para quien no es operador no existe (404).
- [Runbook de trabajos](../jobs.md) y sección en la [arquitectura](../architecture.md).
- Tests: 367 unitarios (core 249, db 81, web 28, worker 3, config 6) + 416 pgTAP (71 nuevos, con casos negativos) + **D-01** contra PostgreSQL real en el job de integración (6 escenarios, varios ejecutores a la vez): un ejecutor que muere sin avisar, retomar desde el punto de control con el viejo bloqueado, encolar duplicados al mismo tiempo, fallidos y reintento, un municipio que satura la cola sin frenar a otro, límites del rol del ejecutor. 0 hallazgos de `plpgsql_check`.
- Verificado en el navegador (pila local simulada): operador con segundo factor, resumen, filtro «Fallidos», reintento con confirmación, sonda en la cola, historial de intentos, propietario de municipio → 404, sin desbordes a 360/390 px y axe sin hallazgos críticos ni graves.
- Lo que encontraron las pruebas, ya corregido: si avisar «terminado» al ledger fallaba por la red, el trabajo se marcaba como fallido y se reintentaba (ahora no se asume nada y el arrendamiento vence solo); la página de intentos daba 404 para un trabajo sin intentos; selectores que desbordaban el celular.

**Desviaciones:**

- `usage_buckets` (cuotas) pasa al Paso 5: su reserva se diseña junto con quien la consume (panoramas, GLB) y con su vista en el panel.
- Todavía no corre ningún ejecutor: lo que se pida (sondas, reintentos) espera en la cola hasta el Paso 2. Nada encola trabajos solo todavía.
- El ejecutor usa una conexión directa a PostgreSQL (rol propio) y no la Data API: es lo que permite no darle `service_role` (ADR-014).

### P2 · Paso 2 — ejecutor de trabajos en Vercel ✅

- Decisión del usuario (2026-10-24): **la base de datos despierta al ejecutor** ([ADR-025](../adr/ADR-025-job-runner-wake-up.md)), porque en Vercel Hobby el cron corre como mucho una vez al día.
- Base de datos (`20261024000000_p2_job_runner.sql`, solo expand):
  - `pg_net` y `pg_cron`. Un trigger en `background_jobs` avisa al ejecutor cuando un trabajo queda listo al escribirse (encolado o reintento a mano); la tarea `rikuy-job-runner` lo hace cada minuto de respaldo, solo si hay trabajo listo o un arrendamiento vencido. A lo sumo un aviso cada 10 s. `pg_net` envía después del `COMMIT`.
  - Dirección y secreto del aviso en **Supabase Vault** (`rikuy_job_runner_url`, `rikuy_job_runner_secret`); sin ellos no se llama a nadie. El secreto es propio del ejecutor, no la clave secreta de Supabase (la cola de `pg_net` es legible hasta que se envía).
  - **Primer trabajo real:** `media.expire_abandoned_upload`. La tarea diaria `rikuy-expire-abandoned-uploads` (07:17 UTC) encola una limpieza por cada imagen que sigue «subiendo» después de 24 h; `worker_api.abandoned_upload` y `mark_upload_abandoned` la inspeccionan y la rechazan con el arrendamiento del trabajo, contra el municipio del propio trabajo, y auditan `media.upload_abandoned`. Pendiente desde P3 · Paso 1.
- `@rikuy/config`: `parseJobRunnerEnv` (`WORKER_DATABASE_URL`, `JOB_RUNNER_SECRET` ≥ 32 caracteres, `WORKER_DATABASE_ROLE` solo local), sin mostrar valores en los errores.
- `@rikuy/core`: puertos `AbandonedUploadStore` y `OriginalRemover`; contrato del nuevo tipo. `apps/worker`: procesador de la limpieza (Storage solo después de que el ledger confirma, idempotente ante caídas) y `createProcessors`.
- `@rikuy/db`: el ledger del worker suma la limpieza y exige **TLS** a cualquier base no local; `removeOriginal` en el adaptador de medios.
- Web:
  - **`POST /api/jobs/drain`** en el host de la plataforma: 503 sin configurar, 401 con otro secreto (comparación en tiempo constante), 202 y drenaje después de responder (`after()`, hasta ~2,5 min dentro de los 5 min de la función). No existe en el host del panel ni en los portales.
  - `src/server/job-runner.ts`: el único módulo que abre la conexión del ejecutor (ESLint lo impide en cualquier otro), con registros en JSON, sin datos sensibles.
  - Panel: **«Procesar la cola ahora»** (operador con segundo factor, unos 20 s, muestra cuántos trabajos tomó y cómo terminaron) y aviso si el ejecutor no está configurado.
- [Runbook](../jobs.md): cómo se despierta, tipos de trabajo, **activación paso a paso** y diagnóstico (logs de Vercel, `cron.job_run_details`, `net._http_response`). `docs/deploy.md`, `.env.example`, arquitectura y roadmap actualizados.
- Tests: 380 unitarios (core 249, db 81, web 34, worker 9, config 7) + 446 pgTAP (30 nuevos) + D-01 con 7 escenarios (nuevo: barrido → inspección → marcado con el rol del worker). 0 hallazgos de `plpgsql_check`.
- Verificado en local de punta a punta (con un `pg_net` simulado que no envía, y su petición reenviada a mano): la base encola el aviso con el secreto, el ejecutor lo recibe y la sonda «falla una vez» termina en su segundo intento; una ráfaga genera un solo aviso; la limpieza reintenta si Storage no responde y luego borra el original, rechaza la versión y audita; «Procesar la cola ahora» en el navegador.

**Desviaciones:**

- Un reintento con espera corta se toma en la siguiente pasada del respaldo (hasta 1 min), no en el segundo en que vence.
- El ejecutor borra originales con el adaptador de medios de la plataforma (clave secreta, aislado), solo para la ruta exacta que el ledger le dio al trabajo. ADR-014 prevé capacidades de Storage emitidas por un endpoint interno; con ejecutor y web en el mismo despliegue, ese endpoint sería una llamada a sí mismo. Se revisa si el ejecutor sale de Vercel.

**Activación en producción (2026-10-24):** el usuario generó los dos secretos, los guardó en Vault y configuró `WORKER_DATABASE_URL` (_pooler_ en modo transacción, puerto 6543, usuario `rikuy_worker.<ref>`) y `JOB_RUNNER_SECRET` en Vercel (sensibles, solo producción). Comprobado con SQL de solo lectura: los dos nombres existen en Vault, la tarea de cada minuto corre sin errores, el aviso respondió 202 y una prueba pedida en el panel terminó en 1,6 s tomada por `vercel:gru1:kick`.

### P2 · Paso 3 — pipeline de panoramas ✅

- Según [ADR-020](../adr/ADR-020-panorama-delivery-by-resolution.md): el original no cambia; vista previa borrosa ≤ 40 KB, imagen única WebP ≤ 4096 px y, solo si la fuente supera 4096 px, teselas equirectangulares de 512 px en niveles que se duplican desde 2048 px hasta el ancho de la fuente (sin agrandar).
- Base de datos (`20261025000000_p2_panorama_enums.sql` y `20261025000100_p2_panoramas.sql`, solo expand):
  - Propósito `panorama` y estado `processing`. Originales hasta **50 MB** solo para panoramas (las fotos siguen en 10 MB, la base lo revalida por propósito).
  - `asset_versions.manifest`: manifiesto versionado (dimensiones, peso y huella de la fuente, archivos de la vista previa, la imagen y cada nivel); solo en versiones listas, con forma revalidada y sin rutas que salgan de la carpeta de la versión.
  - `submit_panorama` (propietario, administrador, editor): exige que el original esté subido, pasa a «procesando» y encola `media.process_panorama` **en la misma transacción** (idempotente), con auditoría. `list_tenant_panoramas` para cualquier miembro, con el estado de su trabajo.
  - Para el ejecutor: `worker_api.panorama_source`, `complete_panorama` y `reject_panorama`, solo con el arrendamiento vigente de un trabajo de panorama de ese municipio; auditan `media.panorama_ready` / `media.panorama_rejected`.
  - Nuevo tipo de trabajo: 4 intentos, hasta 240 s por intento, uno a la vez por municipio.
- `@rikuy/core`: contrato del manifiesto, reglas (JPG/PNG/WebP, 2048 × 1024 a 16384 × 8192 px, proporción 2:1 con 1 % de tolerancia), `planPanorama`, casos de uso `requestPanoramaUpload`, `submitPanorama`, `loadPanoramas` y los puertos del ejecutor.
- `@rikuy/db`: procesador con sharp (vista previa que baja la calidad hasta caber en 40 KB, sin EXIF ni GPS, rechaza archivos dañados), repositorio del panel y del ejecutor; las teselas se suben de a 8.
- `apps/worker`: `media.process_panorama` revisa los bytes reales y la proporción (si no sirve, borra el original y rechaza con el motivo), genera vista previa, imagen y cada nivel con **punto de control** (un reintento retoma desde el último nivel guardado) y guarda el manifiesto. Los derivados quedan en el bucket privado (`…/{versión}/panorama/`) hasta que un tour publicado los use (P4).
- Ejecutor: el aviso de la base toma trabajos durante ~40 s y guarda 245 s para un panorama dentro de los 300 s de la función; «Procesar la cola ahora» (20 s) no toma panoramas.
- Panel: **«Panoramas 360°»** en la página del municipio: subir (directo a Storage, con barra de progreso), lista con estado (Subiendo / Procesando / Listo / Rechazado con el motivo en palabras), dimensiones, peso, cómo se entregará («imagen única» o «teselas en N niveles»), vista previa y «Ver la imagen completa». La lista se actualiza sola mientras algo se procesa. Analistas en solo lectura.
- Tests: 399 unitarios (core 257, db 84, web 35, worker 16, config 7) + 481 pgTAP (35 nuevos) + D-01 con 8 escenarios (nuevo: un panorama que un segundo ejecutor completa tras vencer el arrendamiento del primero, que ya no puede escribir). 0 hallazgos de `plpgsql_check`.
- Verificado en local de punta a punta en el navegador: un panorama de 8192 × 4096 px (7,8 MB) quedó «Listo» con 168 teselas en 3 niveles en ~17 s; una foto 4:3 quedó «Rechazado» con «No es una foto 360°…»; sin desbordes a 360/390 px; axe sin hallazgos críticos ni graves; un analista ve la lista sin subir y no ve los de otro municipio.
- Medición del procesamiento (peor caso, ruido): 4096 px en 1,9 s; 8192 px en 7 s (168 teselas); 16384 px en ~25 s (680 teselas) con 926 MB de memoria, dentro de una función de Vercel.

**Desviaciones:**

- Los panoramas todavía no se ven en el portal: llegan con los tours (P4), que los publican.
- Un panorama rechazado o con el trabajo fallido se vuelve a subir; no hay botón de «reemplazar» ni de borrar todavía (llega con el editor de tours).
- Las cuotas por municipio (almacenamiento y cómputo) llegan en el Paso 5.

### P2 · Paso 4 — pipeline de modelos 3D (GLB) ✅

- Decisiones ([ADR-026](../adr/ADR-026-glb-pipeline.md)):
  - el usuario eligió que **la imagen poster la capture el panel** con el mismo visor que usará el portal (el servidor no tiene GPU) y aportó un modelo real de prueba (`ametralladora-opt.glb`, fuera del repositorio);
  - tras medirlo, **Meshopt** para la geometría (igual que Draco una vez comprimido y más liviano de decodificar);
  - **KTX2 verificado** para las texturas: 8 veces menos memoria de video en el celular.
- Base de datos (`20261025100000_p2_model_enum.sql` y `20261025100100_p2_models.sql`, solo expand):
  - Propósito `model`; el bucket privado acepta GLB y KTX2. Al reservar se exige tipo GLB, solo para modelos y hasta 50 MB; las imágenes conservan sus tipos.
  - `media_complete_upload` (camino síncrono de imágenes) ya no puede completar otra cosa que logos y fotos.
  - Versiones listas sin tamaño en píxeles para los modelos.
  - `submit_model` encola `media.process_model` en la misma transacción (idempotente, auditado). `list_tenant_models` lo puede usar cualquier miembro; `set_model_poster`, propietarios, administradores y editores, con el modelo listo y un poster válido (auditado).
  - Para el ejecutor: `worker_api.model_source`, `complete_model` y `reject_model`, solo con el arrendamiento vigente de un trabajo de modelo de ese municipio.
  - El manifiesto se revalida: hasta 15 MB optimizado, sin rutas fuera de la carpeta, y el pipeline no puede escribir el poster.
- `@rikuy/core`:
  - contrato del manifiesto (fuente, modelo, cada textura con su uso, codificación y medición, colores, peso, poster);
  - reglas (`isGlb`, límites, tolerancias por uso);
  - cálculo de color ΔE CIELAB;
  - casos de uso `requestModelUpload`, `submitModel`, `loadModels` y `saveModelPoster`;
  - los puertos del ejecutor (`ModelStore`, `ModelOptimizer`).
- `@rikuy/db`: el optimizador, todo en WASM/JS:
  - glTF Transform 4.5.1, validador de Khronos, Draco y Meshopt, y Basis Universal (`ktx2-encoder`);
  - lee el JSON antes que nada (archivos externos, extensiones);
  - separa las texturas usadas como color y como dato, y señala el material sospechoso;
  - codifica cada textura según su uso (sRGB, lineal, normales) a ≤ 2048 px y la **verifica decodificándola**;
  - comprueba el modelo escrito contra el subido (materiales por primitiva y colores por vértice por cercanía);
  - Basis ya no escribe en la salida estándar.
  - También: el poster recodificado con sharp, el repositorio del panel y el del ejecutor.
- `apps/worker`: `media.process_model`.
  - Codifica cada textura con la escalera ETC1S → UASTC → la imagen original.
  - Guarda un punto de control por textura (el KTX2 espera en `model/work/`) y escribe `model/model.glb`.
  - Rechaza con motivo y borra el original: no es GLB, inválido, archivos externos, extensión no admitida, demasiado complejo, más de 15 MB optimizado, colores cambiados. De 5 a 15 MB, «pesado».
- Ejecutor: los modelos son trabajos largos. Los toma el aviso de la base, nunca «Procesar la cola ahora». En el build, los paquetes WASM quedan fuera del bundle y Vercel los incluye en la función (verificado en su traza).
- Panel, **«Modelos 3D»** en la página del municipio:
  - subir el `.glb` (directo a Storage, con progreso);
  - estado, peso original → optimizado, triángulos, texturas en KTX2;
  - «Colores verificados» con el ΔE máximo, aviso «Pesado para celulares» y **«Revisa sus colores en el programa 3D»** con el material y la textura sospechosos;
  - visor 3D bajo demanda (three.js 0.186.0; el transcodificador KTX2 se sirve desde `/vendor/three/<versión>/basis/`);
  - **poster capturado solo** al quedar listo, con «Usar esta vista como imagen», «Restablecer vista» y «Cerrar el visor»;
  - analistas en solo lectura.
- **Comparación automática de colores en un navegador real** (`apps/web/e2e/model-colors.e2e.test.ts`, en el job «Contracts»):
  - el procesador y el optimizador reales optimizan un modelo sintético;
  - three.js dibuja el original y el optimizado desde la misma cámara, con WebGL por software;
  - se exige un ΔE de las superficies con media ≤ 2 y p95 ≤ 5 (local: 0,35 y 1,07);
  - la imagen comparada queda como artefacto.
- Tests: 427 unitarios (core 269, db 89, web 35, worker 27, config 7) + 526 pgTAP (45 nuevos) + D-01 con 9 escenarios (nuevo: un modelo que completa un segundo ejecutor tras vencer el arrendamiento del primero; el pipeline no puede poner el poster) + la comparación en el navegador. 0 hallazgos de `plpgsql_check`.
- Verificado en local, en el navegador y con el modelo real:
  - 0,48 → 1,23 MB, 12 texturas en ETC1S (ΔE de color 0,95–1,4) en ~27 s;
  - poster capturado solo y cambiado a mano;
  - el aviso de la pieza dorada;
  - un PNG renombrado a `.glb` rechazado con su motivo;
  - un analista sin botones de edición y sin ver otro municipio;
  - sin desbordes a 360/390 px y axe sin hallazgos críticos ni graves.

Lo que encontraron las pruebas:

- **En el modelo real, la pieza dorada (`Ametralladora_ChrDorado`) tiene como color el mapa de metal/rugosidad de la pieza negra** (una imagen azul y verde), así que se ve azulada en cualquier visor. Ahora el panel lo avisa. Se corrige en Blender conectando la imagen dorada al _Base Color_ de ese material.
- three.js leía como sRGB la textura que se usaba a la vez como color y como dato, así que la rugosidad de otra pieza se interpretaba mal en el original. Al separarla, la copia optimizada la dibuja bien. Por eso la comparación en el navegador usa un modelo sin ese error.
- El modelo real también se ve casi negro en el original: sus mapas marcan casi todo como metal (canal azul 148–233 de 255) sobre colores base muy oscuros. Es del archivo, no de la optimización.
- Sin `prune` conservador se perdían atributos y texturas de un solo color; sin el silencio, Basis llenaba los registros con ~15 líneas por textura; `findVersion` no reconocía el propósito `model` (el poster habría fallado).

**Desviaciones:**

- El modelo real, que ya venía con WebP muy comprimido, **pesa más** optimizado (0,48 → 1,23 MB): se cambia peso de descarga por memoria de video. Sigue dentro de los 5 MB.
- Las texturas de más de 2048 px se reducen a 2048 en la copia optimizada (límite del codificador KTX2); el original no cambia.
- El poster depende de que alguien con rol de edición abra «Modelos 3D» con el modelo listo; los tours (P4) lo exigirán al publicar. No hay todavía subida de una foto propia como poster, ni borrar o reemplazar un modelo (llegan con el editor de tours).
- Codificar una textura bloquea el hilo de la función mientras dura (~14 s a 2048 px). La ruta del ejecutor tiene su propia configuración, así que no comparte instancia con las páginas.

### P2 · Paso 5 — cuotas por municipio ✅

- Decisiones del usuario ([ADR-027](../adr/ADR-027-usage-quotas.md)):
  - **300 MB** de almacenamiento y **30 min al mes** de procesamiento de medios por municipio, por defecto;
  - el almacenamiento cuenta **el original y sus derivados**.
  - Contexto: Supabase gratis tiene 1 GB para todo el proyecto y Vercel Hobby 4 h de CPU al mes para toda la cuenta.
- Base de datos (`20261025200000_p2_usage_quotas.sql`, solo expand):
  - `tenant_quotas` (lo que asigna el operador), `usage_buckets` (límite, reservado y consumido por período) y `usage_reservations` (una por recurso y versión). RLS sin permisos para nadie.
  - **Reserva atómica** al pedir la subida, con un trigger en `asset_versions` y un `UPDATE` condicional sobre la fila del período: ×1,5 lo declarado en fotos y logos, ×2 en panoramas y modelos, más 240 s de cómputo por panorama o modelo. Si no cabe, `PT507` con el recurso y no se crea nada.
  - **Liquidación:**
    - al quedar lista, publicarse o recibir su poster, la base mide la versión en `storage.objects` (los dos buckets, sin las texturas intermedias del GLB);
    - al rechazarse, se libera;
    - al terminar un trabajo de panorama o modelo, se cuenta la duración de sus intentos.
  - El mes de cómputo empieza a medianoche del día 1 en la zona horaria del municipio.
  - `tenant_usage` (cualquier miembro), `platform_tenant_usage` y `platform_set_quota` (operador con segundo factor, auditado `platform.quota_changed`).
  - Al desplegar, mide los medios que ya existen y abre una reserva vacía para los que están en curso.
- `@rikuy/core`: contrato de uso, `meter` (aviso desde el 80 %), `loadUsage`, `changeQuota` (MB y minutos), y el resultado `over_quota` en las cuatro subidas (logo, fotos, panoramas, modelos).
- `@rikuy/db`: `PT507` → `over_quota` con el recurso, y los repositorios del municipio y del operador.
- Panel:
  - **«Uso del plan»** en la página del municipio: barras accesibles con lo usado y lo reservado, avisos al 80 % y al 100 %, y «se renueva el día 1».
  - **«Cuotas por municipio»** en `/plataforma`: uso de cada municipio, límite por defecto o asignado, total del proyecto y cambio del límite en MB o minutos.
  - Las cuatro subidas explican qué cuota se llenó.
- Tests:
  - 436 unitarios (core 275, db 92, web 35, worker 27, config 7) + 564 pgTAP (38 nuevos) + **concurrencia contra PostgreSQL real**: 8 personas piden una subida a la vez con cupo para 3 y entran exactamente 3, el resto con `PT507` y sin pasar el límite; rechazar una subida devuelve su lugar.
  - D-01 sigue en verde y `plpgsql_check` no tiene hallazgos (también en los triggers).
- Verificado en el navegador:
  - un panorama de 7,8 MB reservó 15,7 MB y 4 min, y al terminar quedó en sus 17 MB reales y 21 s;
  - el operador bajó Demo Norte a 5 MB y la subida de un modelo se rechazó con su mensaje;
  - el analista ve solo su municipio y `/plataforma/cuotas` da 404 a quien no es operador;
  - axe sin hallazgos críticos ni graves y sin desbordes a 360/1280 px.
  - La migración sobre medios ya existentes los cuenta (simulado).

**Desviaciones:**

- Una subida pedida y nunca completada retiene su reserva hasta la limpieza diaria (24 h).
- Lo real se cuenta aunque pase el límite (el trabajo ya se hizo): la siguiente subida se rechaza.
- El cómputo de antes de este paso no se cuenta, y el de las páginas no entra en ninguna cuota (para eso, el panel de Vercel).
- La cuota de IA llega con el asistente (P5), como un tercer recurso.

### P4 · Paso 1 — tours y escenas ✅

- Pasos de P4 en el [roadmap](../roadmap.md), confirmados por el usuario (2026-10-26). Son 7, incluido el **recorrido general**.
- Decisiones del usuario ([ADR-028](../adr/ADR-028-tours-model.md)):
  - cada destino o evento tiene **un tour como máximo**, y es opcional;
  - un **recorrido general** se forma solo con los tours publicados: el visitante salta entre tours sin salir del visor (Paso 5);
  - para «ir a otro recorrido» (Paso 2) quiere un acabado propio, no una flecha más;
  - las pruebas usan sus panoramas reales (`material-panoramas`, fuera del repositorio) y él mide en su Android cuando yo le avise (Pasos 4 y 7).
- Base de datos (`20261026000000_p4_tours.sql`, solo expand):
  - `tours` (único por municipio y contenido, con punteros a borrador y versión publicada), `tour_revisions` (numeradas, selladas al publicar, inmutables) y `tour_scenes`.
  - **Una sola escena de entrada**: `entry_scene_id` es una columna de la revisión, con una FK compuesta `(tenant_id, revisión, escena)` hacia una escena de la misma revisión. Un borrador puede no tenerla; sellar la exige. La primera escena agregada pasa a ser la entrada; si se quita la entrada, la toma la primera que queda.
  - `scene_id` es **estable entre revisiones**: un borrador nuevo copia las escenas con sus mismos identificadores (para los hotspots del Paso 2).
  - Cada escena es un panorama **listo** del mismo municipio (una vez por tour), con orden, nombre, descripción y vista inicial (yaw en [-π, π) y pitch en [-π/2, π/2], en radianes; campo de visión de 30–90°). Hasta 60 escenas.
  - RPC por intención, cada una con el número de edición del borrador: `create_tour`, `add_tour_scene`, `update_tour_scene` (**solo los campos enviados**, RC-01), `move_tour_scene`, `remove_tour_scene`, `set_tour_entry_scene`, `publish_tour`, `restore_tour_revision` y `discard_tour_draft`.
  - Lecturas para miembros: `list_tenant_tours`, `tour_editor` y `tour_revision_document`.
  - Editores crean y editan; solo propietarios y administradores publican y vuelven a versiones anteriores. Auditoría `tour.created`, `tour.published` y `tour.restored`.
- `@rikuy/core`:
  - contrato del tour y sus revisiones;
  - reglas de la escena (nombre, descripción, vista normalizada que nunca queda fuera de los límites al redondear);
  - qué falta para publicar;
  - casos de uso `loadTours`, `createTour`, `loadTourEditor` (con URLs firmadas de la vista previa y la imagen, y los panoramas listos que todavía no están en el tour), `addTourScene`, `updateTourScene`, `changeTourScene`, `publishTour`, `restoreTourRevision` y `discardTourDraft`.
- `@rikuy/db`: `createTourRepository`, que traduce los códigos de la base a resultados (conflicto, repetido, incompleto…).
- Panel:
  - **«Tours 360°»** en la página del municipio: lista con estado y escenas; «Nuevo tour» con los destinos y eventos próximos que todavía no tienen uno.
  - El editor del tour tiene:
    - escenas en orden, con «Subir», «Bajar», «Usar como entrada» y «Quitar» (con confirmación);
    - un **visor 360°** de la escena elegida, con «Usar esta vista como inicial» e «Ir a la vista inicial», y la vista inicial descrita en palabras;
    - nombre y descripción;
    - «Agregar escenas» con los panoramas listos;
    - la publicación con lo que falta;
    - «Descartar cambios»;
    - las versiones publicadas con «Volver a esta versión».
  - Analistas en solo lectura; editores sin «Publicar».
  - **Photo Sphere Viewer 5.15.1** (`src/components/panorama-viewer`), cargado bajo demanda, sobre el mismo three.js 0.186.0 del visor de modelos: un _override_ de pnpm evita una segunda copia. Las flechas y +/- solo mueven la vista con el visor enfocado; sus controles se anuncian como botones con nombre en español.
- Tests:
  - 452 unitarios (core 287, db 96, web 35, worker 27, config 7);
  - 623 pgTAP (59 nuevos, `018_tours`: aislamiento, roles, panorama en proceso, foto, de otro municipio o repetido, número de edición viejo, cambios parciales, orden sin cambiar la entrada, entrada de otro tour, sellado inmutable, volver a la versión 1 con su grafo, quitar la entrada, descartar);
  - integración contra Supabase real en Demo Sur (`tours.int.test.ts`): dos escenas → cuatro → volver a dos con su entrada, el analista solo lee y el propietario de otro municipio no ve nada.
  - 0 hallazgos de `plpgsql_check`.
- Verificado en local, en el navegador, con los **tres panoramas reales** de 8192 × 4096 px (listos en 3 niveles de teselas en ~78 s):
  - «Museo histórico» con «Sala de herramientas» y «Sala principal»: vista inicial guardada arrastrando el visor y con el teclado, descripción sin tocar la vista, orden, entrada, publicar, quitar una escena, publicar la versión 2 y volver a la 1;
  - «Plaza principal» con «Plaza y monumento»;
  - un editor sin «Publicar», un analista de Demo Sur sin crear y el tour de Demo Norte con 404 bajo Demo Sur;
  - axe sin hallazgos críticos ni graves y sin desbordes a 360, 390 y 1280 px.
- Lo que encontraron las pruebas, ya corregido:
  - redondear la vista a 3 decimales podía dar 1,571 > π/2 o −3,142 < −π, y la base la habría rechazado;
  - el contenedor del visor no recibía el foco, así que las flechas no se podían usar;
  - los controles del visor eran `<div>` sin nombre para lectores de pantalla.

**Desviaciones:**

- La publicación del tour tiene su propio puntero en vez de ir dentro de la revisión del destino, como proponía el esquema piloto (ADR-028). El portal lo mostrará cuando **ambos** estén publicados.
- Publicar todavía solo sella y apunta. Los derivados pasan a medios públicos con el manifiesto del tour en el Paso 3, y el portal no muestra tours hasta el Paso 4.
- El panel usa la imagen única de 4096 px del panorama, no las teselas, que llegan con el visor público.
- Los recorridos de referencia del CI serán sintéticos (tus archivos no entran al repositorio). Hay 3 panoramas reales en vez de los 6 de museo + carnaval: dos tours reales para verificar a mano y medir, y el grafo de 4 escenas con sintéticos.
- No se borra un tour ni se cambia el destino al que pertenece (llegará si hace falta).

### P4 · Paso 2 — editor de puntos (hotspots) ✅

- Decisión del usuario: «ir a otro recorrido» con un acabado propio, no como una flecha más ([ADR-029](../adr/ADR-029-tour-hotspots.md)).
- Base de datos (`20261027000000_p4_hotspots.sql`, solo expand):
  - `tour_hotspots` y `tour_hotspot_images` (FK compuestas, RLS de lectura por membresía, sin escrituras directas).
  - **Cuatro tipos con exactamente su destino** (la base lo revalida):
    - información: título, texto enriquecido y hasta 12 fotos con descripción;
    - ir a otra escena del mismo tour, nunca la propia;
    - modelo 3D listo del municipio;
    - **ir a otro recorrido**: otro destino o evento del municipio, nunca el propio.
  - Posición en yaw/pitch (radianes). Hasta 50 puntos por escena.
  - `add_tour_hotspot`, `update_tour_hotspot` (**solo los campos enviados; el tipo no cambia**, RC-01) y `remove_tour_hotspot`, con el número de edición del borrador. `tour_hotspot_targets` lista a dónde puede llevar un punto.
  - Un borrador nuevo copia los puntos y sus fotos con el **mismo identificador**. Quitar una escena quita sus puntos y las flechas que llevaban a ella.
  - Publicar exige las fotos listas y el **poster de cada modelo 3D**. Un «ir a otro recorrido» sin tour publicado no impide publicar: el portal lo ocultará hasta que exista.
  - El documento del tour incluye los puntos de cada escena, con el destino al que lleva (y si tiene tour publicado) y el modelo.
- `@rikuy/core`:
  - contrato de los puntos;
  - reglas: posición normalizada; texto con el mismo formato que los destinos, con los enlaces http señalados por línea; descripción obligatoria de cada foto; el destino de cada tipo;
  - casos de uso `addTourHotspot`, `updateTourHotspot` y `removeTourHotspot`;
  - el editor suma los modelos listos (con su poster), los destinos posibles y las vistas previas de las fotos;
  - «Falta el poster de un modelo» entre lo que impide publicar.
- `@rikuy/db`: métodos del repositorio y motivos de rechazo (destino, modelo, texto, fotos, posición, poster).
- Panel, editor del tour:
  - **puntos en el visor 360°** con un ícono por tipo (plugin de marcadores de Photo Sphere Viewer 5.15.1); «ir a otro recorrido» es una **píldora con ícono de lugar e «Ir a · {destino}»**, atenuada si el destino aún no tiene tour publicado;
  - «Agregar un punto»: se elige el tipo y se toca el panorama, o **«Poner en el centro de la vista»** (sin puntero, con el teclado);
  - formulario por tipo: texto y fotos (la misma galería de los destinos); escena de destino; modelo con su imagen (aviso si le falta); destino con aviso si no tiene tour publicado;
  - lista de puntos con «Mirar», «Editar», «Mover» y «Quitar»; tocar un punto en el visor abre su formulario; Escape cancela;
  - la confirmación de quitar una escena dice cuántos puntos se van con ella.
- El aspecto de los puntos está en `src/components/panorama-viewer/hotspot-markers.ts`, compartido con el portal (Paso 4). Se arma con nodos del DOM y `textContent`: el texto nunca se vuelve HTML.
- Tests:
  - 463 unitarios (core 295, db 99, web 35, worker 27, config 7);
  - 666 pgTAP (43 nuevos, `019_hotspots`): los cuatro tipos, destinos ajenos o inválidos (escena propia o de otro tour, modelo en proceso, de otro municipio o que es un panorama, destino de otro municipio o el propio, foto ajena, texto no permitido), número de edición viejo, analista y otro municipio; RC-01 (el título solo conserva escena, tipo, posición, texto y fotos; mover conserva el modelo); el tipo no cambia; poster exigido; inmutable al sellar; copia con los mismos identificadores; quitar una escena; volver a la versión 1 con sus cinco puntos;
  - integración contra Supabase real: RC-01 por la Data API, un destino de Demo Norte rechazado como destino de un punto de Demo Sur, y el analista que lee y no cambia;
  - 0 hallazgos de `plpgsql_check`.
- Verificado en local, en el navegador, con los **panoramas y modelos reales**:
  - `horno.glb` 8,7 → 1,86 MB y `monumento.glb` 11,4 → 1,48 MB, colores sin cambios y posters capturados solos;
  - en «Sala principal» se agregaron: información con texto y foto (la foto sin descripción se rechazó), flecha a «Sala de herramientas», modelo «Horno de barro» e «Ir a la plaza» hacia el tour publicado de la plaza;
  - después: cambiar solo el título (texto, foto y posición intactos), mover con «Poner en el centro de la vista», abrir el formulario tocando la píldora, publicar con los cuatro puntos y confirmar «quitar escena y 1 punto»;
  - axe sin hallazgos críticos ni graves y sin desbordes a 360, 390 y 1280 px.
- Lo que encontraron las pruebas, ya corregido:
  - el plugin de marcadores puede seguir dando por «encima» un punto que el puntero ya dejó, y se tragaba el clic al colocar el siguiente: ahora todo clic cuenta mientras se coloca;
  - el plugin pone `display: block` en el elemento del punto y la píldora se desarmaba: ahora el punto va dentro de un contenedor propio;
  - la galería decía «hasta 30 fotos» también en los puntos: ahora usa el límite de cada lugar (12).

**Desviaciones:**

- El portal todavía no muestra puntos: el visor público llega en el Paso 4 y la resolución de «ir a otro recorrido» con el recorrido general en el Paso 5.
- Cambiar el tipo de un punto exige quitarlo y crear otro.
- Las fotos de los puntos pasan a medios públicos al publicar en el Paso 3, junto con los panoramas y los modelos.

### P4 · Paso 3 — publicación de medios y manifiesto del tour ✅

- Decisión ([ADR-030](../adr/ADR-030-tour-publication.md)): al publicar, **primero se copian los medios al bucket público y después se sella**. Si la copia falla, no se sella nada.
- Base de datos (`20261027100000_p4_tour_publication.sql`, solo expand):
  - `media-public` acepta modelos GLB, hasta 15 MB (el límite del optimizado).
  - `tour_revisions.manifest`: el **manifiesto público** de cada revisión sellada (≤ 1 MB).
    - Contiene las escenas con la carpeta pública del panorama, su vista previa, imagen y teselas, los puntos con su texto, las fotos con su tamaño, el modelo con su poster, las flechas y el destino de cada «ir a otro recorrido».
    - No lleva nada del editor.
    - Es inmutable como la revisión; una revisión sellada sin manifiesto no puede existir.
    - Las revisiones ya selladas reciben el suyo al migrar.
  - `publish_tour` exige además que los panoramas, las fotos y los modelos sean **públicos**, no solo estén listos.
  - Lecturas anónimas, solo de municipios activos con contenido y tour publicados:
    - `portal_tour` (un tour por tipo y dirección, con los «ir a otro recorrido» resueltos; los que no tienen tour visible se omiten);
    - `portal_tour_index` (los tours visibles para el recorrido general, con la vista previa de su entrada y la ubicación). Un evento terminado conserva la página de su tour, pero sale del índice.
- `@rikuy/core`:
  - contrato `tourManifestSchema`, `PublishedTour` y `PublishedTourIndexEntry`;
  - `tourMediaPlan` lista los archivos de cada panorama que todavía no es público (vista previa, imagen y **todas las teselas**), de cada modelo (`.glb` y poster) y las fotos de los puntos; lo que ya es público no se vuelve a copiar;
  - `publishTour` revisa el número de edición, el poster y lo que falta **antes** de copiar nada, copia los medios y después sella.
- `@rikuy/db`:
  - `publishFiles` copia dentro de Storage de un bucket al otro (de a 16; los bytes no pasan por el servidor) y un archivo que ya existe cuenta como copiado;
  - una versión se marca publicada **después** de copiar sus archivos, así la cuota cuenta las copias públicas. Las fotos de destinos y eventos siguen ahora el mismo orden;
  - los derivados se guardan con `Cache-Control` de un año (rutas versionadas);
  - `createSupabasePublishedTourReader` lee `portal_tour` y `portal_tour_index` con la clave pública.
- Panel:
  - «Publicar» muestra «Publicando…» mientras se copian los medios y después «Se publicó el tour: sus panoramas, fotos y modelos ya son públicos.»;
  - publicar o volver a una versión invalida la caché del portal **solo de ese municipio**.
- Tests:
  - 471 unitarios (core 300, db 102, web 35, worker 27, config 7);
  - 696 pgTAP (30 nuevos, `020_tour_publication`): límites del bucket público; publicar con medios listos pero privados → rechazado; contenido e inmutabilidad del manifiesto; visibilidad anónima (borrador, tour sin publicar, contenido sin publicar, municipio suspendido); destino de «ir a otro recorrido» resuelto u omitido; índice sin el evento terminado; volver a la versión 1 sirve su propio manifiesto;
  - integración contra Supabase real (`tour-publication.int.test.ts`): publicar copia al bucket público, la URL pública responde con la imagen, el lector anónimo encuentra el tour y el índice, y la versión 2 se publica sobre la 1;
  - 0 hallazgos de `plpgsql_check`.
- Verificado en local, en el navegador, con los panoramas y modelos reales:
  - publicar la plaza hizo públicos los 170 archivos de su panorama;
  - publicar el museo con sus cuatro puntos hizo públicos **solo** los medios usados: sus panoramas (170 archivos cada uno), el modelo usado (2 archivos) y la foto usada (3 tamaños). El otro modelo y las otras fotos siguen privados;
  - el índice lista el museo y la plaza, y en el museo «Ir a la plaza» se resuelve a `plaza-principal`;
  - las teselas y el `.glb` públicos responden 200 con caché de un año; un archivo privado por la URL pública no responde;
  - la cuota del municipio cuenta las copias públicas;
  - axe sin hallazgos críticos ni graves y sin desbordes a 360, 390 y 1280 px.
- Lo que encontraron las pruebas, ya corregido:
  - el plugin de marcadores volvía a tragarse a veces el toque al colocar un punto: ahora el editor detecta él mismo el toque (sin arrastre) y calcula la posición;
  - las fotos se marcaban publicadas antes de subir sus copias, así que la cuota no las contaba.

**Desviaciones:**

- El portal todavía no muestra tours: el visor público llega en el Paso 4 (este paso deja listas las lecturas y su prueba).
- La copia se hace dentro de la acción de publicar. En local, con Storage simulado, el museo tardó 30 s; en Supabase la copia es interna y debería tardar segundos. Si con tours más grandes se acerca al límite de la función, pasará a un trabajo de la cola.
- El orden del recorrido general es por tipo y nombre hasta el Paso 5, donde lo elige el municipio.
- Un medio que dejó de usarse sigue público; retirarlo llegará con la limpieza de medios huérfanos.

### P4 · Paso 4 — visor público del tour ✅

- Decisiones ([ADR-031](../adr/ADR-031-public-tour-viewer.md)): una página por tour, un solo visor por recorrido y el tour también como texto. Sin cambios en la base de datos: el portal lee el manifiesto sellado del Paso 3.
- `@rikuy/core`:
  - `PORTAL_PATHS.destinationTour` / `eventTour` y `tourPath`; el sitemap suma los tours;
  - `tourViewerModel`, que convierte el manifiesto en escenas en orden y deja solo los puntos que el visitante puede usar. Omite un «ir a otro recorrido» sin tour visible, una flecha a una escena que no está y los niveles de teselas que el visor no admite (columnas que no son potencia de 2);
  - nueva entrada **`@rikuy/core/tour-viewer`**, sin esquemas, con `startingScene` (la escena de `?escena=` o la entrada), `neighbourScenes` y `TOUR_SCENE_QUERY`, para el navegador;
  - `loadTourEditor` devuelve la dirección pública del tour cuando el tour y su destino o evento están publicados.
- Portal:
  - **`/destinos/{dirección}/tour`** y **`/agenda/{dirección}/tour`**, cacheadas con el resto del portal. Publicar o volver a una versión las invalida (`refreshPortal` suma los tours).
  - El escenario tiene:
    - el **visor 360°** (Photo Sphere Viewer 5.15.1 con su adaptador de teselas): vista previa al instante y luego la imagen, o solo las teselas del nivel que la pantalla necesita;
    - una barra con el nombre de la escena, «Escena n de N», «Anterior», «Siguiente» y pantalla completa (la del escenario: los diálogos siguen visibles).
  - **Siempre gana la última escena pedida**: el visor cancela la carga anterior y una secuencia propia descarta respuestas tardías.
  - Los cuatro tipos de puntos en el panorama:
    - información: diálogo con su texto y su galería («Foto 1 de 3», Anterior / Siguiente);
    - flecha: va a la otra escena;
    - modelo 3D: diálogo con su poster;
    - «ir a otro recorrido»: la píldora abre el otro tour.
  - **El mismo tour como texto**, renderizado en el servidor: la escena con su descripción, «En esta escena» (cada punto es un botón o enlace) y «Escenas del tour». Funciona con el teclado y con un lector de pantalla. Sin WebGL 2, el visor avisa y muestra la imagen plana de la escena.
  - La dirección guarda la escena (`?escena=`), así que un enlace compartido la abre. La entrada no lleva parámetro.
  - «Ver el tour 360°» en la ficha del destino y del evento. El tour de un evento terminado sigue disponible, con su aviso y fuera de buscadores.
  - three.js y el visor (~200 KB) se cargan con import dinámico después de `load`, cuando el navegador queda libre. La vista previa de la entrada se precarga. La ficha del destino no pide ningún archivo del panorama.
- Panel: el editor del tour muestra **«Para visitantes»** con «Ver en el portal» y el **código QR** del tour (PNG y SVG) cuando el tour y su destino o evento están publicados.
- Los dos visores (panel y portal) comparten idioma, ángulos, puntos y accesibilidad (`viewer-shared.ts`).
- Tests:
  - 477 unitarios (core 306, db 102, web 35, worker 27, config 7);
  - 696 pgTAP sin cambios;
  - **RC-07 en un navegador real** (`apps/web/e2e/tour.e2e.test.ts`, en el job «Contracts», después de Lighthouse). Crea en Demo Sur, con las mismas RPC que el panel, un tour de tres panoramas sintéticos de colores distintos (uno con teselas), los cuatro tipos de puntos, dos fotos, un modelo y un segundo tour, y comprueba:
    - el recorrido completo: ficha → tour → entrada → información y galería → flecha → siguiente → anterior → modelo → otro tour → volver. Por el color en pantalla, se verifica que cada paso muestra la escena correcta;
    - la ficha no pide panoramas; la escena grande usa teselas y no su imagen;
    - con el taller respondiendo 2,5 s tarde, pedir el taller y enseguida el patio termina en el patio, también después de que el taller responde. Cuatro toques seguidos terminan en el último;
    - un enlace con `?escena=` abre esa escena;
    - sin WebGL: aviso, imagen plana, puntos y escenas desde la lista con el teclado, el foco vuelve al cerrar el diálogo y no hay desborde a 390 px.
- Verificado en local, en el navegador, con los panoramas y modelos reales:
  - la sala principal aparece en ~1,6 s, con 4–9 teselas del nivel de 4096 px;
  - los cuatro puntos, el diálogo con la foto, el poster del horno, la flecha a la sala de herramientas y la píldora «Ir a · Plaza principal»;
  - pantalla completa con un diálogo encima;
  - el QR del tour en el panel;
  - axe sin hallazgos críticos ni graves y sin desbordes a 360, 390 y 1280 px;
  - contratos RC-09/10/11/12 en verde (189 verificaciones, ahora también sobre las páginas de tour).
- Lighthouse local (móvil, CPU ×4) de la página del tour: rendimiento 60–69, LCP 2,6–4,1 s, CLS 0,002; accesibilidad, buenas prácticas y SEO 100.
- Lo que encontraron las pruebas, ya corregido:
  - sin WebGL 2, Photo Sphere Viewer no lanza un error y deja un visor a medio construir, así que la página fallaba. Ahora los dos visores lo comprueban antes;
  - una fuente de 5760 px da un nivel de 5120 px con 10 columnas, que el visor rechaza. Ese nivel se omite;
  - el visor arrancaba junto con la página y retrasaba su primera imagen; ahora espera a `load`.
  - en el CI, los estilos del tour dentro de la hoja común del portal llevaban el LCP de tres fichas a 2,57 s (límite 2,5 s). Ahora tienen su propia hoja, `tour.css`, que solo carga la página del tour.

**Desviaciones:**

- El modelo 3D muestra su poster; verlo en 3D dentro del tour llega en el Paso 6 (RC-08).
- «Ir a otro recorrido» abre la página del otro tour; saltar sin salir del visor llega con el recorrido general (Paso 5).
- La página del tour no tiene umbral de rendimiento en Lighthouse, igual que `/mapa`: se fija tras medirla en tu Android.

**Primera medición en Android (2026-10-26):** el usuario probó el tour en producción en su celular y funciona bien.

### P4 · Paso 5 — recorrido general ✅

- Decisiones ([ADR-032](../adr/ADR-032-general-tour.md)): el recorrido general lo forman los tours visibles; el municipio elige solo el orden y el tour de inicio, y el visitante salta entre tours sin salir del visor.
- Base de datos (`20261028000000_p4_general_tour.sql`, solo expand):
  - `general_tours` (tour de inicio y número de edición, una fila por municipio) y `general_tour_entries` (posición de cada tour, con FK compuestas). RLS de lectura por membresía; sin escrituras directas.
  - `save_general_tour` (propietarios y administradores, con el número de edición):
    - cada tour una sola vez, todos tours publicados del mismo municipio;
    - el tour de inicio, también del municipio;
    - auditoría `tour.general_saved`.
  - `general_tour_editor` lista para cualquier miembro todos los tours publicados, en orden, y dice si se ven o por qué no (evento terminado, contenido sin publicar).
  - `portal_tour_index` ahora viene en el orden del municipio (los que no tienen lugar, después, por tipo y nombre) y marca el tour de inicio. Si el elegido no se ve, empieza el primero.
- `@rikuy/core`:
  - `loadGeneralTour` y `saveGeneralTour` (rol, ids, repetidos);
  - `PORTAL_PATHS.generalTour` (`/recorrido`) y `tourData` (`/recorrido/datos`);
  - el índice suma `position` y `start`, y el sitemap incluye `/recorrido`.
- Portal:
  - **«Tours 360°» en la cabecera** cuando hay tours. El índice se lee junto con la marca, en paralelo; si falla, la página sigue sin el enlace.
  - **`/recorrido`** abre el tour de inicio.
  - **Menú lateral «Tours»** sobre el visor, también en pantalla completa:
    - cada tour con la vista previa de su entrada (cargada solo al abrir el menú), su tipo y sus escenas;
    - el actual, marcado;
    - Escape lo cierra y devuelve el foco; cerrado queda `hidden`.
  - **«Cerca de ti»**: «Ver los más cercanos» ordena el menú por distancia, en el dispositivo.
  - **Saltar sin salir del visor** desde el menú, la píldora «ir a otro recorrido» o «Más tours del municipio»:
    - se piden **solo los datos de ese tour** (`/recorrido/datos`, caché corta en la CDN);
    - el mismo visor cambia de panorama;
    - la dirección pasa a la página de ese tour y «atrás» vuelve;
    - un tour ya visto no se vuelve a pedir, y una respuesta tardía nunca gana.
  - Título, ruta de navegación y «Volver a…» siguen al tour actual.
- Panel, «Tours 360°»:
  - sección **«Recorrido general»** con «Subir», «Bajar» y «Empezar aquí», cada tour con «Se ve en el recorrido» o el motivo por el que no, y «Guardar el orden»;
  - el enlace y el **QR del recorrido general**;
  - editores y analistas lo ven sin controles;
  - el texto de la página ya no dice que los tours no se ven en el portal.
- Rendimiento: con este paso, el LCP de las fichas en el CI quedó en 2,53–2,59 s, sobre el límite de 2,5 s. El medidor ahora deja los números de cada página y las partes de su LCP como **anotación** del job, y así se vio que el retraso estaba en lo que bloquea la primera pintura, no en el servidor (TTFB de 3–8 ms). Correcciones:
  - los estilos del panel salen de `globals.css` (que también carga el portal) a `admin/admin.css`: el CSS del portal baja de 9 a 5 KB;
  - la fuente de títulos del portal se sirve con `next/font/local` y se precarga con la página (antes se descubría después del CSS);
  - la cabecera lee el índice de tours solo en las páginas, no en los íconos ni en el manifiesto, y las fichas saben si tienen tour por ese mismo índice, sin otra consulta.
  - Resultado en el CI: fichas en 2,44–2,46 s, inicio y listados en 1,8–2,4 s, CLS 0; accesibilidad, buenas prácticas y SEO 100.
- Corrección del Paso 4: el nombre accesible del visor cambiaba con cada escena y eso **reconstruía el visor entero** (WebGL incluido). Terminaba en la escena correcta, pero con trabajo de más. Ahora el nombre se actualiza sin rehacerlo, y RC-07 comprueba que el visor es el mismo de principio a fin.
- Tests:
  - 482 unitarios (core 311, db 102, web 35, worker 27, config 7);
  - 720 pgTAP (24 nuevos, `021_general_tour`):
    - orden por defecto y tour de inicio;
    - el analista lee, y el editor, el analista y otro municipio no guardan;
    - número de edición viejo, repetidos, huecos, tour de otro municipio o nunca publicado;
    - un evento terminado elegido como inicio se salta;
    - auditoría, visitantes sin acceso a las tablas y aislamiento;
  - 0 hallazgos de `plpgsql_check`;
  - integración contra Supabase real: guardar el orden pone el tour primero y como inicio; un número viejo da conflicto;
  - **RC-07 ampliado** (4 casos en el navegador):
    - el recorrido completo ahora comprueba que es la misma página y el mismo visor de principio a fin, y que la píldora salta pidiendo solo los datos de la plaza;
    - **recorrido general**:
      - la cabecera lleva a `/recorrido` y empieza en el tour elegido;
      - no se descarga nada del otro tour, ni su vista previa, hasta abrir el menú;
      - el menú sigue el orden del municipio y, con la ubicación junto al museo, «Ver los más cercanos» lo pone primero;
      - el salto pide solo los datos y la entrada del museo, nada de sus otras escenas;
      - «atrás» vuelve sin recargar;
      - con los datos del museo llegando 2,5 s tarde, volver a la plaza gana.
- Verificado en local, en el navegador, con los panoramas y modelos reales:
  - `/recorrido` empieza en el museo; el menú y el salto a la plaza usan la misma página y el mismo visor, con una petición de datos y 9 teselas;
  - «atrás», la píldora, «Más tours», el menú con el teclado y Escape;
  - axe con el menú abierto sin hallazgos críticos ni graves y sin desbordes a 360 y 390 px;
  - en el panel, poner la plaza primero y como inicio cambia `/recorrido` al momento (la caché del municipio se invalida);
  - un editor ve el orden sin botones;
  - contratos RC-09/10/11/12 en verde (189), ahora también rastreando `/recorrido`.

**Desviaciones:**

- Las fichas quedan a ~50 ms del límite de LCP del CI: es el margen que hay que cuidar en los próximos pasos.
- El orden no tiene versiones (sí auditoría): volver a uno anterior es reordenar.
- En el celular, el menú cubre el visor mientras está abierto; se cierra al elegir un tour.
- El modelo 3D dentro del tour sigue con su poster hasta el Paso 6.

### P4 · Paso 6 — modelo 3D en el tour ✅

- Decisiones ([ADR-033](../adr/ADR-033-tour-models.md)): primero la imagen; el visor 3D y el GLB, solo a pedido; al cerrar, se libera la memoria; y una **descripción del modelo** como alternativa en texto.
- Base de datos (`20261029000000_p4_model_descriptions.sql`, solo expand):
  - los puntos de modelo aceptan texto enriquecido (nunca fotos); las flechas y los «ir a otro recorrido» siguen sin texto;
  - es opcional, así que los puntos ya publicados siguen siendo válidos;
  - el manifiesto sellado ya llevaba el texto de cada punto: la publicación no cambia.
- `@rikuy/core`: `parseNewHotspot` y `parseHotspotChanges` aceptan la descripción del modelo; el modelo del visor la incluye.
- Panel, editor del tour: campo **«Descripción del modelo»** en los puntos de modelo, con la explicación de para qué sirve. Cambiar el modelo conserva la descripción (RC-01).
- Visor 3D (`components/model-viewer`, el mismo del panel):
  - informa el progreso de la descarga y por qué falló (sin WebGL, descarga, contexto perdido);
  - teclado propio con el modelo enfocado: flechas para girar, + y − para acercar, Inicio para volver a la primera vista (las flechas de OrbitControls desplazaban el modelo fuera de la vista);
  - en el portal no reserva el búfer de captura ni desplaza el modelo; en el panel, sí, para encuadrar el poster;
  - al desmontarse libera geometría, texturas y entorno, y **devuelve el contexto WebGL en el momento**;
  - el nombre accesible cambia sin rehacer el visor.
- Portal, diálogo del punto de modelo (`tour-model.tsx`):
  - el poster, el peso de la descarga («Descarga de 1,9 MB», con aviso si es pesado) y la descripción;
  - **«Ver en 3D»** carga el visor (import dinámico) y el GLB, con barra de progreso, encima del poster e invisible hasta que el modelo está en pantalla: la caja no cambia de tamaño;
  - listo: el foco pasa al modelo, con «Volver a la imagen» y «Restablecer vista»; al volver, el foco regresa a «Ver en 3D»;
  - si la descarga falla, «Reintentar»; si el teléfono pierde el contexto WebGL, vuelve al poster con aviso y «Volver a abrir en 3D»; sin WebGL, el poster y la descripción son el modelo y el foco va al aviso;
  - nada se mueve solo, así que «reducir movimiento» no necesita más;
  - cerrar el diálogo desmonta el visor; al reabrirlo empieza otra vez en el poster y el GLB sale de la caché del navegador.
- Tests:
  - 482 unitarios (core 311, db 102, web 35, worker 27, config 7), con casos nuevos de la descripción;
  - 731 pgTAP (11 nuevos, `022_model_descriptions`): agregar con y sin descripción, sin fotos, formato no permitido, flecha sin texto, cambiar solo la descripción conservando modelo, posición y nombre (RC-01), analista sin permiso y la descripción en el manifiesto publicado;
  - 0 hallazgos de `plpgsql_check`;
  - **RC-08 en un navegador real** (en `tour.e2e.test.ts`, job «Contracts»). El fixture ahora es un GLB **real**: el modelo sintético pasado por el procesador y el optimizador reales (Meshopt y KTX2; `e2e/support/production-model.ts`, compartido con la comparación de colores). Comprueba:
    - cero peticiones del GLB y de three.js antes de pulsar «Ver en 3D», incluso con el diálogo abierto;
    - una sola descarga al abrir, el modelo dibujado en lugar del poster y el foco en él;
    - con «reducir movimiento», nada se mueve solo; las flechas lo giran e Inicio vuelve a la primera vista;
    - «Volver a la imagen» quita el canvas, el contexto WebGL queda liberado y el foco vuelve al botón;
    - volver a abrir, cerrar el diálogo y reabrir el punto empieza en el poster;
    - una descarga que falla deja el poster y «Reintentar», que funciona;
    - un contexto perdido vuelve al poster con aviso, y se puede volver a abrir;
    - solo se habla con el portal y con Storage: el transcodificador KTX2 sale de nuestro origen;
    - sin WebGL: poster, descripción, aviso y el foco en el aviso.
- Verificado en local, en el navegador, con los **modelos reales**:
  - en el panel, «Horno de barro» con su descripción; cambiar después al `horno.glb` conservó la descripción;
  - en el portal, `horno.glb` (1,9 MB, 4 texturas KTX2) listo en ~5 s con el transcodificador desde `/vendor/three/0.186.0/basis/`; girado con el teclado; cerrar quita el canvas;
  - el visor que se descarga al abrir pesa ~56 KB gzip (three.js ya lo cargó el panorama);
  - axe sin hallazgos críticos ni graves con el poster, cargando y listo, y sin desbordes a 360, 390 y 1280 px;
  - la captura del poster en el panel sigue funcionando;
  - contratos RC-09/10/11/12 en verde (189).
- Lo que encontraron las pruebas, ya corregido:
  - la descripción quedaba lejos del resto por el margen de los textos del portal;
  - sin WebGL, el foco se perdía al desaparecer el botón: ahora va al aviso.

**Desviaciones:**

- La memoria del celular no se puede medir aquí (laboratorio sin GPU real): queda para tu Android, en este paso o en el 7.
- La descripción del modelo es opcional para no invalidar tours ya publicados; el panel la pide con su explicación.
- El visor no tiene giro automático ni animaciones de entrada: es lo que hace innecesario un modo aparte para «reducir movimiento».

### P4 · Paso 7 — contratos de los tours y medición ✅

- Registro de los contratos en [contratos de los tours](../contratos-tours.md), con las reglas de evidencia de la auditoría (fuente, datos de prueba, entorno, actor, acción, resultado y limitaciones). La auditoría se leyó en modo solo lectura.
- **Tours de referencia** en el e2e del CI (Demo Sur, datos sintéticos generados en cada corrida):
  - el museo (3 escenas, una en teselas, con los cuatro tipos de puntos);
  - **nuevo: el carnaval**, 4 escenas en fila, con flechas hacia adelante y atrás, e información con galería en la entrada;
  - la plaza.
  - El modelo 3D es un GLB sintético pasado por el optimizador real (desde el Paso 6).
- **RC-07** («walks each reference tour…»): en el museo y el carnaval, información y galería, «Siguiente» hasta la última escena y «Anterior» hasta la entrada, comprobando en cada paso el color en pantalla, «Escena n de N» y el nombre; al final, «Volver a…». Se suma a los casos de los Pasos 4 y 5 (respuesta tardía, toques rápidos, recorrido general y sin WebGL).
- **RC-01 en el panel, en un navegador** (nuevo):
  - el propietario de Demo Sur entra con su código y abre el editor del museo;
  - el modelo y su descripción aparecen elegidos; cambia solo el nombre, guarda y recarga: siguen elegidos;
  - en la base, el punto del borrador es igual al publicado salvo el nombre; lo mismo con el punto de información y sus dos fotos;
  - cambiar de un punto a otro con un cambio sin guardar nunca lleva la selección de uno al otro;
  - al final descarta el borrador.
- **RC-02** queda cubierto en la base y la API (`018_tours`, `tours.int.test.ts`); **RC-08**, por el caso del Paso 6.
- **Lighthouse de las páginas de tour:**
  - `e2e/lighthouse.mjs` con `LIGHTHOUSE_SET=tours` mide el primer tour del sitemap de cada portal y `/recorrido`;
  - en el PR corre después de RC-07 (nuevo paso del job «Contracts», con sus informes como artefacto);
  - en producción, en «Lighthouse on production», sobre los tours publicados (sin tours: un aviso);
  - umbral propio en `lighthouse-budget.json`: rendimiento ≥ 70, LCP ≤ 2,5 s, CLS ≤ 0,1, JS ≤ 380 KB;
  - CI: rendimiento 79, LCP 2,4 s, TBT 0,73–0,76 s.
  - Las direcciones `*.localhost` se piden a 127.0.0.1 con su `Host` (no todos los sistemas las resuelven).
- **Panel de medición `?medir`** en las páginas de tour (`tour-measure.tsx`), cargado solo con ese parámetro y sin enviar nada:
  - dispositivo (modelo y sistema si el navegador los informa, memoria, núcleos, GPU, pantalla, red);
  - carga (primer byte, primer contenido, LCP, arranque del visor, primera escena en pantalla);
  - datos descargados por tipo;
  - 20 cambios de escena (mediana, p95, el más lento, sin terminar, memoria JS antes y después);
  - fluidez durante 5 s de giro;
  - el modelo 3D (hasta verlo, tamaño, memoria);
  - «Copiar resultados».
  - El visor deja dos marcas de tiempo (`rikuy:tour-viewer-start`, `rikuy:tour-shown`) para medirlo.
- Tests:
  - 482 unitarios y 731 pgTAP (sin cambios);
  - e2e del tour: 8 casos (nuevos: recorrido de referencia, RC-01 en el panel y el panel de medición, que hace 20 cambios sin ninguno sin terminar y solo pide GET al portal y a Storage).
- Verificado en local: los 8 casos en verde sobre un seed limpio; Lighthouse de tours 72–74 (LCP 2,3–2,5 s); en el panel de medición, 20 cambios con p95 de 1,4 s y 9 % de crecimiento de la memoria JS (SwiftShader).
- `docs/roadmap.md`: P2, P3 y P4 marcados como terminados en la secuencia.

**Desviaciones:**

- **La medición con números en Android queda para después del merge:** el panel `?medir` solo existe en producción cuando este PR se despliega (los previews no identifican un municipio). El usuario ya probó los tours en su celular tras los Pasos 4, 5 y 6 (funcionan bien); los números se anotan en `docs/contratos-tours.md`.
- El museo de referencia tiene 3 escenas (la auditoría dice 2): la tercera cubre las teselas.
- RC-01: las opciones y el punto llegan en la misma respuesta del servidor, así que la carrera «opciones antes o después del objeto» no puede ocurrir; la prueba cubre la recarga.
- El tamaño de los panoramas no se ve en el panel de medición: Storage está en otro dominio y no envía `Timing-Allow-Origin`. Se informan cuántos archivos fueron.
- En la medición local de Lighthouse, la página del tour tuvo CLS 0,042 (el contenido baja una vez al cargar); está dentro del umbral y en el navegador real no aparece. Se revisa con la medición de producción.

## Cómo verificarlo en tu PC

```powershell
git checkout feat/p4-step7-tour-contracts
pnpm install
pnpm db:reset
pnpm dev
```

Los contratos del tour (e2e) y el Lighthouse de tours corren en el CI. En local, con un tour publicado, abre su página y agrega `?medir` a la dirección: aparece el panel de medición; sin el parámetro, no.

## Después del merge — medición en tu Android

En tu celular, con Chrome y en producción (con datos móviles si puedes):

1. abre un tour de la demo («Ver el tour 360°» en un destino) y agrega `?medir` al final de la dirección (`…/tour?medir`);
2. espera unos segundos y pulsa «1. Medir 20 cambios de escena» (no toques nada mientras corre);
3. pulsa «2. Medir la fluidez (5 s)» y gira el panorama con el dedo durante esos 5 segundos;
4. abre el punto del modelo 3D y pulsa «Ver en 3D»;
5. «Copiar resultados» y pégamelos en el chat, con el modelo de tu celular si no aparece.

Con eso anoto la medición final y, si hace falta, ajusto los umbrales.

## Siguiente paso — ★ Hito Demo / Portafolio (requiere autorización)

Según el roadmap:

- Ucureña en vivo (`rikuy-ucurena.vercel.app`) junto a un municipio demo, desde el mismo despliegue;
- una cuenta de demostración del panel sobre un municipio de prueba que se reinicia periódicamente;
- README con capturas y métricas de Speed Insights.

Antes de empezarlo conviene acordar los pasos (como en P2 y P4).

## Decisiones pendientes del usuario

- Ninguna bloqueante. El correo real del propietario de Ucureña se cambia más adelante desde «Miembros».
- **Al final del proyecto, en Blender** (pedido del usuario, 2026-10-25):
  - corregir la iluminación de la ametralladora: sus mapas marcan casi todo como metal sobre colores muy oscuros;
  - corregir su material dorado, que tiene la textura equivocada;
  - ajustar el espacio al girar algunos modelos 3D (centro de giro, distancia de la cámara).
- Cuotas: al pasar a Supabase Pro o Vercel Pro, subir los valores por defecto (`private.quota_default`) con una migración.
