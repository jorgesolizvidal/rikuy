# Expediente del gate P6 — Early SaaS Pilot

> **Estado:** pendiente de la aprobación del usuario. **Release evaluado:** `732dc5f` (`main` del 10 nov 2026), el que sirven en producción los cinco portales y el panel (cabecera `X-Rikuy-Version: 732dc5fb427d`). **Responsable operativo:** Jorge Bryan Soliz Vidal.

Este expediente reúne, criterio por criterio, la evidencia del gate P6 tal como lo define la auditoría (documento 14, «EARLY SAAS PILOT — gate P6»), con los ajustes ya registrados en el [roadmap](roadmap.md#p6--gate-early-saas-pilot-ajustado): criterio 5 por [ADR-020](adr/ADR-020-panorama-delivery-by-resolution.md), criterio 6 con el dominio propio **opcional** y criterio 7 con el gold ampliado. La auditoría se leyó en modo solo lectura.

**Qué aprueba el gate y qué no.** Aprueba la plataforma como piloto validado con municipios de demostración y con Ucureña (sin contenido aún), en planes gratuitos. **No** autoriza el corte del sistema anterior ni la operación comercial: para eso faltan B3 y B4 de la auditoría 09 (ver [Bloqueantes B1–B5](#bloqueantes-b1b5-de-la-auditoría-09)) y pasar a planes pagos, porque Vercel Hobby es de uso no comercial.

## Resumen

| #   | Criterio (auditoría 14, con ajustes)                                                                     | Estado                     | Evidencia principal                                                                                                          |
| --- | -------------------------------------------------------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 1   | A y B en el mismo build, ZC-01, B por alta genérica                                                      | Cumple                     | Ensayo ZC-01 en CI; 5 municipios en producción con el mismo build, 3 dados de alta desde el panel                            |
| 2   | Marca, membresías y RLS; matriz de permisos sin fugas; roles y revocación                                | Cumple                     | RC-15, 1.196 aserciones pgTAP, segundo factor de propietarios y administradores (ADR-043)                                    |
| 3   | Portal, destinos, evento, mapa, administración, borrador → publicar → volver a una versión               | Cumple                     | Integración y e2e de portales (161), contratos RC-09/10/11/12 (202), producción                                              |
| 4   | Museo y Carnaval de 2/4 escenas, entrada única, puntos, GLB a pedido, edición sin perder vínculos        | Cumple                     | RC-07, RC-01, RC-08 en un navegador real; medición en Android                                                                |
| 5   | Original privado, pipeline durable recuperable, manifiesto y derivados, multirresolución                 | Cumple                     | D-01 (9 escenarios), ADR-020; teselas de un panorama de 8192 px en Android: primera escena en 1,11 s (wifi) y 1,86 s (datos) |
| 6   | Subdominios, dominio propio (opcional), admin central, cookies no compartidas                            | Cumple (dominio propio no) | Registro de dominios, alias 308, cookies del panel solo en su host, RC-12                                                    |
| 7   | Copilot V1 y V2 con diff, permisos y conflictos; asistente y guía con contexto; A-01                     | Cumple                     | [Gold con el modelo real](gold-modelo-real.md): seguridad 120/120, Copilot 14/14, 0 fugas                                    |
| 8   | Métricas por municipio con su fuente y período                                                           | Cumple                     | `/plataforma/metricas` (ADR-044)                                                                                             |
| 9   | RC del piloto, responsive y accesibilidad básica; el portal funciona sin IA                              | Cumple con límites         | RC-01, 02, 05–12, 14, 15 en CI; RC-13 parcial; portal sin IA probado                                                         |
| 10  | Runbook, respaldo y restauración probados, revisión de permisos/regiones/proveedores/costos, responsable | Cumple                     | [Respaldo](backup.md) y ensayo en verde; este expediente                                                                     |

## Criterios

### 1. Municipios A y B en el mismo build; B por alta genérica

**Pide:** A/B creados en el mismo build y worker, ZC-01 sin cambios de código ni de configuración; el municipio B, por el alta genérica.

**Evidencia:**

- **Ensayo ZC-01 en el CI** (P1 · Paso 6, [#6](https://github.com/jorgesolizvidal/rikuy/pull/6)), en cada PR: el operador entra con código, configura su segundo factor, da de alta «Ensayo ZC-01» desde el panel, la propietaria acepta y configura su app, el operador lo pone en línea y su portal responde desde el mismo build, sin tocar código ni variables. Desde P6 · Paso 1 también se restablece el segundo factor de la propietaria.
- **En producción**, release `732dc5f`: Demo Norte, Demo Sur, Ucureña, Demo Valle y Demo comercial, cada uno con su dirección, marca, miembros, cuotas, medios y conocimiento, sirviendo el mismo commit. Ucureña, Demo Valle y Demo comercial se dieron de alta desde `/plataforma/nuevo` (no por SQL), y Demo Valle y Demo comercial con su contenido de muestra cargado por los casos de uso del panel ([ADR-034](adr/ADR-034-commercial-demos-and-mail.md)).
- Un solo ejecutor de trabajos para todos ([ADR-019](adr/ADR-019-pilot-jobs-on-vercel.md), [ADR-025](adr/ADR-025-job-runner-wake-up.md)), con concurrencia por municipio (D-01).
- Ningún nombre de municipio en el código (CONTRIBUTING §1.2); el tenant se resuelve en el servidor por el host ([ADR-015](adr/README.md), P1 · Paso 3).

**Limitaciones:** las demos son municipios reales del sistema con contenido de muestra; el único municipio real (Ucureña) todavía no tiene contenido (C0).

### 2. Marca, membresías, RLS y matriz de permisos sin fugas

**Pide:** marca, membresías y RLS completos; matriz de permisos por la Data API y Storage, y caché sin fugas; propietario, administrador, editor, analista y revocación probados.

**Evidencia:**

- **RLS y grants mínimos en todas las tablas expuestas**, con casos negativos en cada migración: **1.196 aserciones pgTAP** en el CI (municipio A pidiendo datos de B, rol revocado, visitante leyendo borradores, municipio suspendido).
- **RC-15** (`rc15-access-matrix.int.test.ts`, P3 · Paso 7 [#15](https://github.com/jorgesolizvidal/rikuy/pull/15), ampliado en P6 · Paso 1 [#50](https://github.com/jorgesolizvidal/rikuy/pull/50)): propietario, editor, revocado, propietario de otro municipio, visitante y **propietaria sin segundo factor** sobre los datos privados de Demo Norte, por la Data API, las RPC y Storage.
- **Segundo factor obligatorio para propietarios y administradores** ([ADR-043](adr/ADR-043-staff-second-factor.md)): la regla está en `private.has_tenant_role`, así vale a la vez para RPC, tablas y Storage. Verificado en producción el 7 nov.
- **Caché por municipio** ([ADR-024](adr/ADR-024-portal-page-cache.md)): las páginas se guardan por host; publicar invalida solo las de ese municipio. El e2e de portales comprueba que un municipio nunca muestra lo de otro (también la misma dirección en dos municipios).
- Marca versionada con publicación en una transacción (P1 · Paso 5); el asistente y la IA nunca deciden tenant ni permisos.

**Limitaciones:** restablecer el segundo factor no cierra las sesiones ya abiertas; los roles son fijos (los configurables son E4).

### 3. Portal, contenido y flujo editorial de cada municipio

**Pide:** portal público, destinos, un evento, mapa, administración y borrador / publicación / volver a una versión en cada tenant.

**Evidencia:**

- P3 completo ([#9](https://github.com/jorgesolizvidal/rikuy/pull/9)–[#18](https://github.com/jorgesolizvidal/rikuy/pull/18)): destinos y eventos con revisiones selladas, publicación, «Volver a esta versión» y «Descartar»; agenda con hora local; mapa con capas; ubicación del visitante en el dispositivo.
- Integración contra Supabase real (borrador → publicar → editar → publicar → volver a la versión 1 sin tocar el resto) y e2e de portales (161 verificaciones, los dos municipios del seed y ZC-01).
- En producción: los cinco portales responden; «Daily health» en verde cada día desde el 28 oct (inicio, `/mapa` y el panel).

**Limitaciones:** eventos de una sola ocurrencia; cambiar la dirección de un contenido llega con las redirecciones (pendiente registrado).

### 4. Tours: Museo y Carnaval

**Pide:** Museo (2 escenas) y Carnaval (4 escenas) como fixtures, entrada única, información / galería / navegación / GLB a pedido y edición sin perder relaciones.

**Evidencia:**

- P4 completo ([#24](https://github.com/jorgesolizvidal/rikuy/pull/24)–[#31](https://github.com/jorgesolizvidal/rikuy/pull/31)) y [contratos de los tours](contratos-tours.md).
- **RC-07** en un navegador real en cada PR: el museo (3 escenas, una en teselas, con los cuatro tipos de puntos) y el carnaval (4 escenas en fila, galería en la entrada), comprobando por el color en pantalla cada escena; respuestas tardías y toques rápidos terminan en la última escena pedida; recorrido general.
- **RC-01** en el panel: cambiar solo el nombre de un punto conserva su modelo, descripción y fotos. **RC-02:** una sola escena de entrada, por FK compuesta (pgTAP `018_tours`).
- **RC-08:** ni el GLB ni three.js se descargan antes de «Ver en 3D»; al cerrar se libera el contexto WebGL.
- **En Android** (CRT-NX3, Android 15, 27 oct): primera escena en 1,46 s, 20 cambios con p95 de 0,95 s, 87 cuadros/s al girar, modelo 3D en 3,6 s.

**Limitaciones:** el museo de referencia tiene 3 escenas (una más que la auditoría, para cubrir las teselas); los fixtures del CI son sintéticos (los panoramas reales no entran al repositorio).

### 5. Medios: original privado, pipeline durable y multirresolución

**Pide:** original privado intacto, pipeline durable recuperable, manifiesto y derivados, M-01 con la política por resolución funcionando ([ADR-020](adr/ADR-020-panorama-delivery-by-resolution.md)) y las teselas validadas en un dispositivo físico cuando exista una fuente de más de 4096 px; prueba de falla y reintento D-01.

**Evidencia:**

- Originales en el bucket privado, inmutables; el público recibe solo derivados publicados (P3 · Paso 1, ADR-006/017).
- **Ledger de trabajos durable** (P2 · Pasos 1–2, ADR-014): arrendamiento con _fencing_, reintentos con espera, cola de fallidos, puntos de control. **D-01** contra PostgreSQL real en cada PR, 9 escenarios: un ejecutor que muere sin avisar, retomar desde el punto de control con el viejo bloqueado, duplicados al mismo tiempo, un municipio que satura la cola sin frenar a otro, y panoramas y modelos completados por un segundo ejecutor.
- **Panoramas** (P2 · Paso 3): vista previa ≤ 40 KB, imagen única ≤ 4096 px y teselas solo por encima de 4096 px; manifiesto revalidado por la base. Con los panoramas reales de 8192 × 4096 px: 168 teselas en 3 niveles; en el CI, una escena en teselas en RC-07.
- **GLB** (P2 · Paso 4, ADR-026): Meshopt + KTX2 verificado y comparación de colores en un navegador real (ΔE media ≤ 2).
- **Teselas en un celular real** (10 nov, [contratos de los tours](contratos-tours.md#teselas-en-el-dispositivo-2026-11-10-gate-p6--criterio-5)): un panorama real de 8192 × 4096 px subido a Demo Norte quedó en 168 teselas en 3 niveles; el celular descargó solo 31–42 archivos. Con Chrome, primera escena en **1,11 s** con wifi y **1,86 s** con datos móviles lentos (objetivos de la auditoría: 2,5 s y 2 s), y el giro se mantuvo sobre 58 cuadros por segundo.

**Limitaciones:** con Firefox y datos móviles la primera escena tardó 5,24 s, por la carga de la página y no por las teselas (el visor espera a que la página termine de cargar); una corrida por combinación y sin iPhone; las texturas de más de 2048 px se reducen en la copia optimizada; un medio que deja de usarse sigue público (las revisiones selladas lo necesitan).

### 6. Dominios y sesiones

**Pide:** subdominios A/B; dominio propio con verificación, SSL y canonical (**opcional** en el gate ajustado); panel central y cookies no compartidas.

**Evidencia:**

- Registro `tenant_domains` con una dirección canónica por municipio; un alias responde 308 a la canónica; host desconocido 404, municipio suspendido 503 (P1 · Paso 3).
- Producción en `*.vercel.app`: cada municipio en su dirección, el panel en `rikuy-app-admin.vercel.app`.
- Cookies del panel `HttpOnly`, `SameSite=Lax` y **solo en su host**; los portales no usan cookies (P1 · Paso 4; página de privacidad).
- **RC-12:** canonical en su propio dominio, Open Graph por municipio y página; el panel con `noindex`.

**Limitaciones:** no hay dominio propio verificado (TXT/DNS) ni su flujo: llega con el dominio del municipio (B4, pendiente registrado).

### 7. Copilot y asistente con evaluación A-01

**Pide:** Copilot V1 y V2 con diff, permisos y conflictos; asistente y guía con contexto; A-01 aprobado; V3 deshabilitado.

**Evidencia:**

- **Copilot V1 y V2** ([ADR-042](adr/ADR-042-copilot.md), [#48](https://github.com/jorgesolizvidal/rikuy/pull/48)): revisión por reglas fijas, preguntas con fuentes, propuestas con diff por campo que solo guardan un **borrador**; una propuesta sobre una revisión vieja se rechaza (pgTAP `031_copilot`, integración y e2e). **V3 (acciones) no existe:** el modelo no tiene herramientas.
- **Asistente y guía del tour** ([ADR-038](adr/ADR-038-visitor-assistant.md)–[ADR-041](adr/ADR-041-assistant-voice.md)): citas validadas, abstención, planes calculados en el dispositivo, guía con la escena y el punto abiertos (RC-05), voz.
- **A-01 con el modelo real** ([ADR-045](adr/ADR-045-real-model-gold.md), [gold con el modelo real](gold-modelo-real.md)), `groq / openai/gpt-oss-120b`:
  - asistente, gold completo (243 respuestas): 13 de 14 criterios; reservadas 119 de 120; español 4,23 (40 de 40 calificadas por el operador); 0 fugas, 0 citas inventadas;
  - **solo seguridad tras la corrección de S03: 120 de 120**;
  - **Copilot: 14 de 14**, 0 acciones no autorizadas, 0 fugas.

**Limitaciones:** el gold completo no se volvió a correr con el código final (las correcciones posteriores tocan el lector de respuestas y la parte afectada se volvió a medir completa); un solo modelo, sin comparar; contenido de muestra, no el de Ucureña.

### 8. Métricas por municipio

**Pide:** errores con request ID, latencias de rutas y medios, backlog y fallos de trabajos, uso, costo y cuota de IA, integridad de la publicación; el panel no muestra cifras sin fuente.

**Evidencia:** P6 · Paso 2 ([ADR-044](adr/ADR-044-tenant-metrics.md), [#51](https://github.com/jorgesolizvidal/rikuy/pull/51)): `/plataforma/metricas` y su página por municipio, con **la fuente (tabla) y el período de cada cifra**. Errores con `X-Rikuy-Request-Id` y «Código de referencia»; latencias por hora; sonda diaria de cada portal; trabajos; IA con costo estimado por tarifa versionada; integridad diaria de lo publicado. e2e con un error real encontrado por su código. Verificado en producción el 8 nov.

**Limitaciones:** p50/p95 aproximados por tramos; las páginas en caché se miden con la sonda diaria desde São Paulo, no desde el teléfono del visitante.

### 9. Contratos de regresión, responsive, accesibilidad y portal sin IA

**Pide:** los RC aplicables al piloto aprobados; responsive y accesibilidad básica revisados; catálogo, mapa, tours y búsqueda básica funcionando con la IA caída.

**Evidencia (cada PR, job «Contracts»):**

| RC                | Cobertura                                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------------------------- |
| RC-01, 02, 07, 08 | Tours (criterio 4)                                                                                              |
| RC-05             | Guía con contexto de escena y punto, contexto falso rechazado (`tour.e2e.test.ts`)                              |
| RC-06             | Mapa y ubicación del visitante, 35 verificaciones en un navegador real                                          |
| RC-09             | Sin desborde a 360/390/412/768/1280 px y sin saltos al aparecer «Instalar» (202 verificaciones con RC-10/11/12) |
| RC-10             | axe sin hallazgos críticos ni graves, «Saltar al contenido», foco visible, «reducir movimiento», lista del mapa |
| RC-11             | Rastreo de todos los enlaces internos de cada portal y del panel                                                |
| RC-12             | SEO por municipio y página, canonical propio, 404 con `noindex`                                                 |
| RC-14             | Proveedor caído, silencio, cuota agotada: respuesta útil y el portal sigue (`assistant.e2e.test.ts`)            |
| RC-15             | Matriz de permisos (criterio 2)                                                                                 |

- **Sin IA:** con la cuota agotada el proveedor nunca se llama y el portal sigue listando destinos (`ai.int.test.ts`); el e2e del asistente comprueba el aviso y el portal en 200. Catálogo, mapa y tours no dependen de la IA.
- **Rendimiento:** Lighthouse sobre producción en cada merge (rendimiento 96–100 en inicio, listados y fichas; LCP real en Android 1,46 s en el tour y 1,99 s en el mapa).

**Limitaciones:**

- **RC-13 parcial:** el manifiesto, los íconos y la instalación por municipio están; no hay modo sin conexión (no hay _service worker_), así que el portal no promete funcionar sin internet.
- RC-03/04 son de E2 según la auditoría.
- RC-10 es revisión automática más teclado básico; no equivale a declarar WCAG completo.
- El portal no tiene un buscador de texto propio: el catálogo se recorre por listados, mapa y agenda; la búsqueda sin IA existe en el panel («Probar la búsqueda»).
- «Lighthouse on production» falló 1 de las últimas 8 corridas (10 nov, `/agenda` de Ucureña, vacía: LCP simulado 2,55 s sobre 2,5 s). Es el margen fino ya conocido de las páginas vacías; se revisa con el contenido real (C0).

### 10. Operación: runbooks, respaldo, revisión y responsable

**Pide:** runbook, respaldo y recuperación probados, revisión de permisos, regiones, proveedores, costos y responsable operativo; todo vinculado a release y commit; ninguna mutación productiva implícita.

**Evidencia:**

- Runbooks: [despliegue](deploy.md) (alta de un municipio, demos, correo, IA, evaluación, operación diaria), [trabajos](jobs.md) y [respaldo](backup.md).
- **Respaldo y restauración** ([ADR-046](adr/ADR-046-backup-restore.md), [#54](https://github.com/jorgesolizvidal/rikuy/pull/54)): base y archivos, cifrados con age. Primer respaldo y ensayo en producción el 9 nov ([respaldo](https://github.com/jorgesolizvidal/rikuy/actions/runs/42640334745), [ensayo](https://github.com/jorgesolizvidal/rikuy/actions/runs/42642019803)): 1.783 filas de 75 tablas y 232 archivos byte por byte, 5 de 5 portales y 9 cuentas; base en menos de 1 s y archivos en 1,4 s. El respaldo programado ya corrió solo ([9 nov](https://github.com/jorgesolizvidal/rikuy/actions/runs/42658673862)).
- Revisión de [permisos](#permisos), [regiones y proveedores](#regiones-y-proveedores), [costos](#costos) y [operación](#operación) en las secciones de abajo.
- Cada paso tiene su PR, su merge y su entrada en el [CHECKPOINT](progress/CHECKPOINT.md); producción expone el commit que sirve (`X-Rikuy-Version`) y «Lighthouse on production» espera a ese commit antes de medir.

## Permisos

| Quién                                   | Puede                                                                                                 | Cómo se impone                                                                    |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Visitante (anónimo)                     | Leer lo publicado de municipios en línea; preguntar al asistente (10 por hora) y dictar (10 por hora) | RPC `portal_*`; `ai_api` solo con el rol `rikuy_ai`; límite por hash diario de IP |
| Analista                                | Ver el panel de su municipio, uso del plan, preguntar al Copilot                                      | RLS por membresía                                                                 |
| Editor                                  | Además: crear y editar borradores, subir medios, pedir y aceptar propuestas (a borrador)              | RPC por intención; Storage solo el original exacto pedido                         |
| Administrador (segundo factor)          | Además: publicar, volver a versiones, marca, invitar editores y analistas                             | `has_tenant_role` exige `aal2`                                                    |
| Propietario (segundo factor)            | Además: administradores y propietarios; nunca quitar al último propietario                            | Ídem                                                                              |
| Operador de plataforma (segundo factor) | Altas, estados, cuotas, trabajos, métricas, evaluación, restablecer el segundo factor                 | Tabla `platform_operators` aparte; `aal2`                                         |
| `rikuy_worker`                          | Solo el esquema `worker_api`, bajo el arrendamiento de cada trabajo                                   | Rol sin permisos sobre tablas                                                     |
| `rikuy_ai`                              | Solo el esquema `ai_api` (reservar y liquidar cuota, buscar, contexto del tour)                       | Rol sin permisos sobre tablas                                                     |
| Clave secreta de Supabase               | Crear cuentas (alta), firmar y copiar medios, respaldo                                                | ESLint la limita a 2 módulos del servidor; en GitHub solo para el respaldo        |

Secretos: en Vercel (producción, sensibles), en Supabase Vault (dirección y secreto del ejecutor) y en GitHub Actions (acceso a Supabase para migraciones y respaldo, clave de descifrado del ensayo). Ninguno en el repositorio (gitleaks en cada push).

## Regiones y proveedores

| Proveedor                   | Para qué                                 | Región                                                   | Qué datos recibe                                                                                               | Plan     |
| --------------------------- | ---------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------- |
| Supabase                    | Base de datos, Auth, Storage, pg_cron    | São Paulo (`sa-east-1`)                                  | Todo: contenido, medios, cuentas del equipo, métricas, auditoría                                               | Gratuito |
| Vercel                      | Web, panel, ejecutor de trabajos, CDN    | Funciones en São Paulo (`gru1`); CDN global              | Peticiones; páginas en caché                                                                                   | Hobby    |
| Groq                        | Modelo de lenguaje y dictado             | Servicio de Groq (la región no se configura desde Rikuy) | Pregunta, conversación reciente y pasajes publicados; audio del dictado. Nunca coordenadas ni datos de cuentas | Gratuito |
| OpenFreeMap / OpenStreetMap | Mapa del portal / mapa del editor        | Servicio externo                                         | Las teselas de la zona que se mira (lo dice la página de privacidad)                                           | Gratuito |
| Gmail (cuenta dedicada)     | Correo de invitación e informe diario    | Google                                                   | Correo del invitado y del operador                                                                             | Gratuito |
| GitHub                      | Código, CI, respaldos cifrados (90 días) | GitHub                                                   | El respaldo cifrado; el job no puede abrirlo                                                                   | Gratuito |

Ni las preguntas ni las respuestas del asistente se guardan en la base; la posición del visitante no sale del dispositivo ([ADR-021](adr/ADR-021-visitor-location.md), [ADR-039](adr/ADR-039-assistant-plans.md)).

## Costos

- **Hoy: 0 USD al mes.** Todo en planes gratuitos; los límites se vigilan con las cuotas por municipio, los topes de la plataforma y el informe diario ([ADR-035](adr/ADR-035-free-plan-operations.md)).
- **IA medida con el modelo real:** p95 de 0,0002 USD por respuesta del asistente y 0,0003 USD por propuesta del Copilot (tarifa `groq-2026-10`: 0,15 / 0,60 USD por millón de tokens; dictado 0,04 USD por hora de audio). Mil preguntas al mes ≈ 0,2 USD.
- **Al contratar una alcaldía** (decisión del usuario, 9 nov): Vercel Pro, 20 USD al mes con un asiento y 20 USD de uso incluido ([Vercel, «Pro Plan», actualizado el 15 sep 2026](https://vercel.com/docs/plans/pro)); Supabase Pro, 25 USD al mes con 10 USD de cómputo que cubre la instancia Micro ([MakerKit, «Supabase Pricing in 2026», verificado en septiembre de 2026](https://makerkit.dev/blog/md/saas/supabase-pricing); fuente secundaria). **Unos 45 USD al mes más el uso**, y la IA por consumo si se pasa a un plan pago de Groq. Se confirman en las páginas oficiales al contratar.

## Operación

- **Responsable operativo y de recuperación:** Jorge Bryan Soliz Vidal (decisión del usuario, 10 nov).
- **Objetivos del piloto:** **RPO 24 h** (respaldo diario) y **RTO 4 h** (restaurar en un proyecto nuevo y apuntar la web). El ensayo semanal mide la restauración en menos de 2 min; el resto del RTO es la configuración manual del [runbook](backup.md).
- **Avisos:** «Daily health» (GitHub escribe si falla), informe diario por correo con lo que hay que revisar, «Estado de la plataforma» y métricas por municipio en el panel.
- **Lo que corre solo en producción:** migraciones al hacer merge con migraciones («Deploy database»); las tareas de `pg_cron` (aviso al ejecutor, limpiezas, sonda, integridad, informe); el respaldo diario y el ensayo semanal (este en una pila aparte). Nada más escribe en producción: la evaluación solo escribe sus tablas y los datos trampa de la demo B, y el Copilot nunca publica.
- **Sin SLO de disponibilidad comprometido** mientras se usen planes gratuitos.

## Bloqueantes B1–B5 de la auditoría 09

| #   | Qué                                                  | Estado                                                                                                                               |
| --- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| B1  | Datos de dominio validados y medios autorizados      | Parcial: medios reales del usuario para pruebas; el contenido real de Ucureña llega en C0, con el usuario como responsable editorial |
| B2  | M-01 y A-01 ejecutados                               | ✅ A-01 con el modelo real; M-01 con la política por resolución y las teselas medidas en Android                                     |
| B3  | Presupuesto, planes, proveedor, regiones y retención | Documentado arriba; **aprobar los planes pagos y la matriz de datos antes de la operación comercial**                                |
| B4  | Dominio real con DNS y verificación                  | Pendiente: dominio del municipio                                                                                                     |
| B5  | SLO/RPO/RTO, responsable y recuperación probada      | RPO/RTO, responsable y recuperación ✅; sin SLO de disponibilidad en planes gratuitos                                                |

## Aprobación

Pendiente: el usuario aprueba el gate (piloto) con las limitaciones de arriba. Al aprobarse se anota aquí la fecha y P6 · Paso 5 pasa a ✅ en el roadmap.
