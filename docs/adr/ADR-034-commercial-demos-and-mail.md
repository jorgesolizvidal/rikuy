# ADR-034 — Demos comerciales con contenido de muestra y correo de invitación por SMTP

- **Estado:** Aceptada — 2026-10-27
- **Concreta:** el Hito Demo / Portafolio del [roadmap](../roadmap.md) (Paso 2), ADR-015 (resolución por host), ADR-019 y ADR-025 (trabajos durables)

## Contexto

El usuario decidió no tener una cuenta pública de demostración: a cada municipio interesado se le muestra **su propia demo**, con su nombre, creada en minutos y sin datos de ningún municipio real. Una demo no debe aparecer en buscadores con contenido inventado, y quien la visita tiene que saber que es una demostración.

Además, las invitaciones no se avisaban por correo: la persona invitada tenía que entrar al panel por su cuenta. El correo incluido en Supabase solo envía a los miembros del equipo de la organización y pocos mensajes por hora. Solo se usan planes gratuitos y todavía no hay dominio propio.

## Decisión

1. **La demo es un tipo de municipio**, no un plan ni un dato de la marca: `tenants.is_demo`, que elige el operador al dar de alta («Demo comercial») y que después no cambia nadie, ni el propietario.
   - Llega al portal en la misma consulta que resuelve el host (`resolve_tenant_by_host`) y al panel con las membresías.
   - El portal de una demo **nunca se indexa** (`noindex, follow`), muestra arriba «Portal de demostración. El contenido es de muestra.» y su pie dice «Demostración del portal de…».
2. **Contenido de muestra con los mismos casos de uso del panel.** Solo en una demo, el propietario o un administrador abre «Contenido de muestra», pega las coordenadas del centro y obtiene:
   - **5 destinos y 3 eventos** publicados alrededor del centro, con portada y galería;
   - fechas relativas a hoy;
   - textos genéricos con el nombre del municipio, que empiezan diciendo que son de muestra.

   Después arma un **tour 360°** de dos escenas con flechas y un punto de información. Todo pasa por las subidas firmadas, la revisión de bytes, los derivados, las cuotas, la publicación y la auditoría de siempre: no hay un camino privilegiado.
   - Cargar de nuevo completa lo que falta y no duplica nada: cada elemento se reconoce por su dirección.
   - El tour se arma en un segundo paso porque sus panoramas pasan por la cola de trabajos.

3. **Ilustraciones generadas, no fotos.** Paisajes planos dibujados en SVG y rasterizados con sharp (fotos de 1600 × 1067 y panoramas de 4096 × 2048, cuyos bordes se unen). No entra ningún binario al repositorio, no se usa ninguna foto de un lugar real y no hay licencias que revisar.
4. **Correo de invitación como trabajo durable.** Invitar (también al propietario en el alta) encola `mail.membership_invitation` en la misma transacción, con un trigger en `memberships`. La clave lógica incluye la hora de la invitación: un correo por invitación.
   - El ejecutor lee la dirección bajo el arrendamiento del trabajo (nunca va en el _payload_) y envía por SMTP. Después registra `invitation_mailed_at` y audita `membership.invitation_mailed`.
   - Una invitación aceptada, revocada o reemplazada no se envía.
   - **Sin SMTP configurado, el trabajo termina sin enviar** y todo funciona como antes. Con la configuración a medias, los correos fallan y quedan visibles en «Trabajos».
   - El correo no lleva ningún secreto ni enlace mágico: dice a qué municipio y con qué rol se invitó, y cómo entrar al panel con el código de siempre.
5. **SMTP gratuito: una cuenta de Gmail dedicada con contraseña de aplicación** (unos 500 correos al día). No exige dominio propio y entrega bien. La misma cuenta se configura en Supabase Auth para los códigos de acceso.
   - Brevo (300 al día) y Resend (100 al día, 3.000 al mes) piden un dominio verificado para entregar bien. Quedan para cuando haya dominio: cambiar de proveedor es cambiar cinco variables.

## Consecuencias

- (+) Una demo para un municipio se crea en minutos desde el panel: alta, aceptar, poner en línea, «Cargar contenido de muestra» y «Armar el tour».
- (+) Ningún buscador indexa contenido inventado, ni de una demo ni de un portal vacío.
- (+) Las personas invitadas reciben un aviso y el panel muestra si el correo salió.
- (−) Al menos una vez: si el ejecutor muere entre enviar y registrar, el correo se repite.
- (−) El correo sale de una cuenta de Gmail con su nombre, no de un dominio de Rikuy. Gmail limita el envío y puede bloquear la cuenta si se usa para otra cosa.
- (−) Una demo que el municipio contrata no se convierte en real: se da de alta su municipio real (como Ucureña) y la demo se suspende.
