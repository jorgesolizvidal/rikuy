# ADR-066 — El panel con el sistema de diseño: menú agrupado, resumen con datos reales y aspecto propio de Rikuy

- **Estado:** Aceptada — 2026-11-15
- **Concreta:** C3 · Paso 7 (panel del municipio, con un retoque más liviano)
- **Se apoya en:** [ADR-060](ADR-060-tenant-modules.md) (módulos), [ADR-061](ADR-061-portal-themes.md) (temas y fuentes), [ADR-052](ADR-052-statistics-panel.md) (estadísticas), [ADR-053](ADR-053-unanswered-questions.md) (preguntas sin respuesta) y [ADR-042](ADR-042-copilot.md) (revisión del Copilot)

## Contexto

El panel creció paso a paso: la página del municipio era una lista larga de tarjetas (17 con todos los módulos) y cada página tenía su enlace «← Municipio» y su «Cerrar sesión». No había un menú fijo, el botón deshabilitado se veía como un naranja desteñido, las listas se desplazaban de costado en el celular y los editores largos dejaban «Publicar» al final de la página.

Decisiones del usuario (2026-11-14):

- **menú lateral agrupado:** en la PC, un menú fijo a la izquierda con las secciones en grupos (Contenido, Para visitantes, Resultados, Ajustes) y la actual marcada; en el celular, un botón «Menú»; solo los módulos del municipio y lo que el rol puede usar;
- **resumen con datos reales** arriba de la página del municipio: si el portal está en línea (con su dirección), las visitas de los últimos 7 días, las preguntas sin respuesta y lo que le falta al contenido según la revisión del Copilot, cada uno con su enlace; ninguna cifra inventada;
- **colores neutros de Rikuy:** el panel se ve igual para todos los municipios (el tema «Editorial» con una paleta propia); la marca del municipio se ve solo en su vista previa y en su portal;
- **retoques:** botones y estados coherentes (principal, secundario, peligro; «Borrador», «Publicado», «Con cambios»; un botón deshabilitado que se lee como deshabilitado), listas como tarjetas en el celular y formularios largos en secciones con «Guardar / Publicar» siempre a la vista.

## Decisión

1. **Un layout para todas las páginas del municipio** (`app/admin/o/[slug]/layout.tsx`): lee la membresía (la misma lectura que la página, en caché por petición) y dibuja el menú. Las páginas siguen comprobando su módulo y su rol; el menú solo deja fuera lo que respondería 404.
2. **El menú es una función pura** (`src/lib/panel-nav.ts`): grupos y enlaces según los módulos (ADR-060) y el rol («Miembros» para propietarios y administradores; «Contenido de muestra» solo en una demo, para ellos). La página actual se marca con `aria-current="page"`; un editor (`/destinos/{id}`) pertenece a su lista. En el menú también están «Tus municipios» y «Cerrar sesión», que salen de cada página. Los enlaces «← …» quedan solo en las páginas de detalle.
3. **Sin precarga en el menú** (`prefetch={false}`): todas las páginas del panel son dinámicas, y Next.js precargaba los ~16 enlaces del menú en cada visita y tras cada actualización de la página (cada precarga es un renderizado en el servidor con sus lecturas). Las pruebas lo encontraron: tras «Generar recomendaciones», la página tardaba más de 5 s en mostrarlas. Ahora se navega al hacer clic.
4. **En el celular** (menos de 64 rem), el menú está detrás de «Menú» (`aria-expanded`); se cierra con Escape (el foco vuelve al botón) y al elegir una página. En la PC queda fijo, con su propio desplazamiento.
5. **El resumen** (`loadPanelOverview` en `@rikuy/core`) lee con la sesión de la persona: la dirección del portal, las visitas de 7 días con la comparación de «Estadísticas» (sin el pasaporte), las preguntas sin respuesta de 7 días (con el asistente), la revisión del Copilot (con el Copilot) y cuántos destinos y eventos están publicados, con cambios o en borrador. Cada parte que no se pueda leer queda fuera, nunca como un cero; un módulo apagado no aparece. Cada número enlaza a la página que muestra lo mismo.
6. **Aspecto propio de Rikuy** (`admin.css`, en `.admin`): fondo, superficie, texto, acento verde, peligro y aviso, con modo oscuro; todo color de texto ≥ 4,5:1 sobre el fondo y la superficie. La fuente es la del tema «Editorial» (`themeFontFaces("editorial")`, la misma de ADR-061), precargada. La vista previa de «Marca del portal» conserva los colores y fuentes del municipio.
7. **Retoques:** botón principal relleno, secundario con borde, peligro en rojo; deshabilitado en gris con `cursor: not-allowed`. Los estados «Publicado» (verde), «Con cambios» (ámbar, antes decía «Publicado»), «Borrador» (borde punteado) y los fallidos (rojo), siempre con su texto. Las listas de destinos, agenda, tours, pasaporte, conocimiento, Copilot y miembros llevan el nombre de cada columna en sus celdas (`data-label`) y, en pantallas de menos de 40 rem, cada fila es una tarjeta. Los bloques de los editores de destino, evento, conocimiento y marca son secciones con borde y título, y su barra «Publicar / Guardar borrador» queda fija abajo mientras se desplaza el formulario.

## Consecuencias

- Abrir la página del municipio hace unas lecturas más (visitas, preguntas, revisión y listas), en paralelo; si alguna falla, la página sale igual sin esa parte.
- Las estadísticas por número siguen en sus páginas: el resumen no reemplaza a «Estadísticas» ni al informe mensual.
- El panel ya no toma el color de acento de la plataforma de antes (terracota): los textos y enlaces usan el verde de Rikuy.
- Las tablas de cifras («Estadísticas», «Informe mensual») siguen desplazándose de costado en el celular: comparar columnas de números en tarjetas sería peor.
