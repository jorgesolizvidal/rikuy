# ADR-050 — Fotos del portal desde su propia dirección

- **Estado:** Aceptada — 2026-11-11
- **Modifica:** la entrega de los derivados públicos de ADR-006 / ADR-017 (sin cambiar dónde se guardan)

## Contexto

Con el contenido real de Ucureña (C0 · Paso 4), «Lighthouse on production» falló por primera vez en páginas con fotos:

| Página de Ucureña  | LCP simulado | Rendimiento |
| ------------------ | -----------: | ----------: |
| Inicio             |       3,63 s |           — |
| `/destinos`        |       3,91 s |          88 |
| Ficha de un lugar  |       3,77 s |          89 |
| Ficha de un evento |       4,14 s |          87 |

Las demos, sin fotos, siguen en ~1,8 s (su LCP es texto). El servidor responde en milisegundos; el tiempo está en la foto:

- La foto viene de Storage (`*.supabase.co`), otro dominio. El celular simulado abre otra conexión (DNS, TCP y TLS, varias idas y vueltas a 150 ms) mientras la conexión del portal ya está abierta.
- En esa conexión nueva la foto compite con el logo (precargado por React con prioridad alta) y con ~147 KB de JavaScript.
- Los arreglos baratos solos no alcanzan: en local, con el logo en prioridad baja y la primera tarjeta con prioridad alta, la ficha queda en 2,5–2,8 s.

## Decisión

Decisión del usuario (2026-11-11): **servir las fotos desde la misma dirección del portal**.

1. **`/medios/{municipio}/{medio}/{versión}/{archivo}`** en cualquier host de la plataforma. Una _rewrite_ de Next.js (`beforeFiles`, `apps/web/src/lib/media-rewrite.ts`) la reenvía al bucket público de Storage (`/storage/v1/object/public/media-public/…`). El `proxy.ts` no corre en esas rutas (su _matcher_ las excluye): no hay resolución de municipio ni función por cada imagen.
2. **Caché en la CDN de Vercel.** `apps/web/vercel.json` activa la caché de la _rewrite_ (`x-vercel-enable-rewrite-caching: 1`, necesario en proyectos creados antes del 6 de abril de 2026) y la guarda 30 días (`Vercel-CDN-Cache-Control: max-age=2592000`). El navegador sigue recibiendo la caché de un año de Storage. Las rutas llevan la versión del medio: un archivo nunca cambia en su dirección.
3. **Qué pasa por ahí:** las fotos de destinos y eventos (portada, galería, tarjetas, fotos de los puntos de un tour) y el logo. `responsiveImage` y el logo devuelven rutas relativas (`portalMediaPath` en `@rikuy/core`):
   - Open Graph las vuelve absolutas con el `metadataBase` del portal, y el JSON-LD con el origen del portal;
   - los íconos del portal leen el logo desde el servidor directo de Storage (`pngFromStorage`).
4. **Panoramas, teselas y modelos 3D siguen en Storage.** Son muchos archivos y pesados; pasarlos por Vercel gastaría su transferencia sin mejorar el LCP de las páginas con fotos. Se revisa si el tour lo necesita.
5. **Seguridad:** son archivos de los municipios en el origen del portal. Las respuestas de `/medios` llevan `Content-Security-Policy: default-src 'none'; sandbox` y `X-Content-Type-Options: nosniff`, y el bucket público solo acepta WebP, PNG y GLB (ADR-017, ADR-030). El bucket ya era público: `/medios` no muestra nada que no se viera en `*.supabase.co`, aunque un archivo de un municipio también responde bajo la dirección de otro.
6. **Arreglos que acompañan:** el logo de la cabecera va con `fetchPriority="low"` (React lo precargaba con prioridad alta, delante de la foto), y en el inicio la primera tarjeta de lugares carga con prioridad alta (en el celular está a la vista).

## Consecuencias

- La foto viaja por la conexión que el celular ya abrió para la página: se espera bajar el LCP de las páginas con fotos por debajo de 2,5 s. Se comprueba con «Lighthouse on production» tras el merge.
- **Transferencia de Vercel:** las fotos cuentan en los 100 GB al mes del plan Hobby (y la primera petición de cada archivo, en la transferencia desde el origen). Con derivados de 30–150 KB alcanza holgado para la vitrina; se revisa con el tráfico real (C1).
- **Una foto borrada puede seguir en la caché de Vercel hasta 30 días** (y en la del navegador, como antes). Hoy los medios publicados que dejan de usarse ya quedan públicos (ADR-035); si un municipio necesita retirar una foto al momento, se purga la caché de Vercel desde su panel.
- En local, `next start` reenvía la _rewrite_ pero no agrega las cabeceras de `vercel.json`: la CSP de `/medios` se comprueba en producción.
- Los medios del panel (vistas previas con URL firmada) no cambian.
