# ADR-052 — Panel «Estadísticas» del municipio

- **Estado:** Aceptada — 2026-11-12
- **Concreta:** C1 · Paso 2 (métricas y estrategia), sobre los totales de [ADR-051](ADR-051-anonymous-visit-counts.md)

## Contexto

Desde C1 · Paso 1, cada municipio acumula sus visitas por día, página, lugar, escena y acción, y su origen aproximado. Las tablas tienen RLS sin permisos: nadie las lee todavía. El roadmap pide que el equipo del municipio vea sus números sin pedirle nada a la plataforma.

Decisiones del usuario (2026-11-12):

- **Quién lo ve:** todos los miembros del municipio: propietarios, administradores, editores y analistas. Son números, sin datos de personas.
- **Períodos:** botones fijos: últimos 7 días, últimos 30 días, este mes y el mes anterior.
- **Comparación:** cada total se compara con el período anterior.
- **Descarga:** CSV del período, con los totales por día.

## Decisión

1. **Dos funciones, ninguna tabla abierta.** Las tablas siguen sin permisos. Se leen solo por:
   - `tenant_visit_calendar(tenant)`: la zona horaria del municipio y su primer día contado;
   - `tenant_visit_statistics(tenant, desde, hasta, por_día)`: los totales de un período de hasta 400 días. Por página, lugar, escena y acción (y por día, si se piden así), las vistas y visitantes de cada día del portal, y el origen por país y ciudad.

   Las dos exigen ser miembro con `private.has_tenant_role` (propietarios y administradores, con su segundo factor, ADR-043). Ponen el nombre actual de cada lugar (su versión publicada, o su borrador si nunca se publicó) y de cada escena (la versión publicada de su tour, o la más nueva que la tiene). La escena de un tour borrado queda sin nombre; los lugares borrados se llevan sus conteos (ADR-051).

2. **Los períodos los decide `@rikuy/core`**, con el día del municipio (su zona horaria):

   | Período                 | Se compara con                                                      |
   | ----------------------- | ------------------------------------------------------------------- |
   | Últimos 7 o 30 días     | los 7 o 30 días anteriores                                          |
   | Este mes (hasta hoy)    | los mismos días del mes anterior (el 31 de marzo, con todo febrero) |
   | Mes anterior (completo) | el mes completo anterior a ese                                      |

   No se compara con días que nunca se contaron: si el período anterior empieza antes del primer día contado, la página dice «sin comparación» y desde cuándo se cuenta, y no pide ese período a la base.

3. **Qué muestra** (`/o/{slug}/estadisticas`, «Estadísticas» en la página del municipio):
   - siete totales: vistas de páginas, visitantes, escaneos de QR, «Cómo llegar», «Compartir», «Añadir al calendario» y escenas vistas. Cada uno con su cambio en palabras y con flecha («▲ 12 %», «▼ 50 %», «= igual», «nuevo»), nunca solo con color;
   - las vistas por día en un gráfico de barras de una sola serie, con su descripción para lectores de pantalla, el número de cada día al pasar sobre la barra y la tabla de los días;
   - lo más visto: cada destino y evento con sus vistas, visitantes, escaneos, «Cómo llegar», «Compartir» y calendario, con enlace a su editor (los 20 primeros; todos en la descarga);
   - los tours: vistas, visitantes, escenas vistas y escaneos, con sus escenas de la más vista a la menos;
   - las páginas generales del portal (inicio, destinos, agenda, mapa, recorrido general);
   - de dónde vienen: países y ciudades;
   - cómo se cuenta: los números son un mínimo, qué es un visitante, qué QR cuentan y que los días son los del municipio.
4. **«Visitantes» del período es la suma de los visitantes de cada día.** La huella cambia cada día (ADR-051), así que nadie puede saber cuántas personas distintas hubo en un mes. La página lo dice en el total.
5. **Descarga:** `GET /o/{slug}/estadisticas/descargar?periodo=…&tipo=visitas|origen` responde un CSV con una fila por día, página o lugar, escena y acción (o por día, país y ciudad). Detalles:
   - separado por «;», con BOM UTF-8, para que Excel en español lo abra con sus acentos;
   - una celda que empieza como una fórmula se guarda como texto;
   - `no-store`;
   - sin acceso responde 404, como las páginas, para no revelar otros municipios (un _route handler_ no puede llevar al inicio de sesión ni a la verificación).
6. **Antes de la migración** (la web sale minutos antes), el panel muestra «Todavía no hay visitas contadas» en lugar de un error.

## Consecuencias

- El equipo del municipio ve sus números sin pedirlos a la plataforma, con los mismos permisos que el resto del panel.
- Una página hace dos consultas (tres, con la comparación), que filtran por municipio y día con el índice de las tablas de ADR-051. Se revisa el tiempo con el tráfico real de Ucureña en las métricas del operador (ADR-044).
- Los nombres son los actuales: si un lugar se renombra, sus números de antes aparecen con el nombre nuevo (siguen al lugar, no a su dirección).
- No hay rango de fechas libre ni comparación entre lugares. Lo que pida la alcaldía llega con el informe mensual (Paso 5) o se agrega como otro período.
