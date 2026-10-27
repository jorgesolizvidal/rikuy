# ADR-033 — Modelo 3D en el tour: imagen primero, visor 3D solo a pedido y una descripción como alternativa

- **Estado:** Aceptada — 2026-10-27
- **Concreta:** ADR-026 (pipeline GLB y visor), ADR-029 (puntos del tour), ADR-031 (visor público del tour)

## Contexto

Un punto de modelo 3D mostraba su imagen (poster). RC-08 pide ver el modelo en 3D dentro del tour sin cargarlo antes de tiempo: abrir, cerrar y volver a abrir, reintentar si falla, cuidar el foco y dar una alternativa en texto. En un celular, la memoria de video es lo que se acaba primero, y el panorama del tour ya usa un contexto WebGL.

Los puntos de modelo solo tenían un nombre: no había ningún texto que describiera el objeto a quien no lo puede ver.

## Decisión

1. **Imagen primero.** El diálogo del punto muestra el poster, el peso de la descarga y la descripción.
   - three.js (import dinámico) y el GLB se descargan solo al pulsar «Ver en 3D»: **cero peticiones antes de abrirlo**.
   - Mientras carga, el visor se dibuja sobre el poster, invisible y fuera del alcance del teclado (`inert`), con una barra de progreso. El poster se va recién cuando el modelo está en pantalla, así la caja no cambia de tamaño.
2. **Un mismo visor para el panel y el portal** (`components/model-viewer`): mismos colores que el poster, KTX2 con el transcodificador servido desde nuestro origen y Meshopt. En el portal no se reserva el búfer para capturar y no se desplaza el modelo (solo girar y acercar).
3. **Liberar la memoria al cerrar.** «Volver a la imagen» o cerrar el diálogo desmonta el visor: se liberan geometría, texturas y entorno, y se devuelve el contexto WebGL en el momento (`forceContextLoss`). Al volver a abrirlo, el GLB sale de la caché del navegador.
4. **Fallos sin romper nada:**
   - si el archivo no descarga: aviso y «Reintentar»;
   - si el teléfono pierde el contexto WebGL: vuelta al poster con aviso y «Volver a abrir en 3D»;
   - sin WebGL: el poster y la descripción son el modelo, y el foco va al aviso.
5. **Teclado y movimiento.** Con el modelo enfocado: flechas para girar, + y − para acercar, Inicio para volver a la primera vista. Al quedar listo, el foco pasa al modelo; al cerrarlo, vuelve al botón. Nada se mueve solo (sin giro automático ni inercia), así que «reducir movimiento» no necesita más.
6. **Descripción del modelo.** Los puntos de modelo aceptan el mismo texto enriquecido que los de información (nunca fotos). Es opcional: los puntos ya publicados siguen siendo válidos, y el panel la pide con una explicación de para qué sirve. El manifiesto sellado ya llevaba el texto de cada punto, así que el portal la lee sin cambios en la publicación.

## Consecuencias

- (+) Una ficha o un tour con modelos no descarga ningún modelo hasta que el visitante lo pide; al volver a abrirlo, sale de la caché del navegador.
- (+) Solo mientras el modelo está abierto hay dos contextos WebGL a la vez (panorama y modelo); al cerrarlo queda uno.
- (−) Abrir el modelo descarga el visor (~56 KB comprimido: three.js ya está cargado por el panorama) y el GLB. El peso del GLB se muestra antes de pulsar.
- (−) La descripción depende de que el municipio la escriba; sin ella, la alternativa es el nombre y la imagen.
