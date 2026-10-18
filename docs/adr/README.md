# Registro de decisiones de arquitectura (ADR)

Las ADR-001 a ADR-018 provienen de la auditoría y del cierre de decisiones de septiembre de 2026 (documentos completos fuera del repositorio). Aquí se registra su resumen y estado. Las decisiones nuevas se agregan como archivos `ADR-0NN-titulo.md`; una decisión no se reescribe: se reemplaza con otra ADR que la referencia.

| ADR | Decisión                                                                                                  | Estado                                                            |
| --- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 001 | Monolito modular TypeScript (web + worker separado), sin microservicios                                   | Aceptada                                                          |
| 002 | PostgreSQL gestionado (Supabase) con modelo de dominio nuevo; no se traduce MongoDB colección a tabla     | Aceptada                                                          |
| 003 | Aislamiento lógico: tablas compartidas, `tenant_id`, RLS, FK compuestas                                   | Aceptada                                                          |
| 004 | Identidad global (Supabase Auth) + autorización por membresía por tenant; operador de plataforma separado | Aceptada                                                          |
| 005 | Publicación explícita por revisiones selladas y referencias estables (UUID + slug por tenant)             | Aceptada                                                          |
| 006 | Originales privados versionados; derivados públicos solo tras publicar                                    | Aceptada                                                          |
| 007 | IA central con retrieval autorizado y proveedor intercambiable                                            | Aceptada                                                          |
| 008 | Copilot con herramientas de dominio y aprobación humana vinculante                                        | Aceptada                                                          |
| 009 | Outbox y ejecución al-menos-una-vez con idempotencia                                                      | Aceptada                                                          |
| 010 | PWA selectiva; mapas con licencia apropiada (sin descarga masiva de tiles OSM)                            | Aceptada                                                          |
| 011 | Migración incremental del sistema anterior con una sola fuente de escritura                               | Aceptada (fase X0/X1)                                             |
| 012 | Seguridad y economía como gates: cuotas, ledger de uso, CI de aislamiento                                 | Aceptada                                                          |
| 013 | Evidencia por release: contratos de regresión RC-01–15                                                    | Aceptada                                                          |
| 014 | Jobs durables: ledger/outbox en PostgreSQL + runtime gestionado (Trigger.dev)                             | **Modificada por ADR-019** para el piloto                         |
| 015 | Resolución de tenant por dominio registrado; admin central; cookies host-only                             | Aceptada                                                          |
| 016 | Acceso a datos en Next.js: UI → caso de uso → autorización → repositorio                                  | Aceptada                                                          |
| 017 | Panoramas: se conserva Photo Sphere Viewer, manifest propio versionado                                    | Aceptada; **política concretada por ADR-020**                     |
| 018 | IA: gateway + model routing por capacidad + RAG con evals                                                 | Aceptada; binding inicial fijado en [cierre P0](../p0-closure.md) |
| 019 | [Jobs del piloto en Vercel con ledger PostgreSQL](ADR-019-pilot-jobs-on-vercel.md)                        | Aceptada (2026-10-17)                                             |
| 020 | [Entrega de panoramas según resolución](ADR-020-panorama-delivery-by-resolution.md)                       | Aceptada (2026-10-17)                                             |
| 021 | [Ubicación del visitante en tiempo real](ADR-021-visitor-location.md)                                     | Aceptada (2026-10-17)                                             |
| 022 | [Asistente turístico: una conversación, persona por municipio y voz](ADR-022-tourist-assistant.md)        | Aceptada (2026-10-17)                                             |
