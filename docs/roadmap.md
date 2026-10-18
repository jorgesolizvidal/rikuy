# Roadmap

Ajuste del roadmap P0–P6 aprobado en septiembre de 2026. Cambios respecto del original:

1. **P3 se adelanta a P2**: el portal con imágenes simples (subida firmada + validación síncrona) llega antes que el pipeline durable, que solo hace falta para panoramas y GLB.
2. **Hito "Demo / Portafolio"** después de P4: dos municipios en vivo con el mismo build.
3. Gate P6 ajustado por [ADR-020](adr/ADR-020-panorama-delivery-by-resolution.md) (tiles condicionados a fuentes > 4096 px), [ADR-019](adr/ADR-019-pilot-jobs-on-vercel.md) (jobs en Vercel) y el [cierre P0](p0-closure.md) (gold inicial de 40 casos). El dominio propio verificado pasa a opcional.

Cada fase se divide en **pasos**; un paso = una rama = un PR con CI en verde y checkpoint actualizado. Ningún paso se inicia sin autorización explícita.

## Secuencia

```
P0 ✅ benchmarks (cerrado con límites)
P1  Fundación · tenancy · identidad · white-label
P3  Portal y admin: destinos, evento, mapa, publicación (+ imágenes básicas)
P2  Jobs durables · pipeline de panoramas y GLB · observabilidad
P4  Tours 360° · hotspots · GLB lazy
★   Hito Demo / Portafolio
P5  IA turística · Copilot V1/V2
P6  Gate Early SaaS Pilot
E1–E4 expansión · X0/X1 migración del sistema anterior
```

## P1 — Fundación, tenancy, identidad y white-label

| Paso | Contenido                                                                                                                                                                                           | Terminado cuando                                                              |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1 ✅ | Monorepo, reglas de ingeniería, CI (lint/typecheck/test/build/gitleaks), documentación base                                                                                                         | CI verde; `pnpm dev` muestra el placeholder                                   |
| 2 ✅ | Supabase local (CLI + Docker), migración P1: `tenants`, `tenant_domains`, `memberships`, `tenant_config_versions`, `audit_events`; RLS + grants; tests pgTAP con casos negativos; tests de DB en CI | `pnpm db:test` verde en local y en CI                                         |
| 3 ✅ | Resolución de tenant por host (proxy de Next.js + registro de dominios), `TenantContext` por request, 404 para host desconocido, separación portal/admin                                            | Tests: host válido, desconocido, spoofing de headers, dos tenants simultáneos |
| 4 ✅ | Auth central en el host de admin (Supabase Auth vía BFF, cookies host-only, CSRF), membresías y selector de organización (el operador de plataforma pasa al Paso 6)                                 | Tests de rol, revocación con token vigente y acceso cruzado A/B               |
| 5 ✅ | Configuración white-label versionada (borrador → sellada): identidad, tema validado por contraste, contactos, SEO, manifest PWA por tenant; `TenantPresentation` en el portal                       | Dos tenants con marcas distintas en el mismo build                            |
| 6    | Operador de plataforma + onboarding genérico de tenant (flujo del operador) + seed de Ucureña y de un municipio demo sintético; primer ensayo ZC-01                                                 | Alta del tenant B sin cambios de código ni de variables de entorno            |

## P3 — Portal y administración del primer vertical

`content_items`/`content_revisions` (destino y evento de una ocurrencia), `assets`/`asset_versions`/`media_references` con subida firmada de imágenes, portal SSR con SEO por tenant, mapa con alternativa textual, administración con borrador → publicación → rollback, Lighthouse CI con el [presupuesto](performance-budget.md). Contratos RC-06/09/10/11/12/15.

## P2 — Jobs durables, pipeline de medios y observabilidad

`background_jobs`/`job_attempts`/`usage_buckets`, runtime en Vercel (ADR-019), pipeline de panoramas (preview + monolítica + tiles > 4096 px), validación y optimización de GLB con verificación de color, cuotas por tenant, suite de durabilidad D-01, logs estructurados y runbook.

## P4 — Tours 360°, hotspots y GLB

`tours`/`tour_revisions`/`scenes`/`hotspots`, `entry_scene_id` único, editor con las mismas coordenadas que el visor público, navegación, galería, modelo 3D lazy, accesibilidad del tour. Contratos RC-01/02/07/08. Medición en Android físico.

## ★ Hito Demo / Portafolio

Proyecto Supabase en la nube + Vercel. Dos portales en vivo (`rikuy-ucurena.vercel.app` y un municipio demo) desde el mismo deployment, panel de administración con una cuenta de demostración sobre un tenant sandbox que se reinicia periódicamente, README con capturas y métricas de Speed Insights.

## P5 — IA turística y Copilot V1/V2

Gateway con un modelo (D4), consultas estructuradas + FTS (D6), citas (D5), guía contextual de escena/hotspot, presupuesto por tenant y degradación sin IA. Copilot V1 (leer/analizar) y V2 (propuestas con diff que guardan borrador). Evaluación con el gold inicial de 40 casos (D7).

## P6 — Gate Early SaaS Pilot (ajustado)

Los diez criterios originales con estos cambios: (5) política de entrega por resolución funcionando y tiles validados cuando exista una fuente > 4096 px; (6) subdominios o alias de plataforma obligatorios, dominio propio verificado **opcional**; (7) A-01 con gold de 40 casos, ampliado a 120 antes de uso comercial. Sin fugas entre tenants y alta de B sin cambios de código siguen siendo innegociables.

## Expansión y migración

- **E1** patrimonio, gastronomía/menús, transporte, eventos avanzados, traducciones (incluido quechua si se prioriza).
- **E2** PWA offline selectiva, analítica/reportes, newsletter/push con ledger de entregas.
- **E3** IA avanzada (embeddings/híbrido, reranker, voz) y Copilot V3 con aprobación vinculante.
- **E4** billing, planes, roles configurables, escala.
- **X0/X1** ensayo y corte de la migración del sistema anterior, con autorización separada.
