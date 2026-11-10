# ADR-047 — Cambiar la dirección de un destino o evento con redirecciones

- **Estado:** Aceptada — 2026-11-10
- **Concreta:** el pendiente de P3 · Paso 2 para el roadmap C0 · Paso 1

## Contexto

Desde P3 · Paso 2, la dirección (`slug`) de un destino o evento se elige al crearlo y no se puede cambiar: cambiarla rompería los enlaces compartidos, los códigos QR impresos en carteles, los resultados de los buscadores y los enlaces de otras páginas del portal.

Ucureña empieza a cargar su contenido real (C0). Si una dirección queda mal escrita o el nombre de un lugar cambia, hoy la única salida es crear otro destino y perder el historial. Y una vez que los QR están impresos, el problema es peor.

Condiciones:

- Un QR impreso es para siempre: la dirección vieja tiene que seguir abriendo el lugar, aunque cambie varias veces.
- Un QR impreso nunca debe abrir **otro** lugar.
- Las páginas del portal están en caché por municipio (ADR-024).
- Nada de un borrador puede filtrarse a los visitantes.

## Decisión

1. **Solo propietarios y administradores** cambian la dirección, como publicar: cambia lo que abren los visitantes. La base lo exige (`change_content_slug`), no solo el panel. Solo destinos y eventos; el conocimiento no tiene página pública.

2. **Direcciones anteriores** en `content_slug_redirects` (municipio, tipo, dirección → contenido; FK compuestas, RLS de lectura para miembros, escritura solo por la RPC):
   - se guarda la anterior **solo si el contenido se publicó alguna vez** (tiene una revisión sellada). Un borrador nunca publicado cambia sin dejar rastro: nadie tiene su enlace;
   - **todas apuntan al contenido**, no a la dirección siguiente: un enlace viejo llega en **un solo 308**, aunque la dirección haya cambiado varias veces;
   - hasta **20** por contenido.

3. **Una dirección anterior queda reservada para su lugar.** Ningún otro destino (o evento) del municipio la puede usar, ni al crearse ni al cambiar la suya. Lo garantiza un trigger en `content_items`, así vale para cualquier camino. El mismo lugar sí puede volver a ella: deja de ser anterior y la que deja pasa a serlo.

   Destinos y eventos tienen direcciones propias (`/destinos/…` y `/agenda/…`): una dirección anterior de un destino no impide un evento con ese nombre.

4. **Concurrencia:** la RPC recibe la dirección que la persona vio. Si alguien la cambió mientras tanto, no cambia nada (`stale`).

5. **El portal:**
   - una ficha, un tour o el calendario `.ics` cuya dirección no existe preguntan `portal_content_redirect` (anónima). Si es una dirección anterior de un contenido **publicado en un municipio activo**, responden **308** a la página actual. Si no, el 404 de siempre: nada dice si existe un borrador;
   - el 308 queda en la caché de la página, como el 404;
   - al cambiar la dirección se invalidan, además de lo habitual, la ficha y el tour de la dirección anterior y de la nueva.

6. **Lo que no cambia, porque usa el identificador del contenido:** tours, «ir a otro recorrido», recorrido general, el lugar de un evento, los pasajes del asistente (sus citas se arman con la dirección actual al buscar) y el Copilot. El sitemap y los enlaces del portal salen de la dirección actual.

7. **Panel:** la sección «Dirección en el portal» del editor muestra la dirección actual y las anteriores («siguen llevando aquí»). Propietarios y administradores tienen «Cambiar la dirección», que explica que los enlaces y QR que circulan siguen funcionando. Después, «Para visitantes» muestra el enlace y el QR nuevos.

8. **Auditoría:** `content.slug_changed`, con la dirección anterior, la nueva y si la anterior se guardó.

## Consecuencias

- Un QR impreso o un enlace compartido sigue funcionando para siempre, y los buscadores reciben un 308 a la dirección nueva.
- **El 308 de un tour no conserva `?escena=`:** la página está en caché y no ve los parámetros, así que un enlace a una escena concreta, compartido antes del cambio, abre el tour en su entrada.
- Una ruta del asistente guardada en el navegador con la dirección vieja (`/mapa?ruta=…`) omite ese lugar.
- El archivo `.ics` usa la dirección en su UID: un calendario que agregó el evento antes del cambio lo ve como otro evento si se agrega de nuevo.
- Las direcciones anteriores no se borran desde el panel. Si alguna vez hace falta liberar una, se hace con SQL y queda auditado a mano.
- Si un municipio de demostración renombra un lugar de muestra, «Cargar contenido de muestra» lo deja como está y no crea otro.
