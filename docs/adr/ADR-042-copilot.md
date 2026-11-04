# ADR-042 — Copilot V1/V2: revisión con reglas fijas, preguntas sobre una foto autorizada y propuestas con diff que guardan borrador

- **Estado:** Aceptada — 2026-11-04
- **Concreta:** ADR-008 y ADR-036 para el roadmap P5 · Paso 7

## Contexto

ADR-008 fija el Copilot para el equipo del municipio:

- herramientas de dominio tipadas y autorización en cada llamada;
- propuestas que se guardan con su diff, su versión de base, una fecha de vencimiento e idempotencia;
- confirmación humana, y revalidación al ejecutar.

La auditoría (documento 13) separa tres niveles:

- **V1 (leer y analizar):** buscar en el contenido autorizado, listar campos incompletos y explicar métricas, que calcula el dominio y no el modelo;
- **V2 (proponer):** textos y borradores con diff, base y citas; aceptar revalida el permiso y la revisión esperada, guarda **solo un borrador** y nunca publica;
- **V3 (acciones aprobadas):** queda diferido.

En V1 y V2 está prohibido publicar, enviar comunicaciones, cambiar roles, usar SQL libre o usar herramientas fuera del permiso. Las propuestas se conservan 30 días y la conversación no se guarda.

Hechos:

- Las mutaciones de contenido ya existen como RPC por intención, con concurrencia optimista: `save_content_draft` para destinos y eventos, `update_tour_scene` para escenas.
- El gateway de IA (ADR-036) ya cuenta los tokens por municipio con el perfil `copilot` (12.000 de entrada y 2.000 de salida) y registra a la persona que hace el pedido.
- La plataforma todavía no mide visitas (llega con E2).

Decisiones del usuario (2026-11-04):

- **una página propia y un botón en los editores:** la página «Copilot» del municipio para preguntar y revisar, y «Proponer con el Copilot» en el editor de destinos, eventos y escenas;
- **qué propone:** nombre, resumen y texto de destinos y eventos, y nombre y descripción de las escenas de los tours (nunca ubicación, fotos, fechas, puntos ni vistas);
- **roles:** los analistas preguntan y ven la revisión (V1); editores, administradores y propietarios también piden y deciden propuestas (V2);
- **aceptar por campos:** el diff muestra cada campo con su casilla y solo se guarda lo marcado.

## Decisión

1. **Revisión del contenido con reglas fijas** (`copilot_content_review`, cualquier miembro). Lee cada destino y evento en su revisión de trabajo (el borrador, si hay; si no, la publicada) y marca:
   - nunca publicado y cambios sin publicar;
   - sin resumen o con un resumen de menos de 60 caracteres;
   - sin texto o con un texto de menos de 300 caracteres;
   - sin portada y sin ubicación;
   - sin horario (destinos), sin fecha (eventos) y sin tour publicado (destinos);
   - escenas sin descripción, porque la guía del tour no tiene qué contar (ADR-040).

   Los eventos terminados no se revisan. La revisión no usa la IA ni gasta la cuota.

2. **V1, preguntas.** El modelo lee una **foto autorizada** que arma la plataforma con la sesión de la persona:
   - los destinos y eventos (`copilot_snapshot`, borradores incluidos, hasta 60), con su estado, su resumen, la fecha, el tour y lo que les falta;
   - el uso del plan en palabras (almacenamiento, procesamiento e IA de hoy), con las cifras que calcula la base, y que todavía no se miden las visitas;
   - 4 pasajes publicados (la misma búsqueda de ADR-037, con la sesión del miembro).

   Las instrucciones son fijas y lo que viene del municipio va como datos. El modelo responde con etiquetas (`C1`, `F2`, `U`) y el servidor las convierte en enlaces al panel. Una etiqueta que no existe se descarta. Sin IA o sin cuota, aparece un aviso y la revisión sigue funcionando. **La conversación vive solo en la página.**

3. **V2, propuestas** (`copilot_proposals`, RLS sin permisos; todo por RPC):
   - **Base:** la revisión que editaría una persona ahora. Si hay borrador, el borrador con su número de edición; si no, la publicada y un número de edición nulo.
   - **Pedido:** campos, un estilo fijo («Mejorar la redacción», «Más corto», «Más completo», «Tono más formal», «Tono más cercano») y hasta 300 caracteres del equipo, que el modelo lee como datos.
   - **Lo que lee el modelo:** el contenido actual y lo que la plataforma sabe de él (en una escena: el texto del lugar, las otras escenas y sus puntos) y los pasajes publicados del municipio. Escribe con etiquetas fijas (`NOMBRE`, `RESUMEN`, `DESCRIPCION`, `TEXTO … FIN_TEXTO`, `FUENTES`).
   - **Lectura:** el servidor acepta solo los campos pedidos, validados como lo haría la base:
     - una línea con su largo, y si un resumen es largo se corta en una oración;
     - el texto como AST permitido, y un enlace que la base no tenía queda como texto;
     - se descarta lo que trae marcadores como «[completar]»;
     - se quitan los campos sin cambios.
   - **`create_copilot_proposal`** (editor o más) exige la base vigente y lee el valor de «antes» de la base, nunca del pedido. Valida cada valor, guarda solo lo que cambia y exige un pedido `copilot` completado por **la misma persona**, en el mismo municipio y en la última hora. Audita `copilot.proposal_created`.
   - **`accept_copilot_proposal`** (editor o más) exige que la propuesta esté pendiente y no vencida, que los campos marcados sean de la propuesta y que **la base siga vigente**. Si la base cambió, la rechaza (`PT409`, «stale») y no toca nada. Guarda **un borrador** con las RPC de los editores:
     - `save_content_draft` con el documento de la base y los campos marcados;
     - `update_tour_scene` con el número de edición de la base.

     Así valen las mismas validaciones, permisos y concurrencia. Nunca publica. Audita `copilot.proposal_accepted` con los campos.

   - **`reject_copilot_proposal`** la cierra sin tocar nada.
   - Una propuesta vive **30 días**. La tarea diaria `rikuy-expire-copilot-proposals` borra las vencidas; la auditoría conserva lo decidido.
   - No se guardan ni la conversación, ni las instrucciones al modelo, ni su razonamiento.

4. **Panel:**
   - la tarjeta «Copilot» del municipio lleva a `/o/{slug}/copilot`, con la conversación, la revisión (con «Proponer» en lo que el Copilot puede escribir) y las propuestas (pendiente, desactualizada, aceptada, rechazada o vencida);
   - en `/copilot/proponer` se eligen los campos, el estilo y el detalle;
   - `/copilot/propuestas/{id}` muestra un diff por palabras (lo tachado se quita y lo subrayado se agrega, también para lectores de pantalla), una casilla por campo, «Aceptar lo marcado (borrador)» y «Rechazar»;
   - el editor de destinos, el de eventos y cada escena del editor del tour tienen «Proponer con el Copilot».

## Consecuencias

- (+) Se cumple el criterio del paso: aceptar una propuesta sobre una revisión vieja se rechaza y nada cambia. Lo prueban pgTAP, la integración con la pila real y el navegador.
- (+) El modelo no decide el municipio ni los permisos: todo lo que lee sale de la sesión de la persona y toda escritura es una RPC que vuelve a comprobarlos. No tiene herramientas: solo escribe texto que el panel valida.
- (+) La revisión funciona siempre, también sin IA y sin cuota.
- (+) Lo aceptado es un borrador normal: se revisa, se descarta o se publica en el editor, con su historial.
- (−) Una propuesta usa unos 2.000–6.000 tokens de la cuota diaria del municipio (40.000 por defecto), que comparte con el asistente del visitante.
- (−) La propuesta parte de lo guardado: un cambio sin guardar en el editor no se ve, y guardarlo después vuelve la propuesta desactualizada. El panel lo explica.
- (−) El Copilot no ve imágenes: una escena sin texto ni puntos solo recibe una descripción general.
- (−) Sin visitas medidas, el Copilot no explica tráfico; lo dice. Llega con E2.
