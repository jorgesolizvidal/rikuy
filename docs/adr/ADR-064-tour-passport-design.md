# ADR-064 — Tour 360° y pasaporte con el sistema de diseño: sellos estampados, lector de QR en la página y tira de escenas

- **Estado:** Aceptada — 2026-11-14
- **Concreta:** C3 · Paso 5 (tour, recorrido general, pasaporte, sello y canje)
- **Se apoya en:** [ADR-031](ADR-031-public-tour-viewer.md) y [ADR-032](ADR-032-general-tour.md) (visor y recorrido general), [ADR-056](ADR-056-passport-circuits.md), [ADR-057](ADR-057-passport-stamps.md) y [ADR-058](ADR-058-passport-rewards.md) (pasaporte), [ADR-061](ADR-061-portal-themes.md) (temas) y [ADR-063](ADR-063-detail-pages-map.md) (mapa pequeño)

## Contexto

El diseño del usuario en Google Stitch muestra el pasaporte con un anillo de avance, cada parada como un sello y un botón para escanear el QR, y el tour con una tira de escenas. Stitch también inventó cosas que Rikuy no tiene y que no se copian: folio y rango del pasaporte, un «titular», paradas bloqueadas en orden, «Sellar en 360°» y una guía por GPS.

Decisiones del usuario (2026-11-14):

- **sellos estampados** en la página del circuito: anillo de avance, cada parada como un sello circular, la parada sugerida que sigue marcada (sin bloquear ninguna), el premio con lo que falta y un mapa pequeño del recorrido;
- **lector de QR en la página**, con la cámara del teléfono;
- **tira de escenas** en el tour, y el sello del pasaporte en el menú del recorrido general;
- **sello estampado** al sellar, y el canje con el resultado bien visible para el local.

## Decisión

1. **El sello es un dibujo, no un dato nuevo:** un SVG circular con el nombre del lugar en el borde y, una vez sellado, la marca, la fecha («14 NOV») y un pin si fue con ubicación. Con el color del municipio cuando está sellado, gris y punteado cuando falta, con el acento cuando es la parada sugerida. Es decorativo (`aria-hidden`): la página dice lo mismo en palabras al lado («Sellado el 14 nov · con ubicación», «Falta el sello»).
2. **Lo que tiene el teléfono se dibuja en el navegador** (las páginas están en caché, ADR-024): el anillo, los sellos y «Te faltan N sellos» ocupan el mismo espacio antes y después de leerse, así que nada se mueve.
3. **La parada sugerida** es la primera sin sello en el orden del circuito (`nextSuggestedStop`). Se marca «Siguiente sugerida»; todas siguen enlazadas y cualquier orden cuenta (ADR-056).
4. **Lector de QR en la página:** «Escanear el código del lugar» usa el lector de códigos del navegador (`BarcodeDetector`) sobre la cámara, en el teléfono:
   - la cámara se pide solo al pulsarlo y se apaga al cerrar el diálogo; la imagen no sale del teléfono;
   - **solo se abre un sello de este portal** (`readScannedCode`: mismo origen, `/sello/{código}` válido); cualquier otro enlace se informa y no se sigue, así un adhesivo sobre el código real no lleva al visitante a otro sitio;
   - donde el navegador no tiene lector (iPhone y la mayoría de las computadoras), el diálogo dice que se use la cámara del teléfono, que ya abre el QR;
   - `Permissions-Policy` pasa a `camera=(self)`; la página de privacidad lo explica.
5. **Mapa del recorrido:** el mapa pequeño de la ficha (ADR-063) acepta varias paradas numeradas unidas en orden; carga solo al llegar a él y usarlo, o con su botón.
6. **Tour 360°:** botón «Escenas» en la barra que abre una tira con la vista previa de cada escena (las imágenes se ponen en la página solo al abrirla); la barra, el menú y los diálogos toman radios, letras y un tono oscuro del color del municipio. En el menú del recorrido general, cada destino que es parada de un circuito publicado dice «Sello del pasaporte», o «✓ Sellado en el pasaporte» si este teléfono ya lo tiene.
7. **Canje:** el resultado para el local es una tarjeta grande: «Comprobante válido» con el color del municipio, «¡Canjeado!» relleno con él y los demás en gris, con un ícono.
8. **Estilos:** en `passport.css` y `tour.css`, que solo cargan esas páginas.

## Consecuencias

- Sin cambios en la base ni en lo que se envía: los sellos siguen solo en el teléfono (ADR-057).
- El lector solo funciona donde el navegador tiene `BarcodeDetector` (Chrome en Android); en el CI se prueba con un lector simulado y la cámara falsa de Chrome.
- La tira usa las vistas previas que el visor ya publica (≤ 40 KB cada una); no hay imágenes nuevas que generar.
