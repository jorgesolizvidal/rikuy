# ADR-031 — Visor público del tour: una página por tour, un visor por recorrido y el tour también como texto

- **Estado:** Aceptada — 2026-10-26
- **Concreta:** ADR-017 (Photo Sphere Viewer + manifiesto propio), ADR-020 (teselas según resolución), ADR-030 (manifiesto público), RC-07 de la auditoría

## Contexto

Con el Paso 3, cada tour publicado tiene un manifiesto sellado y sus medios en el bucket público. Falta lo que ve el visitante.

El sistema anterior tenía tres problemas:

- descargaba todos los puntos de todos los panoramas;
- con toques rápidos podía quedar mostrando una escena vieja;
- sin WebGL no había alternativa.

El presupuesto de rendimiento pide que el visor no esté en el bundle inicial de ninguna página.

## Decisión

1. **Una página por tour:** `/destinos/{dirección}/tour` y `/agenda/{dirección}/tour`.
   - Se cachea por municipio como el resto del portal (ADR-024). Publicar o volver a una versión la invalida.
   - Para abrir una escena se usa `?escena=` en la dirección. Lo lee el navegador, no el servidor, así que cada tour sigue siendo una sola página en la caché.
   - La ficha del destino o evento enlaza al tour («Ver el tour 360°»). El tour está en el sitemap y el panel muestra su enlace y su código QR.
   - El tour de un evento terminado se mantiene, fuera de buscadores, igual que la ficha del evento.
2. **Un solo visor por recorrido** (Photo Sphere Viewer con su adaptador de teselas equirectangulares).
   - Cambiar de escena cambia el panorama sin rehacer WebGL.
   - Cada escena empieza con su vista previa borrosa.
   - Un panorama de hasta 4096 px se entrega como una sola tesela con su imagen. Uno más grande se entrega por teselas, y solo las del nivel que la pantalla necesita.
   - El visor exige un número de columnas que sea potencia de 2. Un nivel que no cumple, como el de 5120 px de una fuente de 5760, se omite, y la escena usa el nivel de 4096.
3. **Siempre gana la última escena pedida.**
   - El texto, la dirección y la lista cambian al instante.
   - El visor cancela la carga anterior. Un número de secuencia propio descarta cualquier respuesta tardía, así que una escena vieja nunca vuelve, ni sus puntos.
4. **El tour también es texto, renderizado en el servidor:**
   - la escena actual y su descripción;
   - sus puntos, como botones o enlaces;
   - todas las escenas en orden;
   - «Anterior» y «Siguiente».
   - Así funciona con el teclado, con un lector de pantalla y para buscadores.
   - Sin WebGL 2 se avisa y se muestra la imagen plana de la escena. Hay que comprobarlo antes de crear el visor, porque Photo Sphere Viewer no lanza un error: deja un visor a medio construir.
5. **Los cuatro tipos de puntos:**
   - información: diálogo con su texto y su galería, foto por foto;
   - flecha: va a la otra escena;
   - modelo 3D: diálogo con su poster (el modelo en 3D llega en el Paso 6, RC-08);
   - «ir a otro recorrido»: abre la página del otro tour (en el Paso 5 lo hará sin salir del visor).
   - Los diálogos son `<dialog>` nativos: atrapan el foco, se cierran con Escape y devuelven el foco al punto que los abrió.
6. **Carga:**
   - three.js y el visor (unos 200 KB) se cargan con import dinámico, después de `load` y cuando el navegador queda libre;
   - la vista previa de la entrada se precarga con prioridad alta y es lo primero en pantalla;
   - las vistas previas de las escenas a las que llevan las flechas se piden por adelantado.
7. **Pantalla completa propia** sobre el escenario (visor, barra y diálogos), no la del visor. Así la barra de escenas y los diálogos siguen visibles. Donde el navegador no la ofrece, como en el iPhone, el botón no aparece.

## Consecuencias

- (+) El visitante descarga solo la escena que mira. La página no tiene el visor en su bundle inicial.
- (+) RC-07 se comprueba en CI con un navegador real: el recorrido completo, toques rápidos con una respuesta tardía y el modo sin WebGL.
- (−) En Lighthouse móvil simulado, la página del tour queda en un rendimiento de 60–69, como `/mapa`: el visor es el contenido y su arranque pesa con la CPU ×4. No tiene umbral de rendimiento propio hasta medirla en un Android real.
- (−) «Ir a otro recorrido» recarga la página hasta el Paso 5.
