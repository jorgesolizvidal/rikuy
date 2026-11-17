# ADR-070 — Versiones livianas de la foto de portada del inicio

- **Estado:** Aceptada — 2026-11-16
- **Concreta:** corrección `fix/hero-lcp`
- **Ajusta:** [ADR-050](ADR-050-portal-media-same-origin.md) (fotos del portal) y [ADR-067](ADR-067-interface-polish.md) (portada a sangre)

## Contexto

Desde el 15 de noviembre, «Lighthouse on production» falla en el inicio de Ucureña: LCP simulado de 2,6–2,9 s, sobre el límite de 2,5 s. Desde C3 · Paso 8 la portada es la foto de un destino de borde a borde, y es el elemento LCP. Con `sizes="100vw"`, el teléfono que simula Lighthouse (412 px a 1,75×) necesita unos 721 px de ancho y elige la versión de 960 px (140 KB, calidad 80): la de 480 px no alcanza. Precargarla no ayuda: el navegador ya la descubre en el HTML.

La foto va debajo de un velo oscuro y del título, así que una calidad más baja no se nota. Medido sobre la portada de Ucureña (WebP desde su versión de 957 px):

| Versión | Calidad 80 | Calidad 60 |
| ------- | ---------- | ---------- |
| 800 px  | —          | 56 KB      |
| 960 px  | 140 KB     | 108 KB     |

## Decisión

1. **Cada foto de contenido tiene dos versiones «de portada»:** `hero-w800.webp` y `hero-w1200.webp`, WebP calidad 60, sin agrandar, sin metadatos, junto a sus derivados de siempre. 800 px cubre el teléfono de Lighthouse y la mayoría de los celulares con poca densidad; 1200 px, los de 2,6× y las pantallas medianas.
2. **Solo la portada del inicio las usa:** su `srcset` es `hero-w800 800w, hero-w1200 1200w, w1600 1600w` (sin repetir anchos: una foto de 957 px tiene 800 y 957). Las tarjetas, las fichas y la galería no cambian.
3. **El portal las usa solo cuando están en el bucket público:** `private.public_image` agrega `"hero": true` cuando los dos archivos existen ahí (lo comprueba en `storage.objects`). Una foto sin ellas sigue con sus versiones de siempre, y la portada nunca apunta a un archivo que no está. No hay una columna que pueda quedar desfasada de los archivos.
4. **Fotos nuevas:** se generan al confirmar la subida, con el resto de los derivados. Al publicar se copian al bucket público si la carpeta privada las tiene (archivos opcionales de la publicación).
5. **Fotos subidas antes:** un trabajo durable, `media.hero_images`, las genera desde el original. La migración lo encola una vez para cada foto de contenido lista sin ellas (en producción, unas 60), primero las publicadas. El ejecutor guarda los archivos, vuelve a leer si la foto es pública y, si lo es, los copia al bucket público; después la base comprueba que están y mide de nuevo la versión para la cuota. Una publicación que termina mientras el trabajo corre las copia ella misma (ya están en la carpeta privada) o el trabajo la ve al volver a leer.

## Consecuencias

- Migración `20261128000000_hero_images.sql` (solo expand): tipo de trabajo, validador de su _payload_, `private.has_hero_images`, `private.public_image` (con `create or replace`), `worker_api.hero_image_source`, `worker_api.complete_hero_images` y `private.enqueue_hero_images`. Test `053_hero_images`.
- Cada foto ocupa unos 100–170 KB más en cada bucket; las ~60 de producción, unos 15–20 MB en total.
- Entre el merge y el fin de los trabajos (unos minutos), la portada sigue con su versión de siempre; las páginas en caché se renuevan solas (ISR de 120 s).
- Lighthouse en el CI mide el inicio del seed: sus fotos se suben en las pruebas, así que ya tienen sus versiones de portada.
