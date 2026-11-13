# ADR-053 — Lo que preguntan los visitantes: preguntas sin respuesta, enmascaradas, por 90 días

- **Estado:** Aceptada — 2026-11-12
- **Concreta:** C1 · Paso 3 (métricas y estrategia)
- **Cambia en parte:** [ADR-036](ADR-036-ai-gateway.md) y [ADR-038](ADR-038-visitor-assistant.md), que no guardaban ninguna pregunta

## Contexto

Hasta ahora el asistente del visitante no guardaba el texto de ninguna pregunta ni respuesta (ADR-036, ADR-038). Solo quedaban la cuenta de pedidos, su tiempo y su costo. El municipio no sabía qué le falta publicar.

El roadmap pide guardar el texto de las preguntas que el asistente no pudo responder, sin datos del visitante, por 90 días, para que el municipio sepa qué publicar.

Decisiones del usuario (2026-11-12):

- **Quién las ve:** todos los miembros del municipio, como «Estadísticas»: propietarios, administradores, editores y analistas.
- **Qué se guarda:** solo cuando el asistente no supo, es decir, cuando buscó y no encontró nada publicado. No se guardan las preguntas sin respuesta por falta de cuota ni por una falla del proveedor.
- **Agrupar:** juntar las que dicen lo mismo, sin importar mayúsculas, tildes ni signos, y mostrar cuántas veces se preguntó. Sin IA.
- **Datos personales:** ocultarlos al guardar: correo, teléfono, número de documento.

## Decisión

1. **Cuándo se guarda.** `askAssistant` devuelve, aparte de la respuesta, la pregunta a guardar (`unanswered`) solo si se cumplen las cuatro condiciones:
   - el pedido llegó al modelo y este respondió;
   - la respuesta no cita ningún pasaje válido ni los datos del portal (`abstained`);
   - no es la negativa fija a copiar sus instrucciones (S03);
   - no es solo un saludo o un agradecimiento («hola», «muchas gracias», «ok»).

   Nunca se guardan:
   - un plan («qué hay cerca», «plan para hoy», «ruta sugerida»);
   - un aviso por cuota, por el límite del visitante o por el proveedor;
   - la respuesta.

   El portal la guarda con `after()`, después de enviar la respuesta. Si guardarla falla, queda en el registro (solo el resultado, nunca el texto) y el visitante no lo nota.

2. **Qué se guarda.** El texto, enmascarado. Antes de guardarlo, `@rikuy/core` hace dos cosas:
   - quita un saludo al principio («Hola, ¿hay wifi?» → «¿hay wifi?»);
   - reemplaza:
     - un correo por `[correo]`;
     - un enlace por `[enlace]`;
     - un número internacional (con «+») o un celular boliviano (8 dígitos que empiezan con 6 o 7) por `[teléfono]`;
     - seis o más dígitos, aunque estén separados por espacios, puntos o guiones (un carnet, una cuenta, una tarjeta), por `[número]`.

   Las fechas («15-11-2026»), los rangos de años («2025-2026»), los precios y las horas quedan como están. Un nombre propio no se puede reconocer con seguridad y queda.

   La base vuelve a enmascarar por su cuenta (`private.mask_question_text`: correos, enlaces y seis dígitos seguidos). Una restricción de la tabla rechaza un correo o seis dígitos seguidos, así ningún llamador puede guardarlos tal como llegaron. También se guardan:
   - el idioma;
   - el tipo de página;
   - el lugar de esa página, si es de este municipio;
   - la escena, si el tour de ese lugar la tiene.

   **Nada del visitante:** ni su IP, ni su huella, ni la conversación.

3. **Tabla `unanswered_questions`** (migración `20261116000000`, solo expand):
   - FK compuesta `(tenant_id, request_id)` hacia `ai_requests`, con un pedido por pregunta: se borra junto con su pedido;
   - FK compuesta hacia `content_items`: si el lugar se borra, la pregunta queda sin lugar;
   - RLS sin políticas y sin permisos para nadie, ni siquiera para `rikuy_ai`.

   El día es el del municipio, en su zona horaria. La clave de grupo (`private.question_key`) es el texto sin mayúsculas, sin tildes y sin signos.

4. **Quién escribe.** Solo el rol de la IA (`rikuy_ai`), con `ai_api.record_unanswered_question`. La función:
   - acepta solo un pedido del asistente del visitante del mismo municipio, de los últimos 15 minutos, una sola vez;
   - responde `ignored` para cualquier otro caso;
   - guarda como mucho 1.000 preguntas por municipio y día (`capped`).

   Ni los visitantes, ni los miembros, ni la clave secreta pueden escribir.

5. **Quién lee.** Cualquier miembro, con `tenant_unanswered_questions(tenant, 7 | 30 | 90)`: propietarios y administradores con su segundo factor (ADR-043); otro municipio, no. La función devuelve:
   - los grupos del período, los más preguntados primero, hasta 200;
   - de cada grupo: la redacción más reciente, cuántas veces, cuántas personas (distintas por día, sumadas, con la huella del pedido, que no sale de la base), la primera y la última vez, los idiomas y las tres páginas donde más se preguntó, con el nombre actual del lugar y de la escena;
   - el total del período y el primer día con preguntas.
6. **El panel** muestra «Lo que preguntan los visitantes» en `/o/{slug}/preguntas`, enlazado desde la página del municipio:
   - períodos de 7, 30 y 90 días;
   - tres totales: preguntas sin respuesta, preguntas distintas y personas;
   - la lista agrupada, con el enlace al editor del lugar donde se preguntó;
   - en cada pregunta, «Probar esta pregunta en «Conocimiento del asistente»», que abre la búsqueda de prueba con la pregunta ya escrita;
   - «Cómo se guardan».

   Antes de que llegue la migración (la web sale minutos antes), dice que todavía no hay preguntas.

7. **Se olvidan a los 90 días.** La tarea `rikuy-forget-unanswered-questions` (08:27 UTC) las borra. Además, los pedidos de IA se borran a los 90 días (ADR-036) y se llevan sus preguntas.
8. **Privacidad.** La sección «El asistente» de cada portal dice:
   - que se guarda el texto de una pregunta sin respuesta, y por qué;
   - que se guarda sin nada que identifique al visitante, con los datos de contacto reemplazados;
   - que se borra a los 90 días;
   - que conviene no escribir el nombre ni otros datos personales en las preguntas.

## Consecuencias

- El municipio ve qué le preguntan y no sabe responder, y puede probar si lo que publicó ya lo responde.
- Es el primer texto de visitantes que guarda la plataforma: la prueba de que «ninguna columna guarda preguntas» (027) ahora exceptúa esta tabla, y su propia prueba comprueba que no tiene columnas del visitante.
- Agrupar por las mismas palabras no junta «¿hay wifi?» con «¿dónde hay internet?»: son dos grupos. Agrupar por significado gastaría cuota de IA y podría equivocarse; se revisa con el uso real.
- Un nombre o una dirección escritos en una pregunta quedan guardados. La página de privacidad pide no escribirlos.
- Las preguntas alimentan las recomendaciones del Copilot (C1 · Paso 4) y el informe mensual (Paso 5).

## Corrección (2026-11-12, `fix/unanswered-contact-referral`)

En la primera prueba en producción (Ucureña), el usuario escribió «Éste es el número de Ucureña 67680034». Chaski respondió «No dispongo de información sobre el número 67680034. Puedes consultar al portal llamando al … o enviando un correo a …» y citó «Datos del portal».

Como la regla 2 de sus instrucciones le pide sugerir el teléfono o el correo del portal cuando no sabe, el modelo cita `[M]` justo en esos casos. Para el código, eso no era una abstención, así que la pregunta no se guardó.

Ahora la pregunta se guarda si la respuesta no cita ningún pasaje publicado y además:

- no cita nada (la abstención de siempre), o
- dice que no tiene la información, aunque sugiera el contacto del portal: «no tengo / no dispongo de / no encontré información o datos», «no aparece publicado», «I don't have information», «couldn't find any details» (`admitsNotKnowing`).

Una respuesta que sí sale de los datos del portal («El teléfono de la oficina de turismo es…») no se guarda. Lo que ve el visitante no cambia.
