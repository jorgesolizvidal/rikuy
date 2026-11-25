# ADR-069 — Conocimiento más útil: avisos con vencimiento, servicios locales y memoria de la comunidad

- **Estado:** Aceptada — 2026-11-16
- **Concreta:** A · Paso 1 (conocimiento más útil)
- **Se apoya en:** el modelo de revisiones de P3 · Paso 2, [ADR-037](ADR-037-assistant-knowledge.md) (conocimiento y búsqueda), [ADR-038](ADR-038-visitor-assistant.md) (asistente del visitante), [ADR-039](ADR-039-assistant-plans.md) (horario de atención), [ADR-053](ADR-053-unanswered-questions.md) (preguntas sin respuesta) y [ADR-060](ADR-060-tenant-modules.md) (módulos)

## Contexto

La fase A convierte el asistente en el asistente turístico oficial de cada municipio. Lo primero es que sepa lo que un visitante necesita y hoy no encuentra:

- **lo que cambia:** un corte de ruta, una feria suspendida, un cambio de horario. Hoy solo se puede escribir como conocimiento, y queda publicado hasta que alguien se acuerda de retirarlo;
- **los servicios:** dónde comer, dormir, sacar dinero, cargar gasolina o tomar transporte. En Ucureña, las preguntas sin respuesta más frecuentes son justamente la gasolina, el cajero y el teleférico (C1 · Paso 3);
- **la memoria de la comunidad:** lo que cuentan los vecinos, que no está en el libro histórico y que no es historia oficial.

Decisiones del usuario (2026-11-16):

- **un ADR y tres PR:** 1.1 avisos, 1.2 servicios, 1.3 memoria; cada parte se revisa y se prueba en producción antes de la siguiente;
- **avisos:**
  - fin obligatorio, con un máximo de **90 días**; inicio opcional para dejarlo programado; se renueva publicando otra versión;
  - además del asistente, una **franja en todas las páginas del portal** y, si está ligado a un lugar, **en su ficha**;
  - **los publica quien publica destinos** (propietarios y administradores); los editores preparan el borrador;
- **servicios locales:**
  - **lista fija de categorías de la plataforma**;
  - una **página «Servicios»** con tarjetas por categoría (sin ficha por servicio), una **capa en el mapa** y el asistente, que cita la tarjeta;
- **memoria de la comunidad:**
  - **la carga el equipo del municipio** en nombre del vecino, con autor y consentimiento; propietarios y administradores la publican;
  - el asistente la cuenta **siempre como relato atribuido**, nunca como hecho oficial;
  - una **página propia**, una **sección en la ficha** del lugar relacionado y el asistente;
- **módulos:** los avisos no tienen módulo (como los destinos); **«Servicios locales»** y **«Memoria de la comunidad»** son módulos nuevos del catálogo, encendidos para los municipios que ya existen.

## Decisión

### 1. Avisos (PR 1.1)

1. **Un tipo de contenido nuevo, `notice`**, con el mismo flujo de todos: borrador, publicar, versiones selladas, «Volver a esta versión» y auditoría. Como el conocimiento, se puede **retirar** antes de que venza («la ruta ya se abrió»).
2. **Qué tiene un aviso:**
   - un **título** (≤ 120) y el **texto del aviso** en una línea (≤ 300; el resumen de la revisión), que es lo que muestran la franja y la ficha;
   - un **detalle** opcional con el mismo formato de texto de los destinos;
   - la **vigencia** en la hora del municipio: «desde» opcional y «hasta» obligatorio (`notice_from_local`, `notice_until_local`, columnas propias de la revisión, separadas de la fecha de los eventos);
   - un **lugar** opcional: un destino o un evento del mismo municipio (`notice_place_id`, FK compuesta).
3. **Reglas de la vigencia**, en la base y en `@rikuy/core`:
   - «hasta» después de «desde»;
   - al guardar, la vigencia no pasa de 90 días;
   - al publicar, «hasta» todavía no llegó y no está a más de 90 días del momento en que empieza a valer (ahora, o «desde» si es posterior). Renovar es publicar otra versión con otra fecha.
4. **Vigente se comprueba al leer, nunca con un trabajo.** Un aviso está vigente cuando su versión publicada tiene «desde» vacío o ya pasado y «hasta» todavía no llegó, con el reloj de la base y la zona horaria del municipio. Lo comprueban la búsqueda del asistente, las lecturas del portal y el panel. Un aviso que vence deja de usarse en ese mismo instante, sin despublicarlo; su página de historial sigue en el panel.
5. **El asistente los cita primero:**
   - la búsqueda (`private.search_knowledge`) solo devuelve pasajes de avisos vigentes;
   - los avisos vigentes **ligados al lugar de la página** se suman siempre a lo que lee el modelo (`ai_api.place_notices`), aunque la pregunta no los nombre;
   - entre lo que lee el modelo, los avisos van **antes que todo lo demás**, y una regla fija le pide mencionarlos primero cuando tienen que ver con la pregunta;
   - la cita de un aviso enlaza a `/avisos#{dirección}`.
6. **Portal:**
   - una **franja de avisos** arriba de todas las páginas, con los vigentes (hasta 3, el que vence antes primero) y «Ver el aviso»;
   - en la ficha de un destino o evento, sus avisos vigentes;
   - **`/avisos`**: los avisos vigentes con su detalle y su vigencia, sin entrar en el sitemap (son pasajeros);
   - las páginas del portal están en caché (ADR-024): la lectura devuelve también los que empiezan en las próximas 24 h, con sus instantes, y **el navegador muestra solo los vigentes**. Una página guardada nunca muestra un aviso vencido ni uno que todavía no empieza. Publicar, retirar o volver a una versión invalida la caché del municipio, como siempre.
7. **Panel:** «Avisos» (`/o/{slug}/avisos`), en el grupo «Contenido», con su estado en palabras: borrador, programado, vigente, vencido o retirado. El editor tiene el título, el texto, el detalle, «Desde», «Hasta», el lugar, la vista previa de la franja, publicar, retirar y el historial.

### 2. Servicios locales (PR 1.2)

1. **Un tipo de contenido nuevo, `service`**, con el flujo de siempre, en el módulo **«Servicios locales»**.
2. **Categoría de una lista fija de la plataforma:** comer, dormir, cajero o banco, transporte, gasolina, salud, información turística y otro. El nombre de cada una vive en `@rikuy/core`; la base guarda solo la clave.
3. **Qué tiene un servicio:** nombre, descripción corta, el **horario de atención** de los destinos (ADR-039), teléfono o WhatsApp, dirección escrita y ubicación opcional. Sin fotos obligatorias.
4. **Portal:** la página **`/servicios`** con las tarjetas agrupadas por categoría, cada una con su ancla (`/servicios#{dirección}`), «Abierto ahora» calculado en el navegador, llamar y «Cómo llegar»; y una **capa «Servicios»** en `/mapa`, con un ícono por categoría.
5. **Asistente:** el texto indexado lleva la categoría en palabras, el horario y el contacto, así «¿hay cajero?» lo encuentra. La cita lleva a la tarjeta. Los servicios no entran como paradas de los planes (eso queda para el Paso 3).
6. **Detalles fijados al implementarlo (PR 1.2):**
   - para publicar hace falta **la dirección o la ubicación**: sin ninguna de las dos, el visitante no lo encuentra;
   - el WhatsApp se escribe **con el código del país** (`+591…`), porque el enlace `wa.me` lo necesita; el teléfono puede ser local;
   - «Retirar» sirve para un servicio que cerró, como en los avisos y el conocimiento;
   - la capa «Servicios» de `/mapa` **empieza apagada** (el mapa sigue centrado en lo que se visita) y se enciende sola al llegar desde una tarjeta (`?servicios=1`);
   - `/servicios` se enlaza desde la cabecera y el pie (en el celular la barra inferior no tiene lugar) y entra en el sitemap cuando tiene servicios publicados.

### 3. Memoria de la comunidad (PR 1.3)

1. **Un tipo de contenido nuevo, `story`**, con el flujo de siempre, en el módulo **«Memoria de la comunidad»**.
2. **Qué tiene un relato:** título; **autor** (su nombre o «anónimo» si así lo pidió); la comunidad o su relación con el lugar; un destino relacionado opcional; el texto; y una casilla obligatoria para publicar: **«La persona aceptó que se publique su relato»**, que queda en la revisión y en la auditoría. Por ahora es solo texto; los audios llegan con las audioguías.
3. **Quién lo escribe:** el equipo del municipio, en nombre del vecino. No hay formulario público.
4. **Portal:** la página **`/memoria`** con los relatos y una sección **«Lo que cuenta la comunidad»** en la ficha del destino relacionado.
5. **Asistente:** el pasaje de un relato llega al modelo como «Relato de {autor}», y una regla fija le pide contarlo **siempre atribuido** («Según el relato de…»), nunca como hecho oficial; si choca con la historia publicada, menciona las dos versiones, como ya hace con los textos que se contradicen (gold con el modelo real, P6 · Paso 3).
6. **Detalles fijados al implementarlo (PR 1.3):**
   - «Anónimo» **no guarda el nombre**: ni el borrador ni la versión publicada lo tienen (la base lo impide con una restricción), y el portal dice «Relato anónimo»;
   - el relato se escribe con el mismo formato de texto que los destinos; para publicar hace falta el texto, quién lo cuenta (o «anónimo») y la casilla de permiso, que también queda en el `diff` de la auditoría de cada publicación;
   - el destino relacionado es solo un destino (no un evento);
   - cada pasaje indexado empieza con «Relato de {autor} ({comunidad}).» o «Relato anónimo de la comunidad.», así el modelo sabe de quién es aunque lea un fragmento del medio; la cita lleva a `/memoria#{dirección}`;
   - `/memoria` se enlaza desde la cabecera y el pie, entra en el sitemap con relatos publicados, y la página de privacidad explica cómo pedir que se retire un relato;
   - el paquete «Solo información» incluye el módulo.

### 4. Módulos

- Los **avisos** no tienen módulo: un aviso de seguridad no depende del plan contratado.
- **`services`** («Servicios locales») y **`community_memory`** («Memoria de la comunidad») entran en `platform_modules` con su PR. Un municipio nuevo los recibe como todos los módulos, y la migración se los da a los que ya existen. Con el módulo apagado, sus páginas responden 404, sus enlaces desaparecen, el asistente no lee sus pasajes y la base no deja crear contenido de ese tipo (`PT403`).

## Consecuencias

- Los tres son tipos de contenido: heredan sin código nuevo las revisiones, la auditoría, los permisos, la indexación del asistente y sus citas.
- **Un aviso vencido no se usa en ningún lado desde el instante en que vence**, sin despublicarlo: lo garantiza la consulta, igual que un borrador nunca aparece (ADR-037). Es el criterio del paso.
- Cada función que trata los tipos de contenido tiene que nombrar los nuevos de forma explícita: las que hoy hacen «si no es un evento, es un destino» se revisan en cada PR.
- La franja de avisos agrega un poco de HTML a todas las páginas; el navegador solo compara fechas, sin JavaScript nuevo pesado.
- Los relatos guardan el nombre de una persona: es un dato que publica el municipio con el consentimiento registrado; si alguien pide retirarlo, se retira su relato.
- Las preguntas sin respuesta de Ucureña (gasolina, cajero) se responden con servicios. El teleférico probablemente no existe: se responde con un texto de conocimiento que lo diga. Ese contenido lo carga el usuario en producción después del merge.
