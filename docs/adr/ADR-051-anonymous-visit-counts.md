# ADR-051 — Conteo anónimo de visitas por municipio

- **Estado:** Aceptada — 2026-11-12
- **Concreta:** C1 · Paso 1 (métricas y estrategia, E2 adelantado)

## Contexto

C1 tiene que mostrarle a cada municipio cómo crecen sus lugares y eventos: qué se mira, qué recorridos se usan, cuántos llegan por un código QR y de dónde vienen. Hasta ahora la plataforma no cuenta visitas. Lo único que hay es Speed Insights de Vercel, que mide velocidad y no visitas por lugar.

Condiciones:

- Las páginas del portal salen de la caché de Vercel (ADR-024). El servidor no ve cada visita, así que el conteo lo tiene que enviar el navegador.
- Sin datos personales ni cookies de seguimiento (roadmap C1). La página de privacidad lo explica.
- El aislamiento entre municipios es innegociable: el municipio sale del host, nunca del navegador.
- Planes gratuitos: una escritura pequeña por evento, sin servicios nuevos.

Decisiones del usuario (2026-11-12):

- **Pasos de C1:**
  1. conteo anónimo (este ADR);
  2. panel «Estadísticas» del municipio;
  3. lo que preguntan los visitantes y lo que queda sin respuesta;
  4. recomendaciones del Copilot a partir de las métricas;
  5. informe mensual para la alcaldía.
- **Visitantes sin cookies:** una huella del día (dirección y navegador con una sal que cambia cada día) para contar personas distintas por día.
- **Escaneos de QR:** los códigos nuevos del panel abren la dirección con una marca (`?qr=1`), que la página cuenta y quita. Los ya impresos funcionan igual, pero no se cuentan.
- **Origen aproximado:** país y ciudad, como los estima el CDN a partir de la conexión, sin guardar la IP.
- **Conservación:** solo totales por día, sin límite de tiempo.

## Decisión

1. **Qué se cuenta.** El navegador envía `POST /visita` (con `sendBeacon`, sin esperar respuesta) cuando:
   - **se abre una página:** inicio, destinos, agenda, mapa, recorrido general, ficha de un destino o evento, y el tour de un lugar. Al saltar entre tours en el recorrido general, se cuenta la página de cada tour;
   - **se muestra una escena de un tour.** Se cuenta en la página de su tour, también cuando la muestra el recorrido general;
   - **se toca un botón:** «Cómo llegar» o «Compartir» en una ficha, o «Añadir al calendario» en un evento (elementos con `data-visit`);
   - **se llega por un código QR**, en la ficha, el tour o el recorrido general.

   El cuerpo lleva solo `{ path, event, scene? }`. La página de privacidad y la de términos no se cuentan.

2. **El servidor valida cada envío y nunca le cree al navegador:**
   - el municipio sale del contexto que arma el proxy a partir del host;
   - el envío tiene que venir de este mismo portal (`Origin`, o `Sec-Fetch-Site` en los navegadores que no mandan `Origin`); si viene de otro sitio, 403;
   - el cuerpo puede tener hasta 1 KB;
   - `@rikuy/core` (`parseVisitBeacon`) acepta solo los eventos posibles en cada página;
   - los buscadores, las vistas previas de enlaces, Lighthouse, los navegadores sin pantalla (_headless_) y los scripts no se cuentan;
   - la respuesta es siempre `204` y la escritura ocurre después de responder (`after()`), así que una página nunca espera al conteo.
3. **Quién escribe.** Solo la conexión del ejecutor (`rikuy_worker`), por `worker_api.record_visit`, igual que la telemetría (ADR-044). Ni la clave pública, ni una sesión, ni la clave secreta pueden escribir. La base vuelve a comprobar:
   - que el municipio está en línea;
   - que el lugar está publicado y es de ese municipio, y que la dirección es del tipo correcto (un evento no cuenta como destino);
   - que la escena está en el tour **publicado** de ese lugar;
   - qué eventos se permiten en cada página.

   Lo que no cumple se ignora sin error.

4. **Qué se guarda:**
   - `visit_daily_counts`: vistas y visitantes por día, página, lugar (`content_id`, que sigue igual aunque cambie la dirección), escena y evento;
   - `visit_daily_origins`: vistas y visitantes por día, país y ciudad. Se cuentan solo las vistas de página.

   El día es el del municipio (su zona horaria), no el de UTC. Los totales no tienen fecha de borrado, y en esas tablas no hay ningún dato de una persona. Las tablas tienen RLS sin permisos: el panel las leerá con funciones en el Paso 2.

5. **Visitantes únicos sin cookies:**
   - `sha256(sal del día ‖ municipio ‖ dirección|navegador)` marca a quien ya se contó ese día, en el sitio y en cada página o evento;
   - la dirección se usa solo para calcular la huella y nunca se guarda;
   - la sal, una por día, no la puede leer nadie;
   - las marcas y las sales se borran a los dos días (tarea `rikuy-forget-visit-marks`, 08:17 UTC), así que días y municipios no se pueden relacionar;
   - una misma huella suma como mucho 500 eventos por día en un municipio: un script que repite envíos no infla los totales.
6. **QR:**
   - `qrCodeUrl` agrega `?qr=1` a la dirección de cada código del panel (fichas, tours y recorrido general);
   - la página cuenta el escaneo además de la vista y quita la marca de la dirección (`history.replaceState`), así un enlace compartido después no cuenta como escaneo.
7. **Origen:** el país y la ciudad salen de las cabeceras `x-vercel-ip-country` y `x-vercel-ip-city`. `visitOrigin` acepta solo un país de dos letras y la ciudad decodificada, sin caracteres de control y con hasta 80 caracteres. Fuera de Vercel no hay origen.

## Consecuencias

- **El municipio va a tener números propios** de vistas, visitantes, escaneos de QR, acciones y origen por día, lugar y escena, sin cookies ni avisos de consentimiento. Los paneles, las recomendaciones y el informe (Pasos 2 a 5) se arman sobre estas dos tablas.
- **Lo que no se cuenta:**
  - quien bloquea JavaScript o los envíos (algunos bloqueadores lo hacen);
  - los robots;
  - los QR impresos antes de este cambio.

  Por eso los números son un **mínimo**.

- **«Visitantes» quiere decir personas distintas en un día**, no en una semana ni en un mes: la huella cambia cada día. Una familia que comparte red y navegador cuenta como una.
- **Costo:** cada envío es una invocación de función y una escritura pequeña en la base. Con el tráfico de la vitrina entra holgado en los planes gratuitos (1 millón de invocaciones al mes en Vercel Hobby); se revisa con el tráfico real.
- El navegador manda el conteo en cada página. El código que lo hace pesa menos de 1 KB y no carga `@rikuy/core`.
- No se respeta todavía `Global Privacy Control`: no hay datos personales ni seguimiento entre sitios. Si una alcaldía lo pide, se agrega sin cambiar el esquema.
