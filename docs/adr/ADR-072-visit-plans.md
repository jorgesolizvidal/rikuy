# ADR-072 — Planes por tipo de visita: «Tengo 2 horas», «Con niños», «Día completo»

- **Estado:** Aceptada — 2026-11-26
- **Concreta:** A · Paso 3 (planes por tipo de visita)
- **Se apoya en:** [ADR-039](ADR-039-assistant-plans.md) (motor de planes y horarios), [ADR-062](ADR-062-home-sections-categories.md) (campos del destino y el evento), [ADR-065](ADR-065-assistant-design.md) (el plan como tarjeta), [ADR-069](ADR-069-useful-knowledge.md) (servicios locales) y [ADR-071](ADR-071-assistant-only.md) (enlaces sin portal)

## Contexto

El motor de planes (ADR-039) arma «Plan para hoy» hasta las 22:00 con hasta 5 paradas: 45 minutos en cada destino y hasta 60 en cada evento. No sabe cuánto tiempo tiene el visitante, ni si viaja con niños, y no piensa en el almuerzo. Las preguntas que más se repiten en los asistentes turísticos son justamente esas: «tengo dos horas», «¿qué hacemos con los chicos?», «armame el día».

Decisiones del usuario (2026-11-26):

- **«Con niños» es un dato que marca el municipio:** en el editor de destinos y eventos, «Para ir con niños: apto / no recomendado / sin indicar». El plan prefiere los aptos, nunca incluye los no recomendados y usa tramos a pie más cortos;
- **tiempo sugerido por lugar:** campo opcional «Tiempo de visita» en el editor del destino (de 15 min a 4 h); sin él, 45 min;
- **el almuerzo del día completo es un lugar para comer de los servicios locales:** el más cercano abierto a mediodía; si no hay, una pausa «Almuerzo» sin lugar;
- **«Plan para hoy» abre opciones:** 1 hora · 2 horas · Medio día · Día completo y la casilla «Con niños». Escribirlo («tengo 3 horas con mis hijos») también funciona.

## Decisión

### 1. Dos datos nuevos del contenido

1. **`content_revisions.visit_minutes`** (15–240, de 5 en 5; solo destinos) y **`content_revisions.kids_suitable`** (`true` apto, `false` no recomendado, `null` sin indicar; destinos y eventos). Se publican con la revisión y vuelven con «Volver a esta versión».
2. El documento del editor suma **`visitMinutes`** (destinos) y **`kids`** (destinos y eventos), opcionales. `private.is_valid_destination_draft` y `private.is_valid_event_draft` los aceptan; `private.revision_document` los devuelve **solo cuando tienen valor**, así el panel ya desplegado sigue funcionando durante el despliegue.
3. **`portal_plan_traits`** (anónima, municipios activos): por cada destino y evento publicado, su tiempo de visita y si es para niños. Una lectura aparte: las existentes no cambian.
4. **El asistente lo sabe también como texto:** el indexador suma «Apto para ir con niños.» / «No es recomendable para ir con niños.» y «Tiempo de visita sugerido: 1 h 30 min.», así responde «¿se puede ir con niños al museo?» con la ficha.

### 2. El tipo de visita

1. **`PlanVisit`**: un tiempo (`{ minutes }` de 60 a 600, o `"full_day"`) y `kids`. Solo para «plan para hoy». «Qué hay cerca» y «Ruta sugerida» no cambian.
2. **Los botones** envían `visit: { length: "1h" | "2h" | "half" | "full", kids }`. Medio día son 4 horas. **Escrito**, el servidor reconoce «tengo 3 horas», «una hora», «medio día», «todo el día», «día completo», «con niños», «con mis hijos», «con los chicos», «con las wawas» y sus versiones en inglés. Una pregunta como «¿el museo es apto para niños?» sigue siendo una pregunta para los textos publicados.
3. Sin tiempo («Plan para hoy» escrito sin más), el plan es el de siempre (ADR-039).

### 3. Las reglas del plan

Las de ADR-039 siguen valiendo: un evento terminado nunca es una parada y un destino con horario nunca es una parada mientras está cerrado. Se suman:

1. **El tiempo pedido se respeta:** ninguna parada termina después de «ahora + el tiempo pedido» (y nunca después de las 22:00). El día completo termina a las 22:00. La vuelta no se cuenta.
2. **Cada destino dura su tiempo de visita** (o 45 min). Se acorta para que quepa antes de que cierre o antes del fin del plan, pero nunca a menos de 30 min (o de su tiempo, si es menor): si no cabe, no entra.
3. **Topes de paradas:** 1 hora: 3; 2 horas: 4; medio día: 6; más de 4 horas: 6; día completo: 8, sin contar el almuerzo.
4. **Con niños:** nunca los «no recomendados»; los «aptos» valen un desvío de hasta 20 minutos a pie; ningún tramo pasa de 1,5 km (5 km sin niños).
5. **Almuerzo (día completo):** si el plan está entre las 11:30 y las 14:00 sin haber almorzado, la siguiente parada es el almuerzo: el servicio «Dónde comer» más cercano a menos de 1,5 km que esté abierto toda la hora (o sin horario publicado: «confírmalo»), 60 min. Sin ninguno, una **pausa «Almuerzo»** de 60 min donde está el visitante. Mientras el almuerzo está pendiente, ninguna visita termina después de las 14:00. Un plan que empieza después de las 14:00 no lleva almuerzo.
6. **Las paradas de almuerzo** son de tipo `service` (con enlace a su tarjeta en `/servicios#…`, o a su página en la web del municipio) o `pause` (sin lugar ni enlace). El mapa de la ruta suma los servicios; una pausa no es un punto.
7. **Distancias desde el teléfono:** `/asistente/lugares` suma los lugares para comer cuando el plan puede usarlos (módulo de servicios), con la clave `service:{dirección}`; la posición sigue sin salir del dispositivo.

### 4. En el asistente

1. **«Plan para hoy» abre opciones** debajo de los botones: «1 hora», «2 horas», «Medio día», «Día completo» y la casilla «Con niños». Elegir una envía la pregunta («Plan de 2 horas con niños») con su `visit`.
2. **El título dice el tipo:** «Plan de 2 horas», «Medio día con niños», «Día completo». El resumen suma «Termina a las 17:30».
3. **Cada parada apta para niños** lleva «Apto para niños» cuando el plan es con niños. El almuerzo lleva «Almuerzo».
4. **Lo que lee el modelo** suma el tipo de visita y las paradas de almuerzo; sigue sin distancias.
5. **Sin nada que quepa** en el tiempo pedido, el asistente lo dice y sugiere un plan más largo o la agenda.

### 5. En el panel

1. **Editor del destino:** «Para tu plan» con «Tiempo de visita» (sin indicar, 15 min, 30 min, 45 min, 1 h, 1 h 30 min, 2 h, 3 h, 4 h) y «Para ir con niños» (sin indicar, apto, no recomendado).
2. **Editor del evento:** «Para ir con niños».

## Consecuencias

- **Gana:** el plan responde a lo que el visitante pide de verdad, con datos del municipio y no inventados por el modelo; el almuerzo usa los servicios que el municipio ya cargó.
- **Costo:** dos columnas y un campo más en dos editores; mientras el municipio no los complete, «Con niños» solo acorta los tramos y cada destino dura 45 min.
- **Límites:** las distancias y los tiempos siguen en línea recta; un plan no vuelve al punto de partida; los servicios no tienen el dato de niños; el almuerzo no se reserva.
