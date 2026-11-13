# ADR-059 — Pasaporte turístico en «Estadísticas», el informe mensual y el Copilot

- **Estado:** Aceptada — 2026-11-13
- **Concreta:** C2 · Paso 4 (pasaporte turístico con sellos QR)
- **Se apoya en:** [ADR-051](ADR-051-anonymous-visit-counts.md) (huella diaria), [ADR-052](ADR-052-statistics-panel.md) («Estadísticas»), [ADR-054](ADR-054-copilot-recommendations.md) (recomendaciones), [ADR-055](ADR-055-monthly-report.md) (informe mensual), [ADR-057](ADR-057-passport-stamps.md) (sellos) y [ADR-058](ADR-058-passport-rewards.md) (premio)

## Contexto

Hasta el Paso 3, el servidor no guardaba nada cuando un teléfono sellaba un lugar (ADR-057). El municipio no sabía cuántos sellos hubo ni cuántas veces el visitante estaba de verdad en el lugar: justo lo que el roadmap pide del pasaporte, la mejor medida de **visitas reales en el lugar**. Los circuitos completados y los premios canjeados ya estaban en los comprobantes (ADR-058).

Decisiones del usuario (2026-11-13):

- **contar una vez por teléfono, lugar y día**, con una huella diaria que se borra a los dos días, como las visitas;
- **los sellos con ubicación se muestran como «visitas comprobadas en el lugar»**, aparte de las vistas de las páginas;
- **sus cifras entran en las recomendaciones del Copilot**;
- **el informe mensual suma una sección «Pasaporte turístico»**, en la página y en el correo.

## Decisión

1. **Totales por día** (`passport_daily_stamps`; migración `20261122000000_c2_passport_metrics.sql`):
   - municipio, día del municipio, lugar, sellos y sellos con ubicación; RLS sin permisos, nadie los lee directo;
   - `portal_collect_stamp` suma cada sello con `private.record_passport_stamp`, en la misma llamada, después de firmarlo. Un teléfono cuenta **una vez por lugar y día**; «con ubicación» suma una vez más si ese día sella desde el lugar (aunque antes haya sellado lejos). La respuesta al teléfono no cambia;
   - quién ya se contó se guarda como **huella** (`sha256` de la sal del día, el municipio, el lugar y el identificador del pasaporte) en las mismas marcas de las visitas, que se borran a los dos días. No se guarda el identificador;
   - como mucho **2.000 sellos contados por municipio y día**: después, el teléfono recibe su sello igual, pero no se cuenta (una foto de un QR en un script no infla los totales sin fin).
2. **Lectura** (`tenant_passport_statistics`, cualquier miembro; propietarios y administradores con segundo factor):
   - por período (hasta 400 días) y, si se pide, por día;
   - cada lugar con sus sellos y los con ubicación; sin días, aparecen además, con cero, las paradas que hoy se pueden sellar (destinos publicados de circuitos publicados);
   - cada circuito con cuántos teléfonos lo completaron (pidieron su comprobante, contados una vez por circuito en el período) y cuántos premios se canjearon; sin días, los circuitos publicados aparecen aunque estén en cero;
   - desde qué día se cuentan los sellos, para comparar solo períodos contados enteros.
3. **«Estadísticas»**: sección **«Pasaporte turístico»** cuando el municipio tiene un circuito publicado o algo se contó en el período: sellos, visitas comprobadas en el lugar, circuitos completados y premios canjeados, comparados con el período anterior; cada lugar con las vistas de su ficha al lado de sus sellos; cada circuito; y la descarga **«Pasaporte turístico por día» (CSV)**.
4. **Informe mensual**: la misma sección en la página y, en el correo, «Pasaporte turístico» con los totales comparados con el mes anterior, los lugares más sellados y los que no tuvieron sellos. `worker_api.monthly_report_data` suma el pasaporte del mes y del anterior.
5. **Recomendaciones del Copilot**: una fuente nueva, **«Pasaporte turístico»** (`passport`), después de las visitas:
   - los totales del período (con la comparación);
   - hasta 2 circuitos publicados, cada uno con un destino nuevo para los enlaces, **«circuit»** (un circuito de este municipio; la base lo revalida), que lleva a su editor;
   - hasta 4 paradas, las más y las menos selladas, con sus sellos y las vistas de su ficha;
   - las instrucciones suman a lo que el equipo puede hacer «colocar en cada lugar su código QR de sello». La comprobación de cifras no cambia.
6. **Privacidad**: la página del portal dice que se suman sellos por lugar y día, con una huella que cambia cada día y se borra a los dos días.

## Consecuencias

- El municipio ve cuántas personas estuvieron de verdad en cada lugar, sin datos de nadie y sin cookies.
- «Con ubicación» es lo que dice el teléfono (ADR-057): un GPS falseado lo engaña. Es un mínimo y una señal, no una prueba.
- Los sellos de antes de este paso no se cuentan (el servidor no los guardaba); los comprobantes sí, desde el Paso 3.
- Un teléfono que sella un lugar dos días seguidos cuenta dos veces, una por día, como los visitantes de las estadísticas.
- Las respuestas de `tenant_visit_statistics` no cambian; el pasaporte tiene su propia lectura, así el panel ya desplegado sigue funcionando durante el despliegue.
