# ADR-026 — Pipeline de modelos 3D (GLB): Meshopt, KTX2 verificado y poster capturado en el panel

- **Estado:** Aceptada — 2026-10-25 (decisión del usuario sobre la imagen poster)
- **Concreta:** el [presupuesto de rendimiento](../performance-budget.md) («GLB ≤ 5 MB aviso, ≤ 15 MB rechazo; Meshopt/Draco + KTX2; imagen poster») y la arquitectura §8 («verificación de color»)

## Contexto

El sistema anterior guardaba la URL de un GLB y lo mostraba con Draco, sin validar ni optimizar nada. Los modelos de los municipios salen de Blender u otras herramientas y a veces **pierden o cambian sus colores** al exportarse. El pipeline debe correr dentro de una función de Vercel (ADR-019), sin binarios nativos ni tarjeta gráfica.

Pruebas hechas antes de decidir (modelo sintético con colores por vértice, texturas y materiales PBR, y el modelo real `ametralladora-opt.glb` de Ucureña):

| Opción                                       | Archivo     | Memoria de video | Colores (ΔE medio) |
| -------------------------------------------- | ----------- | ---------------- | ------------------ |
| Original (Draco + WebP, ya optimizado antes) | 0,48 MB     | ~67 MB           | —                  |
| Meshopt + WebP original                      | 0,62 MB     | ~67 MB           | sin cambios        |
| **Meshopt + KTX2 ETC1S**                     | **1,25 MB** | **~8 MB**        | **0,95–1,4**       |
| Meshopt + ETC1S (color) + UASTC (normales)   | 2,31 MB     | ~11 MB           | 0,95–1,4           |

- En geometría, Meshopt «high» queda igual que Draco una vez comprimido (20 KB contra 20 KB con gzip) y se decodifica más rápido en el celular. Draco solo se lee (se decodifica al entrar).
- En ETC1S, los mapas de normales tienen un error medio de 1,6°, aceptable para un objeto que se abre desde un hotspot.
- El codificador KTX2 (Basis Universal en WASM) no acepta texturas de 4096 × 4096 (límite ~12 Mpix), y una de 2048 tarda ~14 s.

## Decisión

1. **Validar primero, sin confiar en el archivo:**
   - Leer el JSON del GLB antes que nada.
   - Rechazar archivos externos (cualquier `uri` que no sea `data:`) y extensiones requeridas que el visor no admite.
   - Pasar el validador oficial de Khronos.
   - Rechazar más de 2 millones de triángulos o 64 texturas.
2. **Geometría: Meshopt «high»**, con colores por vértice en 10 bits (Meshopt usa 8 por defecto). Nunca se quitan atributos ni se convierten texturas en factores (`prune` conservador).
3. **Texturas: KTX2 según su uso.**
   - **Codificación por uso:**
     - las de color (`baseColor`, `emissive`, `sheenColor`, `specularColor`) en sRGB;
     - las de datos (metal, rugosidad, oclusión) en lineal;
     - los mapas de normales con el preset de normales.
   - **Tamaño:** como mucho 2048 px por lado en la copia optimizada.
   - **Verificación al decodificar.** Cada textura se decodifica de nuevo y se compara con la fuente:
     - color en ΔE CIELAB (tolerancia: media 2, p95 4);
     - normales en grados (3°/8°);
     - datos en 0–255 (4/12);
     - alfa como dato.
   - **Escalera de respaldo:** ETC1S → UASTC → la imagen original sin tocar.
4. **Texturas usadas como color y como dato a la vez se separan.**
   - KTX2 guarda una sola función de transferencia por textura, así que la textura se separa en una copia sRGB y otra lineal.
   - El material que la usa como color se informa como **sospechoso**: casi siempre es un error de exportación. En el modelo real, la pieza dorada tenía como color el mapa de rugosidad de otra pieza.
   - Además, three.js marcaba esa textura compartida como sRGB también para su uso como dato. Separarla hace que se dibuje como corresponde.
5. **Verificación del modelo completo.** Se lee el archivo escrito y se compara con el subido, primitiva por primitiva:
   - factores, modos y ranuras de cada material;
   - colores por vértice, por cercanía en espacio de mundo.
   - Si algo cambió, se rechaza con `colors_changed`.
6. **Peso:** hasta 5 MB está bien; de 5 a 15 MB queda listo y marcado como «pesado»; más de 15 MB se rechaza.
7. **Imagen poster capturada por el panel** (decisión del usuario). El servidor no tiene GPU. Cuando un modelo queda listo, el panel lo dibuja con **el mismo visor que usará el portal** y guarda la captura (WebP o PNG de ≤ 900 KB). El servidor la recodifica a WebP ≤ 1280 px, sin metadatos. El editor puede girar el modelo y elegir otra vista.
8. **Visor:** three.js con KTX2Loader (el transcodificador se sirve desde nuestro origen, `/vendor/three/<versión>/basis/`) y MeshoptDecoder, cargado solo cuando se muestra.
   - Salida sRGB y tono «Khronos PBR Neutral», pensado para conservar los colores base.
   - Entorno neutro (`RoomEnvironment`), sin luces de color.
9. **Comparación automática en CI, en un navegador real:**
   - El procesador y el optimizador reales optimizan un modelo sintético.
   - three.js dibuja el original y el optimizado desde la misma cámara, con WebGL por software (SwiftShader).
   - Se compara el ΔE de las superficies; los bordes se excluyen, porque se mueven un subpíxel al cuantizar.
   - Resultado local: ΔE medio 0,35 y p95 1,07 en el sintético; el modelo real también queda dentro de la tolerancia (media ≤ 2).

## Consecuencias

- (+) Los modelos ocupan ~8 veces menos memoria de video en el celular, que además tiene cargado el panorama del tour.
- (+) Ningún color cambia sin que el pipeline lo detecte, y los errores de exportación más comunes se señalan con el nombre del material.
- (−) Un GLB que ya venía con WebP muy comprimido puede **pesar más** una vez optimizado (0,48 → 1,25 MB en el modelo real): se cambia peso de descarga por memoria de video y decodificación en la GPU. Sigue dentro del presupuesto de 5 MB.
- (−) Una textura de 2048 px tarda ~14 s en ETC1S y la codificación bloquea el hilo de la función mientras dura. El ejecutor guarda un punto de control por textura y el trabajo tiene hasta 240 s por intento. La ruta del ejecutor tiene su propia configuración (`maxDuration` 300), así que no comparte instancia con las páginas.
- (−) El poster depende de que alguien con rol de edición abra «Modelos 3D» una vez que el modelo está listo. Mientras tanto, el modelo no tiene imagen. Los tours (P4) exigirán poster al publicar.
- Si se pasa a una tarjeta gráfica o a un ejecutor fuera de Vercel, el poster podría generarse en el servidor sin cambiar el manifiesto.
