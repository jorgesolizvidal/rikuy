# ADR-063 — Fichas de destino y evento con «Para tu visita», y el mapa con la lista al costado

- **Estado:** Aceptada — 2026-11-14
- **Concreta:** C3 · Paso 4 (fichas de destino y evento, y mapa)
- **Se apoya en:** [ADR-021](ADR-021-visitor-location.md) (ubicación en el dispositivo), [ADR-023](ADR-023-portal-map-provider.md) (mapa), [ADR-024](ADR-024-portal-page-cache.md) (caché por municipio), [ADR-039](ADR-039-assistant-plans.md) (horarios), [ADR-056](ADR-056-passport-circuits.md) (circuitos) y [ADR-062](ADR-062-home-sections-categories.md) (categorías)

## Contexto

Las fichas eran una sola columna (título, foto, botones, texto, fotos, horario y ubicación) y el mapa tenía la lista debajo. El diseño de Google Stitch («Tierra Viva») no trae pantallas de ficha ni de mapa, así que salen de su estilo y de los datos que Rikuy ya tiene, sin inventar nada (ni calificaciones ni duración de la visita).

Decisiones del usuario (2026-11-14):

- **portada y columna lateral:** la foto grande arriba con el título y la categoría encima; en la PC el texto a la izquierda y la tarjeta «Para tu visita» a la derecha; en el celular, la tarjeta justo después del resumen;
- la ficha suma **«Cerca de aquí»**, **«Eventos en este lugar»**, el **sello del pasaporte** y **fotos ampliadas** en la misma página;
- en la ficha de un evento, **el bloque de fecha y su estado** («Hoy», «En curso», «Mañana», «En 5 días»);
- **el mapa grande, con la lista al costado y filtro por categoría.**

## Decisión

1. **Portada:** la foto de portada ocupa el ancho del contenido (LCP, prioridad alta) con un degradado oscuro abajo y, encima en blanco, la categoría, el título y las etiquetas reales («Recorrido 360°», «Sello del pasaporte»); en un evento, el bloque de día y mes. Sin foto, lo mismo en texto.
2. **«Para tu visita»:** una tarjeta con lo práctico. En un destino: horario y «Abierto ahora» (ADR-039), «Ver a qué distancia estoy» (en el dispositivo, ADR-021), «Cómo llegar», el tour 360°, «Compartir» y, si es parada de circuitos publicados, «Sello del pasaporte» con sus enlaces (el sello se sigue pidiendo solo con el QR del lugar). En un evento: «Cuándo» con su estado, la fecha completa y el lugar, y las mismas acciones más «Añadir al calendario». Un evento terminado conserva solo el enlace a su tour.
3. **El estado del evento se calcula en el navegador** con el reloj del municipio (`eventCountdown`, en `@rikuy/core/geo`): la página está en caché y el servidor no sabe en qué minuto se lee. «Hoy» y «mañana» son los del municipio, no los del visitante; más allá de 30 días, el bloque de fecha dice lo suficiente. La línea reserva su espacio (sin CLS).
4. **«Eventos en este lugar»:** los próximos eventos cuyo lugar es este destino, de la agenda publicada (solo con la agenda).
5. **«Cerca de aquí»:** hasta 3 destinos y eventos próximos publicados a menos de 15 km, en línea recta **desde el lugar de la ficha** (`nearestPlaces`), nunca desde el visitante: el servidor lo sabe y la página sigue en caché. No repite los eventos del propio lugar ni el lugar de un evento (ya están enlazados). Sale de las mismas lecturas que la página ya hace (destinos, agenda, índice, pasaporte): ninguna consulta nueva.
6. **Fotos ampliadas:** cada foto sigue siendo un enlace a su archivo más grande (funciona sin JavaScript); con JavaScript se abre en un `<dialog>` modal nativo con «Foto n de N», «Anterior», «Siguiente» (después de la última viene la primera), flechas y Escape, y el foco vuelve a la foto que lo abrió.
7. **Mapa:** en la PC, la columna izquierda tiene las capas, las categorías, «Usar mi ubicación» y la lista (que se desplaza dentro de su columna) y el mapa ocupa el resto, siempre en pantalla; en el celular, el mapa arriba y la lista debajo. Las categorías del municipio (ADR-062) filtran el mapa y la lista en el navegador; la lista muestra la miniatura de cada lugar (el derivado más chico, desde `/medios`). La ruta del asistente usa la misma disposición.
8. **Estilos:** lo de las fichas va en `detail.css`, que solo cargan las dos fichas (incluye el horario, antes `hours.css`, y el mapa pequeño); la hoja común pierde esas reglas.

## Consecuencias

- Publicar cualquier contenido ya invalida todas las páginas del municipio (ADR-024), así que «Cerca de aquí» y «Eventos en este lugar» se actualizan solos; un evento que termina sale de ellos con la revalidación de la página.
- Las distancias de «Cerca de aquí» son en línea recta; la página lo dice.
- La tarjeta «Para tu visita» no es fija al desplazarse: con horario y circuitos puede ser más alta que la pantalla.
