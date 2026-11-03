# ADR-038 — Asistente del visitante en el portal: buscar y responder en una sola pregunta, con citas validadas

- **Estado:** Aceptada — 2026-11-02
- **Concreta:** ADR-022, ADR-036, ADR-037 y el cierre de P0 (D4–D7) para el roadmap P5 · Paso 3

## Contexto

El gateway de IA (Paso 1) y el conocimiento del asistente (Paso 2) ya existen, pero el visitante todavía no puede preguntar nada. Este paso agrega la conversación al portal.

Condiciones:

- **Groq gratuito**: 8.000 tokens por minuto y 200.000 por día para toda la organización. Una pregunta tiene que costar pocos tokens, o dos visitantes a la vez agotan el minuto.
- La búsqueda es de texto completo en español (ADR-037). No entiende preguntas en inglés ni seguimientos como «¿y a qué hora abre?».
- Un municipio no puede inyectar instrucciones al modelo desde su marca: el asistente no debe hacer otra cosa porque alguien escribió un texto en el panel.
- Ningún nombre de municipio ni de su asistente en el código («Chaski» es un dato de la marca de Ucureña).

Decisiones del usuario (2026-11-02):

- El asistente se abre con un **botón flotante** en todas las páginas del portal. En el celular ocupa la pantalla completa y en la PC es un panel lateral.
- El **tono** se elige entre opciones fijas: «Cercano» o «Formal». No hay texto libre.
- El asistente responde **en el idioma de la pregunta** (inglés si se pregunta en inglés; si no, español). El portal sigue en español.

## Decisión

1. **Persona en la marca.** `TenantPresentation.assistant` es opcional: `{ name (1–40), greeting (0–240), tone: "warm" | "formal" }`, con la misma validación en la base (`private.is_valid_presentation`). Sin nombre, el portal usa «Asistente». Sin saludo, se arma uno a partir del nombre del asistente y del portal. El tono elige una de dos instrucciones escritas en el código; el texto del municipio nunca llega como instrucción, solo como dato entre comillas.
2. **Una pregunta = un pedido al gateway**, con una sola reserva y una sola cuenta en el límite del visitante, aunque haga dos llamadas al modelo (`runAiSession`):
   1. **Reformular** solo si hace falta: una pregunta en inglés, un seguimiento (hay conversación) o una pregunta hecha desde la ficha de un lugar. Una línea `BUSCAR: …` con palabras en español; si la línea no llega, se busca con la pregunta tal cual.
   2. **Buscar** con `ai_api.search_knowledge` (rol `rikuy_ai`). Pasan al modelo los 4 mejores pasajes, cada uno recortado a 1.200 caracteres.
   3. **Responder** con los pasajes etiquetados `[F1]…[F4]` y la ficha del municipio `[M]` (nombre, lema, dirección, teléfono, correo y secciones del portal). La respuesta termina con una línea `FUENTES: F1, M` o `FUENTES: ninguna`.
3. **Validación en el servidor**, nunca en el cliente ni en el modelo:
   - las etiquetas se cambian por citas D5 y pasan por `validateCitations`; una cita inventada se descarta y se cuenta;
   - del texto se quitan direcciones web y marcas sueltas; el visitante ve texto plano con párrafos y listas, sin HTML;
   - los enlaces que acompañan la respuesta salen solo de las citas válidas (ficha, evento o tour en su escena) y de las secciones del portal (`PORTAL_PATHS`). El modelo nunca escribe un enlace;
   - **abstención:** sin fuentes de conocimiento, la respuesta se marca como «sin datos publicados» y ofrece el contacto del municipio y las secciones del portal.
4. **Contexto de página.** El cliente solo dice en qué tipo de página está y su dirección (`destination` + `mirador-del-valle`). El servidor busca ese lugar, evento o tour **publicado** del mismo municipio y usa su nombre para reformular. Si no lo encuentra, lo ignora.
5. **Idioma.** Un detector determinista (palabras frecuentes del inglés y del español) decide el idioma de la respuesta y de los avisos. Ante la duda, español.
6. **Conversación en el dispositivo** (ADR-022): hasta 24 h en el almacenamiento del navegador de ese portal, con «Nueva conversación» para borrarla. El servidor recibe solo los últimos 6 mensajes (600 caracteres cada uno) y la pregunta (500). No guarda textos: `ai_requests` registra uso y latencia. La clave del visitante es su dirección IP, que la base guarda solo con un hash que cambia cada día (ADR-036).
7. **Portal liviano.** El botón es un componente mínimo (se muestra solo si la plataforma tiene IA configurada). El panel se carga con import dinámico al tocarlo: ninguna página carga el código del asistente al abrirse. `POST /asistente` en el host del portal, con `Origin` del mismo host, `no-store` y el municipio resuelto por el host.
8. **Gold de 40 casos** (D7) sobre el **contenido de muestra de las demos**, que suma una «Guía para visitantes» de muestra (conocimiento): preguntas sobre lugares, eventos, la guía, los datos del municipio, en inglés, seguimientos, preguntas sin respuesta publicada e intentos de cambiar las instrucciones.
   - En el CI, con el modelo simulado: que cada caso en español encuentre su fuente esperada y que la validación descarte citas inventadas.
   - En producción, con el modelo real: «Evaluar el asistente» en `/plataforma`, en tandas de 5 casos espaciadas para no pasar los 8.000 tokens por minuto, sobre una demo con el contenido de muestra. Cada caso se califica solo: citas válidas, fuente esperada, abstención cuando corresponde e idioma.

## Consecuencias

- (+) La mayoría de las primeras preguntas en español cuestan una sola llamada (unos 2.000–3.000 tokens).
- (+) Una cita inventada o un enlace externo nunca llegan al visitante.
- (+) El municipio cambia el nombre, el saludo y el tono sin tocar código.
- (−) Una pregunta en inglés o de seguimiento hace dos llamadas: algo más de tokens y medio segundo más.
- (−) Con 8.000 tokens por minuto, unas tres preguntas por minuto en toda la plataforma. Más que eso responde «Prueba en unos minutos». Se resuelve con el plan de pago de Groq o una clave por municipio (E4).
- (−) La evaluación con el modelo real gasta cuota del día: se corre a mano y por tandas.
