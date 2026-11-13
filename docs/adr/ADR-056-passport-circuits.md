# ADR-056 — Pasaporte turístico: circuitos

- **Estado:** Aceptada — 2026-11-13
- **Concreta:** C2 · Paso 1 (pasaporte turístico con sellos QR)
- **Se apoya en:** [ADR-024](ADR-024-portal-page-cache.md) (caché del portal por municipio) y [ADR-039](ADR-039-assistant-plans.md) (ruta en el mapa)

## Contexto

El roadmap pide un pasaporte turístico: circuitos de lugares; el visitante escanea el QR de cada sitio y junta sellos en su teléfono; al completar un circuito recibe el premio que defina el municipio. Criterio de la fase: lleva a visitar más lugares y da la mejor medida de **visitas reales en el lugar**.

Pasos de C2 confirmados por el usuario (2026-11-13):

1. **circuitos** (este ADR);
2. sellos con QR en cada lugar, guardados en el teléfono;
3. premio y canje al completar el circuito;
4. métricas del pasaporte en «Estadísticas» y en el informe mensual.

Decisiones para toda la fase:

- **sello:** QR firmado por lugar, más la ubicación si el visitante la comparte (si no, el sello vale y queda marcado «sin ubicación»);
- **sellos solo en el teléfono:** sin cuenta ni datos personales;
- **premio:** un comprobante con un código corto que el local verifica en una página del portal, una sola vez.

Decisiones de este paso:

- **las paradas son solo destinos:** tienen un lugar fijo donde pegar el QR todo el año. Un evento dura poco y dejaría el circuito imposible de completar;
- **cualquier orden:** el circuito sugiere un orden, pero cada sello vale cuando se consigue;
- **varios circuitos** por municipio, cada uno con su premio;
- **roles como los destinos:** los editores arman borradores; propietarios y administradores publican, retiran y cambian lo publicado.

## Decisión

1. **Base de datos** (`20261119000000_c2_passport_circuits.sql`, solo expand):
   - `passport_circuits`:
     - dirección única por municipio (`/pasaporte/{dirección}`), nombre (1–80), descripción (≤ 300) y premio en palabras (≤ 200), todo en una línea;
     - estado `draft` o `published`, número de edición y fecha de la primera publicación.
   - `passport_circuit_stops`:
     - el contenido y su posición (1–30), con FK compuestas;
     - un trigger exige que sea un destino.
   - RLS sin permisos para nadie: todo pasa por funciones.
   - `tenant_passport_circuits` (cualquier miembro) lista los circuitos, con cada parada y si su destino está publicado.
   - Funciones de escritura, todas con el número de edición que vio la persona (`PT409` si cambió) y auditadas:
     - `create_passport_circuit` (editores o más);
     - `save_passport_circuit`:
       - nombre, descripción, premio y paradas en orden;
       - destinos del mismo municipio, sin repetir, como mucho 30;
       - un circuito publicado solo lo cambian propietarios y administradores, y nunca queda con menos de dos destinos publicados;
     - `publish_passport_circuit` (propietarios y administradores): exige dos paradas con destino publicado;
     - `withdraw_passport_circuit`: vuelve a borrador;
     - `delete_passport_circuit`: solo uno que nunca se publicó. Uno que los visitantes vieron se retira, porque sus sellos y premios (Pasos 2–3) lo nombran.
   - `portal_passport` (anónima, municipios en línea) devuelve los circuitos publicados:
     - con las paradas cuyo destino está publicado ahora, en el orden sugerido, con su portada y ubicación;
     - un circuito que se quedó con menos de dos no se muestra.

2. **Portal:**
   - **«Pasaporte»** en la cabecera cuando hay circuitos;
   - una sección en el inicio;
   - **`/pasaporte`**: los circuitos con sus lugares y su premio;
   - **`/pasaporte/{dirección}`**:
     - las paradas en el orden sugerido, numeradas, con la tarjeta de cada destino;
     - el premio;
     - «Ver el recorrido en el mapa», que reutiliza la ruta de ADR-039 con hasta 6 paradas;
   - «Cómo funciona» anuncia los sellos como «muy pronto» hasta el Paso 2;
   - el sitemap suma `/pasaporte` y cada circuito;
   - publicar, retirar o cambiar un circuito publicado invalida la caché del municipio (ADR-024).

3. **Panel, «Pasaporte turístico»** (`/o/{slug}/pasaporte`):
   - la lista con estado y paradas;
   - «Nuevo circuito», con la dirección sugerida a partir del nombre;
   - el editor:
     - nombre, descripción, premio;
     - paradas con «Subir», «Bajar» y «Quitar», y «Agregar un destino» (los sin publicar se marcan);
     - «Guardar», «Publicar el circuito» con lo que falta, «Retirar del portal» y «Borrar el circuito» (solo si nunca se publicó, con confirmación);
     - el enlace y el QR del circuito cuando está publicado.
   - Un editor ve un circuito publicado sin poder cambiarlo.

## Consecuencias

- El municipio arma sus circuitos con lo que ya tiene publicado y los muestra antes de imprimir un solo QR de sello.
- Un destino que deja de estar publicado sale del circuito en el portal sin tocar el circuito. Si quedan menos de dos, el circuito desaparece del portal hasta que vuelva a tener dos.
- Las visitas a `/pasaporte` todavía no se cuentan en «Estadísticas»: llegan con el Paso 4.
- El QR del panel abre la página del circuito. El QR de sello de cada lugar es otro, y llega con el Paso 2.
