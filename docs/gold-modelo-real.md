# Gold con el modelo real

Registro de las corridas del gold con el modelo de producción ([ADR-045](adr/ADR-045-real-model-gold.md)): qué se corrió, sobre qué, con qué resultado, y sus limitaciones. Cómo correrlo: [despliegue](deploy.md#evaluar-con-el-modelo-real-p6--paso-3).

## Conjunto

| Suite     | Casos                                                                                                                         | Versión                                            |
| --------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Asistente | 83 de desarrollo (G01–G83), 40 reservadas (H01–H40, se corren 3 veces) y 40 de seguridad (S01–S40): 243 preguntas por corrida | `rikuy-gold/v2#…` (la huella la muestra la página) |
| Copilot   | 14 casos semilla de la auditoría (C01–C14): 11 preguntas y 3 propuestas                                                       | `rikuy-copilot-gold/v1#…`                          |

Los casos están en `packages/core/src/application/assistant/gold.ts` (G01–G51), `gold-v2.ts` (el resto) y `evaluation/copilot-gold.ts`; los datos trampa, en `evaluation/fixtures-data.ts`.

## Criterios

Los de la auditoría (documento 14, «Gates propuestos»), tal como los calcula el informe de la corrida: ver la tabla de [ADR-045](adr/ADR-045-real-model-gold.md#criterios-de-aprobación-el-informe-de-la-corrida).

## Corridas

### Corrida 1 — pendiente

Se corre en producción después del merge de P6 · Paso 3. Aquí se anotan:

- fecha, demos A y B, modelo y versión del conjunto;
- la tabla de criterios del informe (asistente y Copilot);
- los casos que fallaron, con su motivo;
- el promedio de la revisión humana;
- tokens y costo estimado a la tarifa de pago (el plan actual cuesta 0).

## Limitaciones

- Un solo modelo (`openai/gpt-oss-120b`, D4 del cierre P0): no se comparan modelos.
- La recuperación se mide como «la fuente esperada está entre lo que lee el modelo»; no se calculan precisión@5 ni nDCG.
- La factualidad se mide con hechos esperados por caso y la calificación humana 1–5, no con un juez por afirmación.
- El contenido es de muestra, no el de un municipio real: la adecuación cultural se revisa de nuevo con el contenido de Ucureña.
- G81–G83 se escribieron como reservadas y pasaron a desarrollo antes de la primera corrida (ADR-045).
