# ADR-021 — Ubicación del visitante en tiempo real

- **Estado:** Aceptada — 2026-10-17
- **Relacionada con:** ADR-010 (mapas con licencia apropiada), ADR-018 (IA), contrato RC-06
- **Origen:** revisión de paridad con el sistema anterior ([paridad funcional](../paridad-funcional.md))

## Contexto

El sistema anterior pide la ubicación una sola vez (`getCurrentPosition`) para calcular distancias en línea recta, ordenar por cercanía y abrir «Cómo llegar» en Google Maps; también la envía al asistente y la guarda junto a cada pregunta. La auditoría previó coordenadas de destinos en PostGIS (`location geography(Point,4326)`), el contrato RC-06 (permiso concedido, denegado o desconocido) y casos de evaluación como «¿qué hay cerca de mí?», pero el roadmap de Rikuy no tenía un paso para la ubicación del visitante.

## Decisión

1. **Coordenadas de los contenidos en la base** desde P3 · Paso 2: `geography(Point,4326)` con índice GiST; consultas «cerca de» y por área (bounding box) en el servidor, nunca descargando todo el catálogo.
2. **Ubicación del visitante en el navegador, en tiempo real** (P3 · Paso 6):
   - Se pide **solo tras una acción** del visitante («Usar mi ubicación»), nunca al cargar la página.
   - `watchPosition` mientras el mapa o una ficha está visible; se detiene al ocultar la pestaña (ahorro de batería).
   - Punto y círculo de precisión en el mapa, modo «seguirme», distancias y tiempos actualizados con limitación de frecuencia.
   - Aviso «estás cerca de…» al entrar en el radio de un destino (radio configurable por municipio, por defecto 150 m), solo con la página abierta. No se promete aviso en segundo plano.
   - Distancias rotuladas como **en línea recta**; tiempos como estimación. La ruta real abre la app de mapas del dispositivo (Google Maps u OpenStreetMap).
3. **Privacidad:**
   - La posición exacta **no se envía ni se guarda en el servidor**. Los cálculos se hacen en el dispositivo.
   - Para una pregunta al asistente que la necesite, se envía **redondeada (~100 m)**, solo en esa petición, y no se registra.
   - Sin historial de recorridos. La página de privacidad del municipio explica el uso.
4. **Sin ubicación todo funciona:** mapa, listas y fichas se usan con selección manual de zona; el permiso denegado no bloquea nada (RC-06).

## Consecuencias

- (+) Paridad con el sistema anterior y mejora real (seguimiento continuo, «estás cerca»).
- (+) Las consultas por distancia del asistente usan los mismos datos estructurados que el mapa.
- (−) La precisión depende del dispositivo (GPS, Wi-Fi). Se muestra el radio de precisión en vez de ocultarlo.
- (−) HTTPS obligatorio (los navegadores no dan ubicación en HTTP; `localhost` sí funciona en desarrollo).
