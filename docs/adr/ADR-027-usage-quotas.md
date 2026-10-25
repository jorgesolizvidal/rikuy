# ADR-027 — Cuotas por municipio: reserva al pedir la subida, medición en Storage y cómputo desde los intentos

- **Estado:** Aceptada — 2026-10-25 (valores por defecto y qué se cuenta: decisión del usuario)
- **Concreta:** ADR-012 («cuotas, ledger de uso») y la tabla 20 `usage_buckets` del esquema piloto de la auditoría

## Contexto

Todos los municipios comparten un proyecto de Supabase y una cuenta de Vercel. En los planes gratuitos actuales, eso es **1 GB de Storage para todo el proyecto** y **4 h de CPU activa al mes para toda la cuenta**, incluidas las páginas. Un municipio que suba sin límite puede dejar sin espacio o sin procesamiento a los demás. La auditoría pide reservar la cuota **antes** de trabajar, de forma atómica, con límites que asigna el operador de la plataforma, nunca el propio municipio.

## Decisión

1. **Dos recursos:**
   - `storage_bytes`, sin período: lo que ocupan los medios del municipio **contando el original y sus derivados** en los dos buckets (decisión del usuario: es lo que cuesta).
   - `media_compute_seconds`, por mes calendario **en la zona horaria del municipio**: el tiempo de procesamiento de panoramas y modelos 3D.
2. **Valores por defecto** (decisión del usuario): **300 MB** y **30 min al mes** por municipio. Un operador con segundo factor los cambia por municipio en `/plataforma/cuotas`, con auditoría. Bajar un límite no borra nada: solo frena las subidas nuevas.
3. **Reserva atómica al pedir la subida.**
   - Un trigger en `asset_versions` reserva una estimación cuando se crea la versión:
     - ×1,5 lo declarado para fotos y logos;
     - ×2 para panoramas y modelos;
     - más 240 s de cómputo por panorama o modelo.
   - Lo hace con un único `UPDATE … WHERE consumed + reserved + n <= limit` sobre la fila del período, cuyo bloqueo serializa las peticiones simultáneas.
   - Si no cabe, la petición falla con `PT507` (pista: el recurso) y no se crea nada.
4. **Liquidación con lo real:**
   - **Al quedar lista**, al publicarse o al recibir su poster, la base **mide** la versión en `storage.objects`, que es la fuente de verdad del tamaño de cada archivo. Se excluyen las texturas intermedias del pipeline GLB.
   - **Al rechazarse**, se libera todo.
   - **El cómputo** se liquida cuando termina el trabajo de medios, con la duración de sus intentos.
   - La liquidación puede pasar el límite, porque el trabajo ya se hizo; la siguiente reserva se rechaza.
5. **Ganchos con triggers** en `asset_versions` y `background_jobs`, cuyos estados ya cambian: las funciones existentes conservan su contrato. Las tablas no tienen permisos para nadie; se leen con `tenant_usage` (cualquier miembro) y `platform_tenant_usage` (operador).
6. **Al desplegar**, la migración mide los medios que ya existen y abre una reserva vacía para los que están en curso.

## Consecuencias

- (+) Dos subidas simultáneas nunca pasan la cuota (probado con 8 conexiones a la vez contra PostgreSQL real).
- (+) Lo que se cuenta es lo que está en Storage, no una cuenta paralela que pueda desviarse.
- (−) Una subida pedida y nunca completada retiene su reserva hasta la limpieza diaria (24 h).
- (−) La estimación puede quedarse corta (un GLB muy comprimido puede crecer más de ×2). Lo real se cuenta igual al terminar, aunque pase el límite.
- (−) El cómputo usado antes de este cambio no se cuenta, y el de las páginas del portal no entra en ninguna cuota; Speed Insights y el panel de Vercel siguen siendo la vista global.
- Al pasar a planes pagos (Supabase Pro, Vercel Pro) se suben los valores por defecto en `private.quota_default` con una migración, sin tocar la lógica. La cuota de IA (P5) se suma como un tercer recurso.
