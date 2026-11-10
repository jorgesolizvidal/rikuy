# ADR-049 — Borrar un tour o pasarlo a otro destino o evento

- **Estado:** Aceptada — 2026-11-10
- **Concreta:** el pendiente de P4 · Paso 1 para el roadmap C0 · Paso 3

## Contexto

Hasta ahora un tour 360° se crea para un destino o evento y queda ahí para siempre: no se puede borrar ni pasar a otro lugar. Al cargar el contenido real de Ucureña (C0 · Paso 4) hace falta corregir tours armados en el lugar equivocado o que ya no se quieren.

Condiciones:

- Las revisiones de un tour están selladas e inmutables, y «Volver a esta versión» tiene que seguir funcionando mientras el tour exista (ADR-028, ADR-030).
- Otros tours pueden tener puntos «Ir a otro recorrido» que llevan al lugar del tour (ADR-029); el portal ya oculta los que llevan a un lugar sin tour visible.
- El tour puede estar en el recorrido general (ADR-032) y lo que dice lo leyó el asistente (ADR-037).
- Sus medios solo se pueden borrar si ninguna revisión de un tour los usa (ADR-048).
- Los enlaces y QR del tour que ya circulan tienen que seguir llevando a algún lugar (como con ADR-047).

Decisiones del usuario (2026-11-10):

- **Borrar es definitivo:** se van el tour, sus versiones y su historial; sus panoramas y modelos quedan libres para borrarlos.
- **Solo propietarios y administradores** borran o pasan un tour a otro lugar.
- **Los puntos «Ir a otro recorrido» de otros tours** que llevaban al lugar se ocultan (como hoy) y el panel avisa cuáles son.
- **La dirección vieja del tour** lleva a donde está ahora: al tour en su lugar nuevo si se movió, o a la ficha del destino o evento si se borró.

## Decisión

1. **Qué cambia** (`tour_removal_impact`, cualquier miembro): versiones publicadas, si está en el recorrido general (y si empieza ahí) y los tours con un punto «Ir a otro recorrido» hacia su lugar, en su borrador, en su versión publicada o solo en una anterior. El panel lo muestra en la confirmación de borrar y de pasar.

2. **Pasar a otro lugar** (`move_tour`, propietarios y administradores):
   - el tour pasa entero: borrador, versiones, historial y su lugar en el recorrido general;
   - solo a un destino o evento del municipio sin tour, distinto del actual;
   - se rechaza (`self_link`) si un punto «Ir a otro recorrido» de su revisión de trabajo lleva justo a ese lugar: primero se quita;
   - los pasajes que leyó el asistente toman el nombre del lugar nuevo (se cita bajo ese lugar);
   - se guarda en `tour_redirects` que el lugar anterior perdió su tour hacia este;
   - auditoría `tour.moved`.

3. **Borrar** (`delete_tour`, propietarios y administradores), en una transacción:
   - sale del recorrido general; las posiciones se reordenan sin huecos y, si empezaba ahí, el recorrido empieza por el primero (`start_tour_id` nulo); el número de edición del recorrido avanza;
   - se borran los pasajes que leyó el asistente, todas las revisiones (selladas incluidas), sus escenas, puntos y fotos, y el tour;
   - una revisión sellada solo se puede borrar dentro de `delete_tour`: un nuevo trigger `protect_sealed_tour_revision` lo permite únicamente para el tour marcado en `private.tour_deletions` en la misma transacción, tabla que nadie más puede escribir. Fuera de eso, sigue siendo inmutable;
   - auditoría `tour.deleted` con el lugar, las versiones y cuántos tours tenían un punto hacia él;
   - sus medios quedan sin usos y se pueden borrar con ADR-048.

4. **Visitantes:**
   - un tour publicado nunca ofrece un punto «Ir a otro recorrido» hacia su propio lugar (puede pasar en su historial después de moverlo: `portal_tour` lo omite);
   - la página de un tour que no existe (`portal_tour_redirect`, anónima): si es una dirección vieja del lugar, el 308 de ADR-047; si su tour se movió y se puede ver, lleva a la página del tour nuevo; si el lugar está publicado sin tour, lleva a su ficha; si no, 404. Las dos redirecciones nuevas son **temporales (307)**: el lugar puede volver a tener un tour;
   - un lugar que recibe un tour (creado o movido ahí) deja de redirigir (trigger `tours_clear_redirect`); borrar el tour borra sus redirecciones;
   - borrar o mover invalida la caché del municipio, más las páginas de tour de los lugares involucrados y de los que el tour había dejado antes.

5. **Panel:** sección **«Borrar o mover el tour»** al final del editor del tour, solo para propietarios y administradores, con «Pasar a» (destinos y eventos próximos sin tour) y «Borrar el tour», cada uno con su confirmación. Al borrar, vuelve a la lista de tours.

## Consecuencias

- Los medios de un tour borrado se pueden borrar después, uno por uno, en «Panoramas 360°» y «Modelos 3D»: no se borran solos.
- Un punto «Ir a otro recorrido» que queda oculto no se borra: el panel lo nombra para cambiarlo o quitarlo.
- La página de un tour borrado lleva a la ficha de su lugar mientras ese lugar esté publicado; un enlace con `?escena=` pierde la escena (como en ADR-047).
- Los pasajes de las versiones anteriores de un tour movido también toman el nombre nuevo; si después cambia el nombre del lugar, siguen con el que tenían (como cualquier tour hoy).
