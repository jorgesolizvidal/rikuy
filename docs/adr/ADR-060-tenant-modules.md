# ADR-060 — Módulos de cada municipio

- **Estado:** Aceptada — 2026-11-13
- **Concreta:** C3 · Paso 1 (catálogo de módulos por municipio); adelanta la base del «catálogo de módulos que cada municipio activa» de E1
- **Se apoya en:** ADR-003 y ADR-015 (el municipio sale del host), [ADR-024](ADR-024-portal-page-cache.md) (caché del portal por municipio) y [ADR-043](ADR-043-staff-second-factor.md) (segundo factor del operador)

## Contexto

Hasta ahora todos los municipios tenían todas las funciones. El portal ya ocultaba lo que no tenía contenido (sin tours publicados no hay «Tours 360°»), pero el panel mostraba todo a todos, y no había forma de decir «este municipio no usa modelos 3D» o «solo información». Un SaaS que se vende a municipios distintos necesita que cada uno tenga solo lo que contrató, y el rediseño de C3 (barra inferior del celular, menú, inicio por secciones) se arma según eso.

Decisiones del usuario (2026-11-13):

- **solo el operador** activa o desactiva los módulos, desde `/plataforma`; queda atado a lo contratado (y a los planes de E4);
- **apagar oculta y conserva**: el contenido no se borra y vuelve como estaba al encender el módulo;
- **al dar de alta se elige un paquete** («Completo» o «Solo información») y después se ajusta módulo por módulo; los municipios que ya existen quedan con todo.

## Decisión

1. **Catálogo** (`platform_modules`; migración `20261123000000_c3_tenant_modules.sql`): agenda, mapa, tours 360°, modelos 3D (necesita los tours), pasaporte turístico, asistente del visitante, voz del asistente (necesita el asistente) y Copilot. Destinos, marca, miembros, estadísticas, uso del plan e informe mensual están siempre. Los nombres y descripciones viven en `@rikuy/core` (`domain/tenancy/modules`); la base guarda solo las claves y qué necesita cada una.
2. **Lo que tiene cada municipio** (`tenant_modules`, RLS sin permisos para nadie):
   - todo municipio nuevo empieza con todos (un trigger en `tenants`) y la migración se los da a los existentes;
   - `provision_tenant(…, p_modules)` lo reemplaza en la misma transacción por el paquete elegido, comprobado antes de crear nada;
   - `platform_set_tenant_modules` (operador con segundo factor) reemplaza el conjunto: claves conocidas, sin repetir y con lo que cada una necesita. Bloquea el municipio mientras cambia y audita `platform.modules_changed` con el antes y el después (no audita si nada cambió).
3. **El portal y el panel lo leen** donde ya leían el municipio: `resolve_tenant_by_host`, `my_memberships` y `platform_list_tenants` suman la columna `modules`. Una clave que la app no conoce (un módulo agregado después) se ignora; sin la columna (la app sale minutos antes que la migración), el municipio tiene todo.
4. **La base no deja crear contenido de un módulo apagado** (triggers, `PT403` con la clave): eventos (agenda), tours (tours), panoramas (tours), modelos 3D (modelos), circuitos (pasaporte), conocimiento y sus documentos (asistente). Es el respaldo: el panel ya no ofrece esas páginas. Lo que ya existe se puede seguir leyendo y copiando (un borrador nuevo de un tour con puntos de modelo funciona).
5. **Portal**: con un módulo apagado, sus enlaces desaparecen de la cabecera, del inicio, del sitemap, de las fichas (mapa pequeño, «Ver el tour 360°») y de las respuestas del asistente (secciones y «Ver la ruta en el mapa»). Sus páginas responden 404: `/agenda` y cada evento, `/mapa`, `/recorrido`, `/pasaporte`, `/sello`, `/sellar`, `/premio` y `/asistente`; la página del tour de un lugar lleva a su ficha. Los puntos de modelo 3D se omiten en los tours. El asistente no lee pasajes de tours sin los tours ni de eventos sin la agenda, y sin la voz no hay dictado ni «Escuchar». `/canje` sigue funcionando: un local puede canjear un comprobante ya emitido.
6. **Panel**: la página del municipio muestra solo las tarjetas de sus módulos y la lista de los que tiene; las páginas y las acciones de un módulo apagado responden 404 o «sin permiso». «Estadísticas» oculta los tours, el pasaporte y las recomendaciones; el informe mensual va sin recomendaciones si no hay Copilot («El municipio no tiene el Copilot») y sin pasaporte si no lo tiene. El Copilot no revisa ni lee eventos sin la agenda ni tours sin los tours. La demo comercial carga solo lo que su paquete tiene.
7. **Plataforma**: columna «Módulos» en la lista de municipios y `/plataforma/modulos/{municipio}` con un interruptor por módulo, lo que necesita cada uno y una confirmación al apagar. Al guardar, se invalida la caché del portal de ese municipio (ADR-024). En el alta, «Módulos con los que empieza»: «Completo» o «Solo información» (agenda y mapa).

## Consecuencias

- Un municipio «solo información» tiene destinos, agenda y mapa, y su panel no muestra nada de tours, pasaporte ni IA.
- Encender un módulo devuelve todo como estaba: el contenido nunca se borró.
- Los datos publicados de un módulo apagado no son secretos (las lecturas anónimas de la base siguen existiendo): el portal no los pide ni los enlaza. La regla es de producto, no de seguridad.
- Los módulos nuevos de E1 (gastronomía, alojamientos, transporte, videos) entran en el mismo catálogo con una fila y su nombre, apagados para quien no los contrate.
- Las páginas del panel que crean contenido de un módulo apagado no existen, y si alguien llama a la base directamente, la base lo rechaza.
