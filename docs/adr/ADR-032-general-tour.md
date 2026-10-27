# ADR-032 — Recorrido general: el orden lo elige el municipio y se salta entre tours sin salir del visor

- **Estado:** Aceptada — 2026-10-26
- **Concreta:** ADR-028 (un recorrido general formado por los tours publicados), ADR-031 (visor público), ADR-021 (la ubicación no sale del dispositivo)

## Contexto

Cada tour publicado tiene su página. El usuario pidió un recorrido general en el que el visitante vea todos los destinos y eventos y pase de uno a otro con un menú lateral, sin entrar a cada página.

Además, el municipio debe elegir el orden y el tour de inicio, los eventos terminados no deben aparecer y solo debe descargarse el tour elegido.

## Decisión

1. **El recorrido general no es un contenido aparte.** Lo forman los tours visibles: contenido publicado, tour publicado y, si es un evento, que no haya terminado.
   - El municipio guarda solo su **orden** y el **tour de inicio**, en `general_tours` (una fila por municipio, con número de edición) y `general_tour_entries` (posición por tour, con FK compuestas).
   - No hay borrador: el orden se aplica al guardar y solo lo cambian propietarios y administradores, como al publicar.
   - Un tour que no está en el orden va después, por tipo y nombre. Un tour de inicio que no se ve (por ejemplo, un evento que terminó) se salta y empieza el primero.
2. **`portal_tour_index` devuelve el orden y cuál es el tour de inicio.** Las columnas anteriores siguen igual.
   - El portal lo lee junto con la marca, en paralelo, y la cabecera muestra «Tours 360°» solo si hay tours.
   - **`/recorrido`** abre el tour de inicio.
3. **Un solo visor para todo el recorrido.**
   - El menú (y la píldora «ir a otro recorrido») pide **solo los datos del tour elegido** a `/recorrido/datos`, con caché corta en la CDN. El visor cambia de panorama sin rehacer WebGL.
   - La dirección pasa a ser la página de ese tour (`pushState`): «atrás» vuelve al tour anterior y un enlace compartido lo abre.
   - Un tour ya visto en la visita no se vuelve a pedir.
   - Si se pide otro tour antes de que llegue el anterior, la respuesta tardía se descarta.
4. **Menú lateral** sobre el visor (también en pantalla completa):
   - muestra cada tour con la vista previa de su entrada, cargada solo al abrirlo, su tipo y su número de escenas;
   - cerrado, queda `hidden`: fuera de la vista y del árbol accesible;
   - Escape lo cierra y devuelve el foco al botón que lo abrió;
   - cada entrada es un enlace real.
   - **«Cerca de ti»**: con la ubicación activada, el menú se ordena por distancia en el dispositivo; la posición no sale de él (ADR-021).
5. **Texto:** debajo del visor, «Más tours del municipio» enlaza a los demás tours. Sirve sin JavaScript y para buscadores.
6. **Panel:** en «Tours 360°», la sección «Recorrido general» lista los tours publicados con «Subir», «Bajar» y «Empezar aquí». Indica si cada tour se ve o por qué no, y tiene el enlace y el QR del recorrido.

## Consecuencias

- (+) Dar de alta un tour lo suma solo al recorrido; el municipio solo lo reordena si quiere.
- (+) El visitante descarga un tour a la vez; el menú pesa una vista previa de ≤ 40 KB por tour, y solo si lo abre.
- (−) Cada página del portal lee también el índice de tours, en paralelo con la marca. Si falla, la página sigue igual, pero sin el enlace al recorrido.
- (−) El orden no tiene historial de versiones (sí auditoría). Volver atrás es reordenar.
