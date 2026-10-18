# Checkpoint

> Archivo de continuidad. Se actualiza al final de cada paso. Cualquier sesión de trabajo empieza leyendo esto.

## Estado actual

- **Fase:** P3 — Portal y administración del primer vertical (P1 ✅ completa).
- **Último paso completado:** P3 · Paso 6 — ubicación del visitante en tiempo real (2026-10-18)
- **Rama del paso:** `feat/p3-step6-visitor-location` → PR hacia `main`

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

## Cómo verificarlo en tu PC

```powershell
git checkout main
git pull
pnpm install       # instala playwright-core (solo para el e2e)
pnpm db:reset      # trae «Plaza principal» en Demo Norte
pnpm dev
```

En la PC, `localhost` cuenta como conexión segura, así que la ubicación funciona (el navegador usará la ubicación de tu PC, por Wi-Fi). Para probar como si estuvieras en el municipio de prueba, en Chrome: F12 → menú ⋮ → More tools → **Sensors** → Location → «Other…» con latitud `-17.3905` y longitud `-66.1508` (al lado del Mirador).

1. Abre http://demo-norte.localhost:3000/mapa y pulsa **«Usar mi ubicación»**: el navegador pide permiso solo en ese momento. Aparece el punto azul con su círculo, «Siguiéndote», la lista ordenada con «A 80 m en línea recta» y el aviso **«Estás cerca de Mirador del Valle»**.
2. Arrastra el mapa: «Seguirme» se apaga. Púlsalo y el mapa vuelve a ti.
3. En Sensors cambia a latitud `-17.3951`, longitud `-66.1555` (la Plaza principal): la lista cambia de orden y aparece «Estás cerca de Plaza principal».
4. Abre «Destinos»: ya muestra las distancias y la Plaza primero. Abre «Mirador del Valle» y baja a «Ubicación»: distancia y tiempos estimados.
5. «Agenda» → «Ordenar: Por cercanía».
6. «Dejar de usar mi ubicación»: desaparecen el punto, las distancias y el aviso.
7. Bloquea el permiso (candado de la barra de direcciones → Ubicación → Bloquear), recarga y pulsa «Usar mi ubicación»: el portal explica que no tiene permiso y todo sigue funcionando.
8. Opcional, el radio: panel → municipio → «Marca del portal» → «Visitantes» → por ejemplo `500`, publica, y el aviso aparece desde más lejos.

## Siguiente paso — P3 · Paso 7 (requiere autorización)

Rama `feat/p3-step7-lighthouse-ci`:

1. Previews de Vercel por PR (proyecto conectado al repositorio, variables de entorno del preview y base de datos de prueba).
2. Lighthouse CI sobre el preview con el [presupuesto](../performance-budget.md): el PR falla si una ruta pública lo rompe; `/mapa` con su objetivo propio medido en un celular real.
3. Caché de CDN por municipio, idioma y versión publicada (pendiente desde el Paso 3).
4. Contratos RC-06/09/10/11/12/15 como pruebas automáticas (leer primero su definición en la auditoría, solo lectura).
5. Prueba de la ubicación en un celular con https (el preview).

Antes de empezar hará falta: conectar Vercel con el repositorio (o autorizarme a hacerlo con el conector) y permitir `*.vercel.app` y `*.supabase.co` en los dominios de mi entorno.

## Decisiones pendientes del usuario

- Ninguna bloqueante. El correo real del propietario de Ucureña se cambia más adelante desde «Miembros» (invitar el correo real como propietario y quitar el ficticio).
