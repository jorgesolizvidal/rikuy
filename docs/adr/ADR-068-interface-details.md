# ADR-068 — Detalles de la interfaz: escudo en el pie, cifras en una tarjeta, botones compactos y mapa de la ficha que se mueve

- **Estado:** Aceptada — 2026-11-16
- **Concreta:** corrección `fix/interface-details`, después de C3 · Paso 8 y antes de la fase siguiente
- **Ajusta:** [ADR-062](ADR-062-home-sections-categories.md) (franja de cifras), [ADR-063](ADR-063-detail-pages-map.md) (fichas y mapa pequeño) y [ADR-067](ADR-067-interface-polish.md) (cabecera y pie)

## Contexto

Con el pulido de C3 · Paso 8 en producción, el usuario revisó el portal de Ucureña con capturas propias y pidió seis ajustes:

1. el **logo de la cabecera** se ve chico;
2. la **franja verde de cifras** no le gusta, tampoco en el celular; propuso una tarjeta blanca con cada cifra, su ícono y una flecha;
3. el **pie** debería llevar el **escudo** del municipio, de la comunidad o de la alcaldía;
4. en «Para tu visita», **«Ver el tour 360°» y «Compartir»** son anchos y altos (en el celular, el del tour se partía en dos líneas);
5. el **mapa pequeño de la ficha** está quieto: debería acercarse, moverse y mostrar cómo llegar desde donde está el visitante, como `/mapa`;
6. la navegación de la cabecera puede quedar a la derecha o centrarse un poco: lo dejó a mi criterio.

## Decisión

1. **Logo:** 4,5 rem de alto en la PC (antes 2,5) y 3,5 rem en el celular (el logo de un municipio suele traer margen transparente alrededor), con su ancho máximo. El alto es fijo, así que la cabecera no cambia de tamaño al cargar la imagen. **La navegación queda a la derecha**, con un poco más de espacio entre enlaces: centrarla la separa del logo y compite con la marca en pantallas medianas.
2. **Escudo:** nueva clave opcional `crest` en la marca, con la misma forma que el logo (`{assetId, version}`, nunca una URL). Es una imagen de tipo logo del mismo municipio: se sube, se revisa y se publica igual (mismos derivados WebP y PNG de hasta 512 px) y la base exige lo mismo que al logo al guardar y al publicar. La limpieza diaria de imágenes sin uso lo cuenta como usado. En «Marca del portal» → «Identidad» hay un campo «Escudo del municipio» (subir, reemplazar, quitar) y en el portal aparece en el pie, sobre el nombre, con `alt` «Escudo de …» y carga diferida (está al final de la página).
3. **Cifras:** una tarjeta blanca con hasta cuatro cifras en una fila (dos por dos en el celular), separadas por líneas finas. Cada una tiene un ícono en un cuadrado tintado, el número y lo que cuenta. **Lo que cuenta el portal lleva a su sección** (lugares → destinos, recorridos → recorrido general, eventos → agenda, circuitos → pasaporte) con una flecha; las cifras propias del municipio son solo texto. Los colores de los íconos son de la plataforma (verde de la marca, azul, ámbar y rojo), iguales en todos los portales. Justo después de una portada con foto, la tarjeta se apoya sobre su borde inferior (la portada deja lugar para el crédito de la foto); sin `:has()` en el navegador, simplemente la sigue. `homeFigures` devuelve además el tipo de cada cifra (`BandFigure`).
4. **Botones de «Para tu visita»:** compactos (2,5 rem de alto), con ícono, sin partir el texto y lado a lado; los secundarios con borde fino. Los textos visibles son «Tour 360°» y «Calendario»; el nombre accesible sigue siendo «Ver el tour 360°» y «Añadir al calendario».
5. **Mapa de la ficha:**
   - se acerca y se mueve: botones + y −, dos dedos en el celular y Ctrl + rueda en la PC (la página sigue desplazándose con un dedo y con la rueda);
   - debajo, **«Ver dónde estoy en el mapa»**, la distancia cuando se conoce y **«Cómo llegar»** (la app de mapas, desde la posición del teléfono; no para un evento que terminó);
   - con la ubicación compartida, el mapa muestra el punto azul y una **línea recta discontinua** hasta el lugar, y encuadra a los dos una vez (si el visitante está a más de 300 km, el lugar queda a la vista y la distancia se dice en palabras);
   - la posición sigue sin salir del teléfono (ADR-021): el encuadre y la línea se calculan en el navegador;
   - el mapa se carga como antes (al llegar a él y usar la página, o con su botón) y también en cuanto el visitante comparte su ubicación;
   - el pin del lugar no abre una ventana (la ficha es el lugar). El mapa del recorrido del pasaporte sigue quieto.

## Consecuencias

- Migración `20261126000000_c3_footer_crest.sql` (solo expand): `private.is_valid_presentation`, `private.assert_logo_reference` y `private.is_unused_media` se reemplazan con `create or replace` (la restricción de `tenant_config_versions` sigue apuntando a la misma función). Test `051_footer_crest`.
- Una marca guardada con un panel abierto antes del despliegue (sin el campo del escudo) se guarda sin escudo, como antes.
- La revisión de integridad de lo publicado (ADR-044) no revisa el escudo todavía: si sus copias públicas faltaran, el pie mostraría la imagen rota hasta subirlo de nuevo.
- La línea hasta el lugar es en línea recta, no por calles; «Cómo llegar» abre la app de mapas para eso.
