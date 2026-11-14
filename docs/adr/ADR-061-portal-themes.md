# ADR-061 — Temas del portal

- **Estado:** Aceptada — 2026-11-14
- **Concreta:** C3 · Paso 2 (sistema de diseño con temas)
- **Se apoya en:** la marca versionada de P1 · Paso 5 (contrato `TenantPresentation` y contraste WCAG AA), [ADR-024](ADR-024-portal-page-cache.md) (caché del portal por municipio) y [ADR-060](ADR-060-tenant-modules.md) (módulos)

## Contexto

Hasta ahora cada municipio elegía fondo claro u oscuro y dos colores: todos los portales tenían la misma forma y solo cambiaban el color y el logo. El rediseño de C3 parte del diseño del usuario en Google Stitch («Tierra Viva Editorial») y pide que dos municipios con el mismo contenido parezcan sitios distintos, sin código por municipio y dentro del presupuesto de rendimiento.

Decisiones del usuario (2026-11-14):

- **el segundo tema es «Inmersivo»**: fondo oscuro, títulos grandes y las fotos a sangre, con el contenido 360° adelante;
- **cada tema trae sus fuentes**: el municipio no elige letras;
- **Ucureña adopta «Editorial»** con la paleta de Stitch; el usuario la cambia en el panel después del merge.

## Decisión

1. **El tema es un dato de la marca.** `theme.style` es opcional y vale `editorial` (si falta) o `immersive`; «Inmersivo» existe solo con fondo oscuro. El contrato de `@rikuy/core` y la base (`private.is_valid_presentation`, migración `20261124000000_c3_design_themes.sql`) lo revalidan; las marcas guardadas antes siguen siendo válidas y se leen como «Editorial». El municipio sigue eligiendo solo dos colores: nada de CSS, fuentes ni tamaños.
2. **Cada tema trae su paleta base** (`deriveTheme`): Editorial claro usa el marfil de Stitch (`#fbf9f4`, texto `#1b1c19`), Editorial oscuro el oscuro de siempre, Inmersivo una noche verdosa (`#0c110e`). El contraste AA (color principal sobre el fondo, texto de los botones, acento) se comprueba contra el fondo del tema elegido.
3. **Cada tema trae sus fuentes**, autoalojadas y con versión (`scripts/vendor-fonts.mjs` las copia a `public/vendor/fonts/<paquete>/<versión>/`, con caché de un año):
   - Editorial: Plus Jakarta Sans para todo (27 KB, latin);
   - Inmersivo: Bricolage Grotesque para los títulos y la letra del sistema para leer (41 KB).

   Cada portal **precarga solo el archivo de su tema** y declara su `@font-face` con la página; el otro nunca se descarga. Una cara de respaldo ajusta Arial (o Liberation Sans y Arimo, con sus mismas medidas) a las medidas de la fuente (los mismos valores que calcula `next/font`, comprobados en un test), para que el texto casi no se mueva cuando llega. En Editorial, los títulos usan la fuente con `font-display: swap` y los párrafos el mismo archivo como otra familia con `font-display: optional`: si la fuente no llegó para la primera pintura, los párrafos se quedan con la de respaldo en esa visita en lugar de reacomodar la página (en el CI, `/mapa` de Demo Norte se movía entero al llegar la fuente: CLS 0,146).

4. **Los componentes leen _tokens_** (`--font-display`, `--font-body`, `--radius-card`, `--radius-media`, `--radius-control`, `--shadow-card`, `--title-weight`, `--line`…) que cada tema fija en `.portal[data-theme]`, más unas reglas propias de cada tema:
   - **Editorial:** cabecera blanca con línea, títulos en 800, una barra del color de acento sobre cada sección, tarjetas blancas con sombra y la foto arriba, botones redondeados y el pie del color del municipio (con el color de texto pensado para él).
   - **Inmersivo:** navegación en mayúsculas, portada con un resplandor del color del municipio y un título mucho más grande, secciones separadas por líneas, tarjetas con la foto a sangre y el texto blanco encima de un velo negro, agenda como línea de tiempo con la fecha en un recuadro y botones cuadrados.
5. **Panel:** «Tema del portal» en «Marca del portal», con los dos temas descritos en palabras y la vista previa en vivo (cabecera, portada, una tarjeta y un botón con el tema, las fuentes y los colores). Con «Inmersivo», «Claro» queda deshabilitado y se explica por qué.
6. **Seed:** Demo Norte usa «Editorial» y Demo Sur «Inmersivo», así el CI (Lighthouse, contratos) mide los dos temas en cada PR.

## Consecuencias

- Agregar un tema es una entrada en el catálogo (`THEME_DEFINITIONS`), su paleta base, su fuente y su bloque de CSS; ningún municipio lo pide con código.
- Las páginas con estilos propios (tour, asistente, pasaporte, mapa) heredan colores y fuentes del tema, pero su forma se rehace en los pasos 4 a 6 de C3. El inicio por secciones (con su portada con foto como variante) llega en el Paso 3.
- Un portal Editorial descarga 14 KB menos de fuente que antes (Plus Jakarta Sans en lugar de Bricolage).
- La vista previa del panel es una copia pequeña: el portal publicado es la referencia.
