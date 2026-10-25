# Checkpoint

> Archivo de continuidad. Se actualiza al final de cada paso. Cualquier sesión de trabajo empieza leyendo esto.

## Estado actual

- **Fase:** P1, P2 y P3 ✅. Sigue P4 (tours 360°, hotspots y GLB).
- **Último paso completado:** P2 · Paso 5 — cuotas por municipio (2026-10-25)
- **Rama:** `feat/p2-step5-quotas` → PR hacia `main`

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

## Cómo verificarlo en tu PC

```powershell
git checkout feat/p2-step5-quotas
pnpm install
pnpm db:reset
pnpm db:test
pnpm --filter @rikuy/db test:integration
```

`pnpm db:test` incluye `017_usage_quotas`; la integración, `quotas.int.test.ts` (las 8 subidas simultáneas). En el panel, con `pnpm dev`: «Uso del plan» en la página de un municipio y, como operador, «Cuotas por municipio» en «Plataforma».

## Después del merge

Nada que configurar: «Deploy database» aplica la migración, que mide lo que ya hay en Storage. Comprobación: «Uso del plan» de Demo Norte muestra lo ya subido (unos 8 MB) y «Cuotas por municipio» lista los dos municipios con 300 MB y 30 min.

## Siguiente paso — P4 · Paso 1 (requiere autorización)

**Tours 360°**: proponer los pasos de P4 en el roadmap y empezar por el modelo de datos.

- Datos: `tours`, `tour_revisions`, `scenes` y `hotspots`, con `entry_scene_id` único y revisiones selladas como los destinos.
- Hotspots en yaw/pitch, de información, navegación y modelo 3D.
- Luego vienen el editor con las mismas coordenadas que el visor, el visor público (Photo Sphere Viewer con las teselas del Paso 3) y el modelo 3D bajo demanda con su poster.
- Contratos RC-01/02/07/08.

## Decisiones pendientes del usuario

- Ninguna bloqueante. El correo real del propietario de Ucureña se cambia más adelante desde «Miembros».
- **Al final del proyecto, en Blender** (pedido del usuario, 2026-10-25):
  - corregir la iluminación de la ametralladora: sus mapas marcan casi todo como metal sobre colores muy oscuros;
  - corregir su material dorado, que tiene la textura equivocada;
  - ajustar el espacio al girar algunos modelos 3D (centro de giro, distancia de la cámara).
- Cuotas: al pasar a Supabase Pro o Vercel Pro, subir los valores por defecto (`private.quota_default`) con una migración.
