# Cierre de P0 — decisiones con evidencia

- **Fecha:** 2026-10-17
- **Fuente:** paquete técnico P0 (sandbox de benchmarks, 2026-09-15): 800/800 mediciones M-01, 960/960 respuestas A-01, 16/16 tests, integridad verificada. Los resultados crudos se conservan fuera del repositorio.

P0 no cerró todos los gates normativos (faltan fuentes 8K/16K, móvil físico, gold editorial y retrieval en PostgreSQL). Este documento acepta el paquete técnico **con esos límites explícitos** y fija las decisiones que la evidencia sí permite, para que P1–P4 no queden bloqueadas.

## M-01 · Panoramas

| Medición (2048–2880 px, escritorio, harness)                   | Resultado                                                 |
| -------------------------------------------------------------- | --------------------------------------------------------- |
| p95 "panorama utilizable", red rápida (20 Mbps / 40 ms), cold  | 1,24–1,40 s en las 5 variantes                            |
| p95 "panorama utilizable", red lenta (1,5 Mbps / 150 ms), cold | 6,48–7,64 s (excede el objetivo de 5 s)                   |
| Bytes totales p50, cold                                        | 0,93–1,14 MB, de los cuales ~0,76 MB es JavaScript común  |
| Ahorro de bytes de imagen eq512 vs monolítica                  | 37–43 %                                                   |
| Generación de 5 variantes por escena                           | 9–10,5 s, < 200 MiB de memoria                            |
| Estabilidad (100 cambios de escena)                            | heap +3,8–6,8 %, texturas estables, ~60 fps en escritorio |

**Decisiones:**

- D1 — Política de entrega por resolución → [ADR-020](adr/ADR-020-panorama-delivery-by-resolution.md).
- D2 — La palanca principal de velocidad es el **JavaScript**: visor cargado bajo demanda, preview inmediato, CDN → [presupuesto de rendimiento](performance-budget.md).
- D3 — El pipeline cabe en funciones web → [ADR-019](adr/ADR-019-pilot-jobs-on-vercel.md).

## A-01 · IA

| Modelo (Groq)         | Respuestas | p50 / p95     | Coste equivalente a lista (480 resp.) | Schema válido | Citas válidas (grader estricto) |
| --------------------- | ---------- | ------------- | ------------------------------------- | ------------- | ------------------------------- |
| `openai/gpt-oss-120b` | 480        | 0,70 / 1,71 s | USD 0,045                             | 480/480       | 479/480                         |
| `openai/gpt-oss-20b`  | 480        | 0,58 / 1,05 s | USD 0,021                             | 480/480       | 477/480                         |

**Decisiones:**

- D4 — **Un solo modelo** en el piloto: `gpt-oss-120b` como binding inicial del perfil `balanced`/`reasoning`. Sin routing: a volumen de piloto la diferencia de coste es < 1 USD por 10 000 respuestas y no justifica la complejidad. El 20b queda como candidato a re-evaluar con gold editorial.
- D5 — **Contrato de citas**: cada cita referencia `source_id` + `source_version` y, si aplica, `chunk_id`. El servidor valida que los tres existan dentro del contexto autorizado. (Las 4 citas rechazadas en P0 eran chunks válidos citados sin `source_id`: ambigüedad del contrato, no alucinación).
- D6 — **RAG empieza con consultas estructuradas + FTS en español** (`unaccent`). Embeddings (`text-embedding-3-small`) y búsqueda híbrida diferidos hasta que una evaluación muestre mejora sobre FTS; evita un proveedor de pago adicional en el piloto.
- D7 — **Gold editorial inicial de 40 casos** (revisados por el responsable del producto y, cuando sea posible, por un contacto municipal) como entrada de P5; se amplía a 120 antes de cualquier uso comercial.

## Sigue NOT_MEASURED (no se presenta como resultado)

Fuentes 8K/16K reales · Android físico y Safari/iOS · calidad perceptual y error angular de landmarks · memoria GPU real · CDN y worker durable en ambiente real · GLB real con R3F · retrieval PostgreSQL/pgvector · TTFT · factualidad cultural con gold editorial.
