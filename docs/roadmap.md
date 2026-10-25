# Roadmap

Ajuste del roadmap P0–P6 aprobado en septiembre de 2026. Cambios respecto del original:

1. **P3 se adelanta a P2**: el portal con imágenes simples (subida firmada + validación síncrona) llega antes que el pipeline durable, que solo hace falta para panoramas y GLB.
2. **Hito "Demo / Portafolio"** después de P4: dos municipios en vivo con el mismo build.
3. Revisión de paridad con el sistema anterior (2026-10-17, [paridad funcional](paridad-funcional.md)): se agregan la **ubicación del visitante en tiempo real** (P3 · Paso 6, [ADR-021](adr/ADR-021-visitor-location.md)) y el **asistente turístico con voz** detallado en P5 ([ADR-022](adr/ADR-022-tourist-assistant.md)).
4. P3 · Paso 7 dividido (2026-10-19, decisión del usuario): Lighthouse CI y contratos corren en GitHub Actions; Vercel, Supabase en la nube y la caché de CDN pasan a un **Paso 8 de despliegue** (requiere liberar o pagar un proyecto de Supabase).
5. Gate P6 ajustado por [ADR-020](adr/ADR-020-panorama-delivery-by-resolution.md) (tiles condicionados a fuentes > 4096 px), [ADR-019](adr/ADR-019-pilot-jobs-on-vercel.md) (jobs en Vercel) y el [cierre P0](p0-closure.md) (gold inicial de 40 casos). El dominio propio verificado pasa a opcional.

Cada fase se divide en **pasos**; un paso = una rama = un PR con CI en verde y checkpoint actualizado. Ningún paso se inicia sin autorización explícita.

## Secuencia

```
P0 ✅ benchmarks (cerrado con límites)
P1 ✅ Fundación · tenancy · identidad · white-label
P3  Portal y admin: destinos, evento, mapa, ubicación del visitante, publicación (+ imágenes básicas)
P2  Jobs durables · pipeline de panoramas y GLB · observabilidad
P4  Tours 360° · hotspots · GLB lazy
★   Hito Demo / Portafolio
P5  Asistente turístico (una conversación, guía en tours, voz) · Copilot V1/V2
P6  Gate Early SaaS Pilot
E1–E4 expansión · X0/X1 migración del sistema anterior
```

## P1 — Fundación, tenancy, identidad y white-label

| Paso | Contenido                                                                                                                                                                                                           | Terminado cuando                                                              |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1 ✅ | Monorepo, reglas de ingeniería, CI (lint/typecheck/test/build/gitleaks), documentación base                                                                                                                         | CI verde; `pnpm dev` muestra el placeholder                                   |
| 2 ✅ | Supabase local (CLI + Docker), migración P1: `tenants`, `tenant_domains`, `memberships`, `tenant_config_versions`, `audit_events`; RLS + grants; tests pgTAP con casos negativos; tests de DB en CI                 | `pnpm db:test` verde en local y en CI                                         |
| 3 ✅ | Resolución de tenant por host (proxy de Next.js + registro de dominios), `TenantContext` por request, 404 para host desconocido, separación portal/admin                                                            | Tests: host válido, desconocido, spoofing de headers, dos tenants simultáneos |
| 4 ✅ | Auth central en el host de admin (Supabase Auth vía BFF, cookies host-only, CSRF), membresías y selector de organización (el operador de plataforma pasa al Paso 6)                                                 | Tests de rol, revocación con token vigente y acceso cruzado A/B               |
| 5 ✅ | Configuración white-label versionada (borrador → sellada): identidad, tema validado por contraste, contactos, SEO, manifest PWA por tenant; `TenantPresentation` en el portal                                       | Dos tenants con marcas distintas en el mismo build                            |
| 6 ✅ | Operador de plataforma (MFA TOTP) + onboarding genérico de tenant + invitaciones y miembros; ensayo ZC-01 en CI (el alta de Ucureña se hace desde el panel o con `pnpm platform:provision`, sin datos en el código) | Alta del tenant B sin cambios de código ni de variables de entorno            |

## P3 — Portal y administración del primer vertical

Pasos (cada uno requiere autorización):

| Paso | Contenido                                                                                                                                                                                                   | Terminado cuando                                                                                                    |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 1 ✅ | Storage por tenant: buckets `media-originals` (privado) y `media-public`, `assets`/`asset_versions`, subida firmada de imágenes con validación; logo en la marca                                            | Un propietario sube el logo y aparece en su portal; B no puede leer ni escribir medios de A                         |
| 2 ✅ | `content_items`/`content_revisions`: destinos con borrador → publicación → rollback, texto enriquecido como AST, **coordenadas (PostGIS)** con selector en el mapa, imágenes por referencia                 | Publicar y revertir un destino sin tocar el resto del portal                                                        |
| 3 ✅ | Portal: listado y ficha de destino SSR, imágenes responsivas, SEO y datos estructurados por tenant, «Cómo llegar», compartir, QR por destino, botón «Instalar», páginas de privacidad y términos            | Lighthouse ≥ 90 en home y ficha con datos del seed                                                                  |
| 4 ✅ | Eventos de una ocurrencia y agenda                                                                                                                                                                          | Evento pasado deja de listarse sin intervención                                                                     |
| 5 ✅ | Mapa con carga diferida y alternativa textual (OpenFreeMap + MapLibre, [ADR-023](adr/ADR-023-portal-map-provider.md)), consultas por área y mapa pequeño en cada ficha (destino y evento)                   | Mapa fuera del bundle inicial; lista equivalente accesible                                                          |
| 6 ✅ | **Ubicación del visitante en tiempo real** ([ADR-021](adr/ADR-021-visitor-location.md)): seguir mi posición, distancia y tiempo estimado, ordenar por cercanía, «estás cerca de…», sin guardar la ubicación | RC-06: permiso concedido/denegado/desconocido; sin permiso todo funciona; ninguna posición exacta llega al servidor |
| 7 ✅ | Lighthouse CI en GitHub Actions (build de producción + base local con el seed) y contratos RC-06/09/10/11/12/15 como pruebas automáticas                                                                    | CI bloquea un PR que rompe el presupuesto                                                                           |
| 8 ✅ | Despliegue: proyecto en Vercel y Supabase en la nube, previews por PR, caché de CDN por municipio/idioma/versión, Speed Insights y prueba de la ubicación en un celular con https                           | Un PR genera su preview y Lighthouse pasa sobre él                                                                  |

`content_items`/`content_revisions` (destino y evento de una ocurrencia, con ubicación), `assets`/`asset_versions`/`media_references` con subida firmada de imágenes, portal SSR con SEO por tenant, mapa con alternativa textual, ubicación del visitante, administración con borrador → publicación → rollback, Lighthouse CI con el [presupuesto](performance-budget.md). Contratos RC-06/09/10/11/12/15.

## P2 — Jobs durables, pipeline de medios y observabilidad

`background_jobs`/`job_attempts`/`usage_buckets`, runtime en Vercel (ADR-019), pipeline de panoramas (preview + monolítica + tiles > 4096 px), validación y optimización de GLB con verificación de color, cuotas por tenant, suite de durabilidad D-01, logs estructurados y runbook.

Pasos (cada uno requiere autorización):

| Paso | Contenido                                                                                                                                                                                                                                             | Terminado cuando                                                                                     |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 1 ✅ | Ledger de trabajos: `background_jobs`/`job_attempts`, rol `rikuy_worker` con solo `worker_api`, arrendamiento con _fencing_, reintentos con espera, cola de fallidos y reintento auditado en `/plataforma/trabajos`                                   | D-01 en CI: caída a mitad, duplicados, arrendamiento vencido con el ejecutor viejo vivo, equidad A/B |
| 2 ✅ | Ejecutor en Vercel: endpoint protegido que drena la cola, la base lo despierta (`pg_net` al encolar + `pg_cron` cada minuto, [ADR-025](adr/ADR-025-job-runner-wake-up.md)), primer trabajo real (limpieza de subidas abandonadas), logs estructurados | Una prueba pedida en el panel termina sola en producción                                             |
| 3 ✅ | Pipeline de panoramas ([ADR-020](adr/ADR-020-panorama-delivery-by-resolution.md)): vista previa ≤ 40 KB + monolítica ≤ 4096 px y teselas solo si la fuente supera 4096 px                                                                             | Un panorama subido queda listo sin intervención; el original no cambia                               |
| 4 ✅ | Pipeline de GLB: validación, optimización (Meshopt/Draco + KTX2) conservando los colores, imagen _poster_, límites de 5/15 MB                                                                                                                         | Un GLB optimizado conserva sus colores (comparación automática)                                      |
| 5    | Cuotas por municipio (`usage_buckets`: almacenamiento y cómputo) con reserva atómica, visibles en el panel                                                                                                                                            | Dos subidas concurrentes no superan la cuota                                                         |

## P4 — Tours 360°, hotspots y GLB

`tours`/`tour_revisions`/`scenes`/`hotspots`, `entry_scene_id` único, editor con las mismas coordenadas que el visor público, navegación, galería, modelo 3D lazy, accesibilidad del tour. Contratos RC-01/02/07/08. Medición en Android físico.

## ★ Hito Demo / Portafolio

Proyecto Supabase en la nube + Vercel. Dos portales en vivo (`rikuy-ucurena.vercel.app` y un municipio demo) desde el mismo deployment, con mapa y ubicación del visitante, panel de administración con una cuenta de demostración sobre un tenant sandbox que se reinicia periódicamente, README con capturas y métricas de Speed Insights.

## P5 — Asistente turístico y Copilot V1/V2

Gateway con un modelo (D4), consultas estructuradas + FTS (D6), citas (D5), presupuesto por tenant y degradación sin IA. Evaluación con el gold inicial de 40 casos (D7). Detalle del asistente del visitante en [ADR-022](adr/ADR-022-tourist-assistant.md).

Pasos propuestos (cada uno requiere autorización):

| Paso | Contenido                                                                                                                                                 | Terminado cuando                                                     |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 1    | Gateway de IA: perfiles, `ai_requests`/`ai_executions`, cuotas y degradación sin IA                                                                       | Una cuota agotada detiene la IA y el portal sigue funcionando        |
| 2    | Conocimiento: `knowledge_chunks` desde contenidos publicados y documentos del municipio (texto/PDF), FTS en español, citas                                | Un borrador o un documento retirado nunca aparece en una respuesta   |
| 3    | Asistente del visitante en el portal: una conversación con contexto de página, persona por municipio (nombre, saludo), español/inglés, acciones validadas | Respuestas con citas válidas y abstención en el gold de 40 casos     |
| 4    | «Qué hay cerca», «plan para hoy» y «ruta sugerida» con motor determinista (distancia, horario, vigencia)                                                  | 0 eventos o lugares vencidos recomendados como vigentes              |
| 5    | Guía dentro del tour 360° (escena y hotspot resueltos en el servidor), en la misma conversación                                                           | RC-05: contexto conocido, ausente y malicioso                        |
| 6    | Voz: dictado con cuota de segundos y lectura en voz alta del navegador; texto como alternativa                                                            | Sin micrófono o con el proveedor caído, el asistente sigue por texto |
| 7    | Copilot V1 (leer/analizar) y V2 (propuestas con diff que guardan borrador)                                                                                | Aceptar una propuesta sobre una revisión vieja se rechaza            |

## P6 — Gate Early SaaS Pilot (ajustado)

Los diez criterios originales con estos cambios: (5) política de entrega por resolución funcionando y tiles validados cuando exista una fuente > 4096 px; (6) subdominios o alias de plataforma obligatorios, dominio propio verificado **opcional**; (7) A-01 con gold de 40 casos, ampliado a 120 antes de uso comercial. Sin fugas entre tenants y alta de B sin cambios de código siguen siendo innegociables.

## Expansión y migración

- **E1** patrimonio, gastronomía/menús, transporte, eventos avanzados, traducciones (incluido quechua si se prioriza).
- **E2** PWA offline selectiva, analítica/reportes, newsletter/push con ledger de entregas.
- **E3** IA avanzada (embeddings/híbrido, reranker, multimodal) y Copilot V3 con aprobación vinculante.
- **E4** billing, planes, roles configurables, escala.
- **X0/X1** ensayo y corte de la migración del sistema anterior, con autorización separada.
