# ADR-062 — Inicio por secciones, categorías del municipio y barra inferior

- **Estado:** Aceptada — 2026-11-14
- **Concreta:** C3 · Paso 3 (inicio por secciones, destinos y agenda; barra inferior en el celular)
- **Se apoya en:** la marca versionada de P1 · Paso 5, el modelo de revisiones de P3 · Paso 2, [ADR-060](ADR-060-tenant-modules.md) (módulos) y [ADR-061](ADR-061-portal-themes.md) (temas)

## Contexto

El diseño del usuario en Google Stitch arma el inicio con una portada con foto, una franja de cifras, lugares, eventos y franjas para los recorridos, el pasaporte y el asistente; las páginas de destinos y agenda filtran por categoría, y en el celular las secciones están en una barra inferior. Rikuy mostraba un inicio fijo y no tenía categorías. Cada municipio tiene que poder armar su inicio sin código, y ningún elemento puede mostrar algo que Rikuy no tenga (Stitch inventó calificaciones, validaciones y duraciones).

Decisiones del usuario (2026-11-14):

- **portada con la foto de un destino** que elige el municipio (sin subir nada nuevo);
- **cifras automáticas y propias:** lo que el portal cuenta solo, más hasta 2 escritas por el municipio;
- **barra inferior según los módulos**, sin configuración;
- **categorías del municipio** para filtrar destinos y eventos, con búsqueda por nombre.

## Decisión

1. **El inicio es un dato de la marca** (`home`, opcional, versionado y publicado con ella): la portada (`text` o `photo` con un `destinationId` o `null` = el primero que tenga foto), hasta dos cifras (`value` ≤ 12, `label` ≤ 60, una línea) y hasta seis secciones en orden, cada una una sola vez con una variante del catálogo:
   - `figures` (franja) · `destinations` (cuadrícula o uno destacado) · `events` (lista o tarjetas con foto) · `tours`, `passport`, `assistant` (franjas).

   El contrato de `@rikuy/core` y la base (`private.is_valid_home`) revalidan claves y variantes; un trigger en `tenant_config_versions` exige que el destino de la portada sea un destino del mismo municipio. Sin `home`, el inicio por defecto de la plataforma (todas las secciones, portada con foto).

2. **Cada sección muestra solo lo que existe:** una sección de un módulo apagado no aparece; sin contenido publicado, tampoco. La portada con foto cae a la de texto si el destino no tiene foto publicada. Las cifras automáticas nunca muestran un cero ni un módulo ausente; como mucho cuatro, las del municipio primero.
3. **Las tarjetas dicen solo cosas reales:** la categoría del municipio, «Recorrido 360°» si tiene un tour publicado y «Sello del pasaporte» si es parada de un circuito publicado. Nada de calificaciones, duraciones ni validaciones.
4. **Categorías:** `content_categories` por municipio y tipo (destino o evento), hasta 20 por tipo, nombres únicos sin importar mayúsculas. Las definen propietarios y administradores (`save_content_categories`, reemplaza la lista en orden, auditado). La categoría va en la **revisión** (`content_revisions.category_id`, FK compuesta), así se publica con el resto y vuelve con «Volver a esta versión». Quitar una categoría la **archiva**: las revisiones selladas la siguen apuntando, el portal deja de mostrarla y el editor ya no la ofrece. `portal_content_index` (anónima) da ids, direcciones y categorías de lo publicado.
5. **Filtros en el navegador:** la página está en caché entera; la búsqueda (sin tildes ni mayúsculas) y las categorías filtran lo que ya tiene, y la dirección guarda el filtro (`?categoria=…&q=…`). Solo se ofrecen las categorías que tiene algo publicado (en la agenda, algo próximo). Nada se envía.
6. **Barra inferior en el celular** (< 48 rem): Inicio y Destinos, y después Agenda, Pasaporte, Mapa y Tours 360° si el municipio los tiene (módulo y, para tours y pasaporte, algo publicado); con más de cinco, la quinta es «Más». Fija abajo (no mueve la página), con `aria-current` en la sección actual; en el celular el encabezado deja solo el nombre. No aparece en las páginas de tour, que usan la pantalla entera.
7. **Panel:** «Inicio del portal» en «Marca del portal» (portada, destino, cifras, secciones con «Mostrar», variante, «Subir» y «Bajar»); página «Categorías» (`/o/{slug}/categorias`) y el campo «Categoría» en los editores de destinos y eventos.
8. **Estilos:** lo nuevo de las listas va en `listing.css` (inicio, destinos y agenda) y lo del inicio en `home.css`; en la hoja común solo quedan las etiquetas de las tarjetas y la barra inferior. Cada tema tiene sus variantes: en «Inmersivo», la foto de la portada va de fondo con el texto encima.

## Consecuencias

- Un municipio cambia su inicio publicando la marca; la caché del portal se invalida como siempre.
- Agregar una sección o una variante es una entrada en el catálogo (`HOME_SECTIONS`), su componente y la lista de la base; ningún municipio lo pide con código.
- El panel ya desplegado sigue funcionando durante el despliegue: un formulario sin los campos del inicio no lo toca, y un documento sin `categoryId` es el de antes.
- Un destino guardado con el editor anterior pierde su categoría (no la conocía); al volver a guardarlo con el editor nuevo, la recupera.
