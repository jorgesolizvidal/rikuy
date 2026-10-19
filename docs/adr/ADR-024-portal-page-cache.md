# ADR-024 — Caché de las páginas del portal por municipio (ISR)

- **Estado:** Aceptada — 2026-10-19
- **Relacionada con:** ADR-003 y ADR-015 (resolución del municipio por host), presupuesto de rendimiento (regla 2), P3 · Paso 8
- **Modifica:** la forma en que una página del portal obtiene su municipio (ADR-015 no cambia: el host sigue siendo la única fuente)

## Contexto

Hasta el Paso 7, cada visita a una página del portal consultaba la base de datos: el proxy resolvía el municipio por el host y lo pasaba a la página en una cabecera interna, y las lecturas tenían una caché corta por instancia (30–60 s). Con el portal en Vercel, eso significa una función y varias consultas a Supabase (São Paulo) por visita, sin aprovechar el CDN, y una publicación tardaba hasta un minuto en verse.

El presupuesto pide páginas «cacheadas por tenant + idioma + versión publicada, con invalidación al publicar».

## Decisión

1. **Las páginas del portal se generan bajo demanda y se guardan por host** (Incremental Static Regeneration de Next.js): `generateStaticParams` vacío y `revalidate = 120` en el layout del portal. La ruta interna ya contiene el host (`/portal/{host}/…`), así que **cada municipio tiene su propia copia**; el idioma es único por ahora (español) y entrará en la ruta cuando haya más de uno.
2. **La página resuelve su municipio desde el host de la ruta**, consultando el registro de dominios **sin caché**, en vez de leer la cabecera interna (leer cabeceras impide guardar la página). Sigue siendo seguro porque `/portal/{host}` solo se alcanza mediante el proxy, que reescribe cada petición al host por el que llegó: un host desconocido, suspendido o un alias nunca llega a la página. Si el registro no responde, la página falla (no se guarda un «no encontrado»).
3. **Publicar invalida solo a ese municipio:** al publicar contenido o la marca, o al volver a una versión anterior, el panel marca como vencidas las páginas de ese host (inicio, listas, legales y la ficha de cada destino y evento publicado). La siguiente visita las reconstruye con datos frescos; los demás municipios conservan su caché.
4. Las lecturas de destinos y eventos que usan estas páginas ya no tienen caché por instancia (la página es la caché). El mapa (`/mapa`, que depende de la consulta `?lat=…&lng=…`) y sus zonas siguen siendo dinámicos, con su caché corta.
5. Las respuestas pequeñas (sitemap, robots, manifest, íconos, `.ics`) siguen siendo dinámicas con su propio `Cache-Control`.

## Consecuencias

- (+) En Vercel, una página ya generada se sirve desde el CDN sin tocar Supabase; la publicación se ve en la siguiente visita.
- (+) Un evento que terminó sale de la agenda en ≤ 2 minutos sin intervención (revalidación por tiempo).
- (−) Una página de un evento ya terminado o de una versión vieja de un destino puede quedar hasta 2 minutos con la marca anterior tras cambiarla; aceptable.
- (−) Se pierde la comprobación «la ruta coincide con la cabecera del proxy» como defensa adicional; la garantía pasa a ser que el proxy es la única entrada a `/portal/*` (su `matcher` cubre todas las rutas salvo archivos estáticos).
- Si el catálogo de un municipio crece mucho (cientos de fichas), la invalidación por lista de rutas puede pasar a etiquetas de caché por municipio.
