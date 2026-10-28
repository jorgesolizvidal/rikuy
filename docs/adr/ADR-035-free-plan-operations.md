# ADR-035 — Operación con planes gratuitos: control diario, avisos por correo y limpieza de imágenes sin uso

- **Estado:** Aceptada — 2026-10-27
- **Concreta:** el Hito Demo / Portafolio del [roadmap](../roadmap.md) (Paso 3), ADR-025 (la base despierta al ejecutor), ADR-027 (cuotas)

## Contexto

Hasta que un municipio contrate, Rikuy corre en planes gratuitos:

- Supabase Free: 1 GB de Storage y 500 MB de base de datos para todo el proyecto; **pausa el proyecto tras 7 días con poca actividad**.
- Vercel Hobby: un cron al día como mucho.
- GitHub Actions, gratis en un repositorio público.

Nadie mira el panel todos los días. Hacía falta:

1. que el proyecto no se pause;
2. enterarse si algo cae;
3. enterarse antes de que se acabe el espacio;
4. no gastar espacio en imágenes que nadie usa.

El usuario decidió (2026-10-27):

- limpieza **automática** solo de fotos y logos sin uso por más de 7 días;
- avisos **por correo y en el panel**;
- un umbral para `/mapa` con una medición en su celular.

## Decisión

1. **Un control externo diario** (GitHub Actions, «Daily health»).
   - Pide el inicio de cada portal (200 y la versión que sirve) y `/mapa`, que se genera por petición y lee la base por la Data API. Esa es la actividad que evita la pausa.
   - Si algo no responde, el job falla y GitHub le escribe al dueño del repositorio.
   - No necesita ningún secreto. Corre fuera de Vercel y de Supabase, así que avisa aunque los dos estén caídos.
2. **Un informe interno diario.**
   - La base (pg_cron, 07:07 en Bolivia) despierta al ejecutor con el mismo aviso de ADR-025 y la razón `daily`.
   - El ejecutor lee `worker_api.operations_report()`: almacenamiento del proyecto, tamaño de la base, trabajos fallidos en 24 h, trabajo esperando, municipios al 80 % de una cuota y la limpieza de la semana.
   - Si algo necesita revisión, escribe a los operadores activos por el SMTP de ADR-034.
   - Avisa al 80 % («Revisar») y al 95 % o con la cola atascada más de 15 min («Urgente»).
   - Los operadores ven el mismo resumen en `/plataforma` («Estado de la plataforma»).
3. **Limpieza de fotos y logos sin uso.**
   - Cada noche (03:37), un trabajo `media.remove_unused` por cada foto o logo listo hace más de 7 días que no usa ninguna revisión de contenido (borrador o sellada), ningún punto de un tour ni ninguna versión de la marca.
   - Bajo el arrendamiento, la base **rechaza primero** la versión (nada puede empezar a usarla), audita los bytes liberados y le da al ejecutor la carpeta de esa versión. Después el ejecutor borra sus archivos en los dos buckets.
   - Es idempotente: un reintento recibe la misma carpeta, y una versión que volvió a usarse no recibe nada.
   - Al rechazarse, la cuota se libera (ADR-027).
   - **Los panoramas y los modelos 3D nunca se borran aquí**: se suben a propósito para usarlos después.
   - **Las copias públicas** siempre las usa alguna revisión sellada, que «Volver a esta versión» necesita, así que tampoco se borran.
4. **`/mapa` tiene umbral:** rendimiento ≥ 60, LCP ≤ 3,5 s, CLS ≤ 0,1 y JS ≤ 700 KB. Se mide sobre lo que da Lighthouse (67–69 en el CI y 68 en producción) y se confirma en un celular real con un panel `?medir` como el del tour.
5. **Lighthouse de producción a partir del sitemap** de cada portal de `LIGHTHOUSE_ORIGINS` (también Ucureña): su primer destino y su primer evento próximo, sean cuales sean. Si un portal no los tiene, se omiten esas páginas.

## Consecuencias

- (+) El proyecto gratuito no se pausa mientras corra el control diario. Si algo cae, llega un correo de GitHub; si algo se llena o falla, llega un correo de la plataforma.
- (+) El espacio de las fotos que se suben y nunca se usan vuelve solo, sin tocar nada que se vea ni que se pueda restaurar.
- (−) GitHub desactiva los workflows programados de un repositorio sin commits en 60 días: hay que volver a activarlo en Actions.
- (−) Una foto subida hace más de 7 días y guardada recién después en un borrador ya no existe: hay que volver a subirla. El editor la rechaza al guardar, con su mensaje de foto no disponible.
- (−) El informe interno depende del ejecutor. Si el ejecutor no se despierta, avisa el control externo (los portales siguen) o el atasco de la cola del día siguiente.
