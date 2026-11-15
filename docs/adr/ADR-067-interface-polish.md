# ADR-067 — Pulido de la interfaz: menos repetición, una sola puerta en cada pantalla y el mismo ancho de página

- **Estado:** Aceptada — 2026-11-15
- **Concreta:** C3 · Paso 8 (pulido de la interfaz, antes de C4)
- **Ajusta:** [ADR-062](ADR-062-home-sections-categories.md) (inicio por defecto y barra inferior), [ADR-063](ADR-063-detail-pages-map.md) (fichas), [ADR-064](ADR-064-tour-passport-design.md) (tour y pasaporte) y [ADR-066](ADR-066-panel-design.md) (panel)

## Contexto

Con el rediseño terminado (C3 · Pasos 1 a 7), el usuario revisó el portal de Ucureña y el panel con capturas propias, y pidió una evaluación profesional de cada pantalla. Lo que encontramos, sobre todo en la PC:

- **El inicio repetía el menú:** la portada tenía tres botones (recorrido, lugares, agenda) que ya estaban en la cabecera y en la barra del celular; la franja de cifras («4 lugares, 7 recorridos…») contaba lo que las listas de abajo ya muestran; la tarjeta de la foto de portada era el mismo lugar que la primera tarjeta de la lista; y la sección «¿Tienes una pregunta?» repetía el botón del asistente, que está en todas las páginas.
- **Etiquetas sobre cada foto:** «Recorrido 360°» y «Sello del pasaporte» en píldoras encima de cada tarjeta tapaban las fotos y se repetían en toda la lista.
- **Fechas dobles:** cada evento tenía el bloque de día y mes, y además la fecha larga completa al lado.
- **Encabezados largos en las listas:** el nombre del municipio en mayúsculas, el título, una frase y tres tarjetas de cifras antes del primer resultado (en el celular, unos 700 px).
- **Anchos distintos:** la cabecera, las secciones del inicio y las páginas tenían márgenes distintos en pantallas anchas; cuatro tarjetas quedaban en tres columnas y una huérfana.
- **Tour:** dos barras de controles (la del visor y la nuestra), el visor empujado debajo del título y, con una sola escena, «Anterior», «Siguiente» y «Escena 1 de 1» sin nada que hacer.
- **Panel:** títulos grandes y frases de relleno («Tu rol…»), un formulario «Nuevo …» abierto al principio de cada lista, «Subir / Bajar / Quitar» como palabras en cada fila, la dirección técnica (`/mirador-del-valle`) debajo de cada nombre y siete cifras de estadísticas con su explicación dentro de cada tarjeta.

El usuario pidió hacer este paso antes de C4. Las tres preguntas de alcance no se respondieron; se tomaron las propuestas de la evaluación (dichas al usuario).

## Decisión

1. **Inicio por defecto** (`DEFAULT_HOME`): lugares, eventos, recorridos 360° y pasaporte. La franja de cifras y «¿Tienes una pregunta?» pasan a ser **secciones que el municipio enciende** en «Marca del portal»; un municipio que ya guardó su inicio conserva lo que eligió.
2. **Portada:** la foto del destino elegido es el fondo, de borde a borde, con un velo oscuro y el texto en blanco, en los dos temas. El lema es texto normal (no una píldora). **Un solo botón**: «Empezar el recorrido 360°» si hay recorrido general; si no, «Ver los lugares». La foto nombra su lugar con un enlace pequeño en una esquina.
3. **Tarjetas:** «Recorrido 360°» y «Sello del pasaporte» van como una línea discreta debajo del texto, con su ícono. En la portada de una ficha siguen sobre la foto (es un solo lugar).
4. **Fechas cortas** (`formatEventShort`): junto al bloque de día y mes, solo lo que el bloque no dice («Miércoles · 10:00–18:00», «30 nov – 2 dic»). La fecha completa queda para lectores de pantalla.
5. **Encabezados de lista:** título y una frase (en «Destinos», con cuántos lugares hay). Sin el nombre del municipio en mayúsculas ni tarjetas de cifras. El aviso del pasaporte sale de «Destinos» y «Agenda» (queda en el inicio y en la cabecera).
6. **Un ancho de página:** `--page` (72 rem) y `--edge` (el margen que centra ese ancho) en la cabecera, las secciones, los avisos y el pie. Cuatro tarjetas llenan una fila de cuatro en la PC; los eventos del inicio usan el ancho de la página.
7. **Barra inferior del celular:** Inicio · Destinos · 360° · Agenda · Pasaporte. El mapa se alcanza desde «Destinos» (su lista tiene «Ver en el mapa», y «Destinos» queda marcado en `/mapa`); ocupa un lugar en la barra solo si hay espacio. Ya no aparece «Más».
8. **Fichas:** «Cómo llegar» es el botón principal y el resto va lado a lado. La ubicación ya no muestra las coordenadas en números: «Ver en el mapa del municipio» y «Abrir en OpenStreetMap».
9. **Tour:** el visor ocupa lo que queda de la pantalla bajo el título y su barra; el zoom del visor es una píldora pequeña en una esquina (sin las flechas, que siguen con el teclado). Con una sola escena no se muestran «Anterior», «Siguiente» ni el contador. «Más tours del municipio» son tarjetas con su número de escenas, sin imágenes (los otros tours siguen sin descargar nada hasta abrirlos).
10. **Pasaporte:** el mapa del recorrido se ajusta a las paradas (antes, un mínimo de ~2 km dejaba un paseo de 300 m en el centro). Los sellos pequeños de la lista no llevan el nombre en el borde, que no se podía leer.
11. **Pie:** el nombre del municipio y su lema encabezan el pie; el inicio deja aire antes de él.
12. **Panel:**
    - títulos más chicos y una frase corta debajo;
    - la página del municipio tiene **acciones rápidas** (Nuevo destino, Nuevo evento, Ver el portal) según el rol y los módulos; «Tu rol…» sale y los módulos pasan a «Uso del plan»;
    - **«Nuevo …»** es un botón que abre el formulario (destinos, agenda, tours y pasaporte), abierto cuando la lista está vacía o la dirección trae `?nuevo` (las acciones rápidas lo usan);
    - **«Subir», «Bajar» y «Quitar»** son íconos con su nombre para lectores de pantalla y como ayuda al pasar el mouse;
    - las listas de destinos y eventos no muestran la dirección técnica; el editor la tiene en «Dirección en el portal»;
    - en el editor de destinos y eventos, las fotos van justo después del texto;
    - en «Estadísticas», las siete cifras caben en una fila y su explicación pasa a «Cómo se cuenta».

## Consecuencias

- Ucureña guardó su inicio con la franja de cifras y «¿Tienes una pregunta?» encendidas: para verla como el resto, su propietario las apaga en «Marca del portal» (no se cambian datos de producción desde el código).
- En `/mapa`, la barra del celular marca «Destinos».
- El zoom del tour con mouse sigue con Ctrl + rueda o la píldora; las flechas del visor, solo con el teclado (el visor enfocado).
- Las tarjetas de «Más tours» no muestran una foto: mostrarla descargaría la vista previa de cada tour al abrir la página.
