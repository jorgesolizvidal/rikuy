# ADR-071 — «Solo asistente»: el asistente en la web del municipio y por QR

- **Estado:** Aceptada — 2026-11-25
- **Concreta:** A · Paso 2 («Solo asistente»)
- **Se apoya en:** ADR-015 (municipio por el host), [ADR-024](ADR-024-portal-page-cache.md) (caché por municipio), [ADR-038](ADR-038-visitor-assistant.md) (asistente del visitante), [ADR-060](ADR-060-tenant-modules.md) (módulos) y [ADR-065](ADR-065-assistant-design.md) (tarjetas en las respuestas)

## Contexto

Muchos municipios ya tienen su propia web y no quieren un segundo sitio. Lo que les falta es el asistente: que responda con su historia, su museo, sus servicios y sus avisos. La fase A pide venderles **solo el asistente**: insertado en su web, sin portal de Rikuy, y con un QR por lugar para los carteles.

Hoy el asistente vive solo dentro del portal: se abre con el botón flotante, sus respuestas enlazan a las fichas del portal y `POST /asistente` solo acepta peticiones del mismo portal (ADR-038).

Decisiones del usuario (2026-11-25):

- **una línea de script:** el municipio pega un `<script>` en su web; aparece el botón flotante y el asistente se abre en un marco servido por Rikuy, así sus estilos no chocan con los de la web;
- **solo el operador** autoriza en qué dominios se puede insertar el asistente de un municipio;
- **el QR «Pregúntale a …»** de cada lugar abre **una página del asistente en Rikuy**: mínima, con la marca del municipio y el asistente a pantalla completa, ya con el contexto del lugar;
- **enlace en su web, por contenido:** cada destino, evento, aviso, servicio o relato puede tener «Página en la web del municipio»; sin portal y sin ese enlace, la fuente se muestra sin enlace.

## Decisión

### 1. El portal público es un módulo

1. **Un módulo nuevo, «Portal público» (`portal`)**, primero en el catálogo y encendido en todos los municipios que ya existen. **Mapa, Tours 360° y Pasaporte** lo necesitan (los modelos 3D siguen necesitando los tours). Agenda, servicios, memoria, asistente, voz y Copilot no: sin portal siguen siendo conocimiento del asistente.
2. **Un paquete nuevo, «Solo asistente»:** asistente, voz, agenda, servicios locales, memoria de la comunidad y Copilot. Los destinos y los avisos están siempre.
3. **Sin portal, el proxy deja pasar solo** las páginas del asistente (`/preguntar`, `/insertar`), sus llamadas (`/asistente…`), la privacidad, los términos, los íconos, el manifiesto, `robots.txt` (que pide no indexar nada) y el conteo de visitas. **`/` lleva a `/preguntar`** (307) y todo lo demás responde el 404 del municipio. Las páginas en caché no cambian: el proxy decide antes de la caché. La privacidad y los términos se ven con una cabecera y un pie mínimos, sin enlaces a secciones que no existen.
4. **Durante el despliegue** la web sale minutos antes que la migración. La lectura del registro de hosts reconoce una base anterior (no devuelve las webs autorizadas) y le suma el portal a sus módulos: ningún portal desaparece en esos minutos. En el panel, en esos minutos, pueden faltar el enlace y el QR del portal.

### 2. Dónde se puede insertar

1. **`assistant_embed_origins`**: por municipio, hasta 10 **orígenes** (`https://www.municipio.gob.bo`, sin ruta). Solo `https`; `http` solo para `localhost` y `127.0.0.1` (desarrollo y pruebas). RLS sin permisos para nadie.
2. **Solo el operador con segundo factor** los agrega y los quita (`platform_add_embed_origin`, `platform_remove_embed_origin`, auditados `platform.embed_origin_added` / `…_removed`), desde la página de módulos del municipio. Cualquier miembro ve la lista en su panel (`tenant_embed_origins`).
3. **El registro de hosts los devuelve** junto con el municipio (`resolve_tenant_by_host`), así el proxy los tiene sin otra consulta. Un cambio tarda hasta 60 s en llegar a todas las instancias (la caché del registro, ADR-015).

### 3. La línea de script

1. **`<script src="https://{dirección del municipio en Rikuy}/insertar.js" async></script>`**: un archivo estático, el mismo para todos, que lee su propio origen de `document.currentScript`. Opcional: `data-lugar="destinos/{dirección}"` o `"agenda/{dirección}"` en una página de su web sobre ese lugar, para que el asistente responda con su contexto.
2. **El script pide la marca** (`GET /insertar/marca`): nombre del asistente, colores y el texto del botón. La respuesta lleva `Access-Control-Allow-Origin` **solo para un origen autorizado**: en otro sitio el script no recibe nada y no muestra nada.
3. **El botón** se dibuja en un _shadow DOM_ (los estilos de la web no lo tocan) con el color del municipio. Al acercar el puntero o el foco se prepara el marco; al tocarlo se abre.
4. **El marco** (`/insertar`) es una página de Rikuy con el asistente a pantalla completa. Sale con `Content-Security-Policy: frame-ancestors 'self' {orígenes autorizados}`: **ningún otro sitio puede mostrarlo**. Todas las demás respuestas siguen con `X-Frame-Options: DENY`, ahora puesto por el proxy. El marco recibe `allow="microphone; geolocation"` para el dictado y los planes.
5. **Cerrar** («×» o Escape) avisa a la página con `postMessage` (sin datos); el script oculta el marco y devuelve el foco al botón. El script solo escucha mensajes de su propio marco y de su origen.
6. Las preguntas siguen yendo a `POST /asistente` **desde el marco**, que es del mismo origen que el portal: el control de origen de ADR-038 no cambia y ningún otro sitio puede llamar al asistente desde el navegador. La conversación se guarda en el navegador, separada por cada web donde se inserta.

### 4. La página del QR

1. **`/preguntar`** (todo el municipio) y **`/preguntar/destinos/{dirección}`** o **`/preguntar/agenda/{dirección}`** (un lugar publicado; si no, 404). Con la marca del municipio, «Pregúntale a {nombre}», el lugar con su foto y el asistente abierto en la página, con las preguntas sugeridas de una ficha. Sin indexar. Con portal, enlaza a la ficha; sin portal, a la página de su web si la tiene.
2. **Existe para todos los municipios con el asistente**, con o sin portal: el QR de una ficha (que abre el portal) y el de «Pregúntale a …» conviven en el editor.
3. **En el panel:** el editor de cada destino y evento publicado suma el QR «Pregúntale a …» (PNG y SVG); la página nueva **«Asistente en tu web»** (grupo «Para visitantes») tiene las webs autorizadas, la línea para copiar, cómo usar `data-lugar`, y el QR y el enlace de `/preguntar`.

### 5. A dónde enlazan las respuestas

1. **`content_items.web_url`**: «Página en la web del municipio», opcional, en destinos, eventos, avisos, servicios y relatos. Solo `https` (o `http` local), sin usuario ni contraseña, hasta 500 caracteres y **en un origen autorizado** del municipio. La ponen y la quitan propietarios y administradores (`set_content_web_link`, auditado `content.web_link_set`); no tiene versiones (es un dato de dónde está, no del contenido). Solo aparece en el editor cuando el municipio tiene webs autorizadas.
2. **`portal_web_links`** (anónima): los enlaces de lo publicado de un municipio en línea **cuyo origen sigue autorizado**. Quitar un origen apaga sus enlaces al momento.
3. **Las respuestas se arman igual y el servidor decide el enlace al final** (`POST /asistente?canal=…`), para las fuentes, las paradas de un plan y las tarjetas:
   - **en el marco de su web** (`canal=insertar`) o **sin portal**: la página de su web si la tiene;
   - si no, con portal, la ficha del portal; sin portal, **sin enlace** (la tarjeta y la fuente se ven igual);
   - sin portal, el asistente no ofrece secciones del portal ni «Ver la ruta en el mapa», ni las nombra en sus instrucciones.
4. **En el marco**, un enlace a su web abre en la misma ventana de la web (`_top`) y uno al portal o a un sitio externo, en otra pestaña. En la página del QR, lo que sale del portal abre en otra pestaña.

## Consecuencias

- Un municipio con web propia tiene el asistente en su sitio con una línea, y nadie más puede mostrarlo: el marco no carga fuera de sus orígenes y el asistente no responde fuera de su propio marco.
- Vender «Solo asistente» es elegir el paquete al dar de alta; pasar a portal completo es encender módulos, sin migrar nada.
- La caché del registro hace que autorizar o quitar una web tarde hasta un minuto.
- El botón en la web del municipio pide un JSON pequeño al cargar la página; el marco y el asistente se descargan solo al acercarse o tocarlo.
- La web del municipio puede bloquear el micrófono o la ubicación con su propia `Permissions-Policy`; entonces el dictado y los planes con ubicación no funcionan dentro del marco (la página del QR sí).
- Las métricas por canal (portal, web, QR) llegan con el Paso 5; ahora el canal solo decide los enlaces.
- La ficha pública del portal sigue siendo la única con datos estructurados (SEO); un municipio sin portal depende de su web para los buscadores.
