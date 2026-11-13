# ADR-055 — Informe mensual para la alcaldía

- **Estado:** Aceptada — 2026-11-12
- **Concreta:** C1 · Paso 5 (métricas y estrategia)
- **Se apoya en:** [ADR-051](ADR-051-anonymous-visit-counts.md) (visitas), [ADR-052](ADR-052-statistics-panel.md) («Estadísticas»), [ADR-053](ADR-053-unanswered-questions.md) (preguntas sin respuesta), [ADR-054](ADR-054-copilot-recommendations.md) (recomendaciones), [ADR-034](ADR-034-commercial-demos-and-mail.md) (correo) y [ADR-019](ADR-019-pilot-jobs-on-vercel.md) y [ADR-025](ADR-025-job-runner-wake-up.md) (trabajos)

## Contexto

Con C1 · Pasos 1–4, el municipio ve sus números en el panel. Pero quien decide en la alcaldía no entra al panel. El roadmap pide un **informe mensual**, con este criterio: **el informe del mes llega solo y se entiende sin el panel**.

Decisiones del usuario (2026-11-12):

- **Contenido:** visitas y acciones, lo más visto, preguntas sin respuesta y el estado del contenido.
- **A quién llega el correo:** propietarios y administradores del municipio.
- **Recomendaciones del Copilot:** sí, generadas solas el día 1 con las cifras del mes.
- **Formato:** una página imprimible en el panel (imprimir o guardar como PDF desde el navegador), sin generar archivos.

Además, en producción, una recomendación de C1 · Paso 4 pidió «publicar la ficha del Tambo… que está publicada». Se corrige aquí, porque el informe usa las mismas recomendaciones.

## Decisión

1. **Una página por mes, para cualquier miembro:** `/o/{slug}/informe?mes=AAAA-MM`. Por defecto, el mes que terminó; se ofrecen el mes en curso (hasta hoy) y los 12 anteriores.
   - **Visitas:** los siete totales de «Estadísticas», comparados con el mes anterior completo (o, en el mes en curso, con los mismos días del mes anterior) solo si se contó entero; las vistas por día y el origen.
   - **Lo más visto:** los 10 destinos y eventos con más vistas y sus acciones; los tours 360° más vistos.
   - **Preguntas sin respuesta del mes:** total, personas y las 10 más frecuentes, cada una con «Probar en «Conocimiento del asistente»».
   - **Estado del contenido:** lo publicado en el mes (nuevo o actualizado, también los tours) y lo que falta completar hoy (la revisión del Copilot).
   - **Recomendaciones del Copilot del mes**, con «En qué se basa» y sus enlaces (los mismos componentes que «Estadísticas»).
   - **Por correo:** cuándo salió y a cuántas personas; «Enviar este informe ahora por correo» para propietarios y administradores.
   - **Imprimir:** «Imprimir o guardar como PDF» abre el diálogo del navegador. Los estilos de impresión ocultan la barra, el selector, el correo y los enlaces del panel.

   Las cifras salen de las **mismas funciones** que «Estadísticas», «Lo que preguntan los visitantes» y la revisión del contenido. Se mueven a funciones privadas que reciben el municipio; las públicas conservan su control de rol y las llaman (mismas respuestas). Se suman `tenant_unanswered_questions_between` (hasta 92 días) y `tenant_content_activity` (lo publicado en un período, en los días del municipio).

2. **El día 1, un trabajo durable** `reports.monthly` (cola `mail`, 4 intentos):
   - la tarea diaria `rikuy-monthly-reports` (11:37 UTC) encola el mes que terminó para cada municipio en línea, durante los 3 primeros días de su mes (si un día falla, se recupera; la clave lógica `monthly:AAAA-MM` deja uno solo). Nunca un mes anterior al alta del municipio;
   - el trabajo lee, bajo su arrendamiento y solo para su municipio, las cifras del mes (`worker_api.monthly_report_source` y `monthly_report_data`), pide **una vez** las recomendaciones al Copilot como la plataforma (pedido `copilot` del gateway, sin persona, con la cuota de IA del municipio), y guarda el resultado (`worker_api.save_monthly_report`);
   - envía a cada propietario y administrador activo el **resumen en el correo**: visitas con su comparación, lo más visto, las preguntas sin respuesta más frecuentes, el estado del contenido, las recomendaciones (o por qué no hay) y el enlace a la página. Texto y HTML simple, sin imágenes ni seguimiento;
   - registra el envío una vez (`worker_api.mark_monthly_report_mailed`) y audita `report.monthly_generated` y `report.monthly_mailed`.

   Un reintento **no vuelve a preguntar** al modelo (la base sabe que este mismo trabajo ya guardó las recomendaciones) **ni reenvía** a quien ya recibió el correo (el punto de control cuenta los enviados). Sin SMTP, el informe se guarda y no se envía nada; sin IA, va sin recomendaciones y lo dice.

3. **«Enviar este informe ahora por correo»** (`request_monthly_report`): propietarios y administradores, con el municipio en línea, hasta **3 veces por día** (`PT429`). Genera de nuevo las recomendaciones del mes elegido (incluido el mes en curso, hasta hoy) y envía el correo. Auditado (`report.monthly_requested`).

4. **Lo que se guarda:** `monthly_reports`, una fila por municipio y mes, con las recomendaciones, sus hechos (o el motivo por el que no hay), cuándo se generaron y cuándo y a cuántos se envió. **Las cifras no se guardan**: la página y el correo las calculan. RLS sin permisos para nadie; se lee con `tenant_monthly_report` (cualquier miembro). Las recomendaciones pasan las **mismas comprobaciones** que las del panel (`private.assert_valid_recommendations`: hechos de este municipio, cada cifra en los hechos que cita, sin enlaces) y deben apoyarse en un pedido `copilot` completado por la plataforma, en ese municipio, en la última hora. Los hechos pueden citar una pregunta de un visitante: a los **90 días** se borran (`rikuy-forget-monthly-recommendations`), como las preguntas (ADR-053); la fila conserva cuándo se envió.

5. **Los hechos dicen su período.** `recommendationFacts` recibe cómo nombrar el período y con qué se compara: «últimos 30 días» frente a «los 30 días anteriores» en «Estadísticas»; «octubre de 2026» frente a «el mes anterior» en el informe.

6. **Publicar lo que ya está publicado no se recomienda:**
   - las instrucciones dicen que solo se publica lo que un hecho dice que está en borrador o con cambios sin publicar;
   - `parseRecommendations` descarta una recomendación que pide publicar cuando **todos** los lugares que cita están publicados sin cambios pendientes (según la foto del Copilot). Vale para «Estadísticas» y para el informe.

## Consecuencias

- El informe llega solo el día 1 a quienes deciden, se entiende sin entrar al panel, y la página completa se imprime o se guarda como PDF desde cualquier navegador, sin generar archivos en el servidor.
- El primer correo automático sale el 1 de diciembre (con noviembre). Antes, se puede pedir desde la página.
- Cada informe usa unos miles de tokens de la cuota diaria de IA del municipio el día 1. Si la cuota o el proveedor fallan, el informe sale igual, sin recomendaciones, y dice por qué.
- «Lo que falta completar» es la revisión del día en que se mira el informe (o del día 1 en el correo), no una foto del fin de mes: la página lo dice.
- Al menos una vez: si el ejecutor muere entre enviar un correo y guardar el punto de control, esa persona puede recibirlo dos veces.
- El correo sale de la cuenta de Gmail dedicada (ADR-034): puede caer en spam hasta que haya dominio propio.
