# ADR-020 — Entrega de panoramas según resolución

- **Estado:** Aceptada — 2026-10-17
- **Concreta:** ADR-017 (Photo Sphere Viewer + manifest propio)
- **Modifica:** criterio 5 del gate P6 ("perfil tiled aprobado")
- **Evidencia:** benchmarks P0 M-01 (800 mediciones; ver [cierre P0](../p0-closure.md))

## Contexto

P0 comparó cinco variantes (monolítica, equirect tiles 512/1024, cube tiles 512/1024) con las panorámicas reales disponibles, de **2048–2880 px de ancho**:

- En red rápida el p95 de "panorama utilizable" fue 1,24–1,40 s para todas; en red lenta 6,5–7,6 s. **Las diferencias entre variantes fueron pequeñas**; el peso dominante fue el bundle de JavaScript común (~760 KB del harness), no la imagen.
- Los tiles equirect 512 reducen 37–43 % los bytes de imagen frente a la monolítica, pero apenas cambian el tiempo hasta el uso a esta resolución.
- Muchas GPUs móviles limitan las texturas a 4096 px: una panorámica de 8K entregada como imagen única se reduce o falla en el teléfono.
- No existen todavía fuentes 8K/16K autorizadas, por lo que el gate P6 tal como estaba ("perfil tiled aprobado con fuentes de alta resolución") era inalcanzable.

## Decisión

Política automática por asset, sin configuración por municipio:

| Ancho del original | Entrega                                                                                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| ≤ 4096 px          | Preview borroso (~20–40 KB) + **una imagen WebP** de alta calidad (q≈85–90)                                                              |
| > 4096 px          | Preview + **tiles equirectangulares** multirresolución (adapter oficial de PSV); la variante monolítica ≤ 4096 queda como compatibilidad |

- Cube tiles queda como comparador; se adopta solo si una medición con fuentes > 4096 px muestra mejora material en calidad, memoria o costo.
- El original se conserva byte a byte; la calidad final depende de subir **originales de cámara**, no derivados ya comprimidos.
- El gate P6 #5 pasa a: "pipeline durable con la política por resolución funcionando; el perfil tiled se valida en dispositivo físico cuando exista al menos una fuente > 4096 px autorizada".

## Consecuencias

- (+) Calidad máxima posible en cada dispositivo sin pagar la complejidad de tiles donde no aporta.
- (+) La mejora de velocidad se busca donde P0 la encontró: code-splitting del visor, preview inmediato y CDN.
- (−) Pendiente medir en Android físico y Safari/iOS (NOT_MEASURED en P0).
