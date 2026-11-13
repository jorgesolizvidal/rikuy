# ADR-058 — Pasaporte turístico: premio y canje

- **Estado:** Aceptada — 2026-11-13
- **Concreta:** C2 · Paso 3 (pasaporte turístico con sellos QR)
- **Se apoya en:** [ADR-056](ADR-056-passport-circuits.md) (circuitos) y [ADR-057](ADR-057-passport-stamps.md) (sellos firmados en el teléfono)

## Contexto

Para toda la fase C2 se decidió que el premio se entrega con un comprobante con código corto, que el local verifica una sola vez en una página del portal, sin cuenta. Los sellos viven en el teléfono, firmados por el municipio (ADR-057).

Decisiones del usuario para este paso (2026-11-13):

- **la clave del local:** el municipio pone una clave corta a cada circuito y se la da al local. La página de canje la pide, así que el visitante no puede canjearse solo;
- **todos los sellos valen**, también los «sin ubicación», y el comprobante dice cuántos fueron con ubicación;
- **una sola vez:** un pasaporte (teléfono) recibe el premio de un circuito una vez;
- **el comprobante vence a los 30 días**; mientras no se canjee, el visitante puede pedir otro.

## Decisión

1. **Pedir el premio** (`portal_request_voucher`, anónima; migración `20261121000000_c2_passport_rewards.sql`):
   - el teléfono envía el circuito, su identificador de pasaporte y sus sellos (lugar, hora, ubicación y firma; como mucho 60);
   - la base comprueba la firma de cada sello (`private.passport_stamp_valid`) contra las paradas del circuito con su destino publicado ahora. Un sello cambiado, copiado de otro teléfono o con una hora mal formada no cuenta. Si falta alguna, responde cuántas faltan;
   - completo:
     - si ese pasaporte ya canjeó el premio del circuito, lo dice y no da otro;
     - si tiene un comprobante sin canjear y vigente, devuelve el mismo;
     - si no, crea uno nuevo, con un candado por pasaporte y circuito para que dos pedidos a la vez den uno solo;
   - un circuito sin premio, de otro municipio, retirado o de un municipio que no está en línea no da nada.
2. **El comprobante** (`passport_vouchers`, RLS sin permisos para nadie):
   - un código de 8 caracteres sin 0, O, 1 ni I (40 bits al azar, único en el municipio), que se muestra como «ABCD-EFGH»;
   - cuántos sellos tenía y cuántos con ubicación, fechas de emisión, vencimiento (30 días) y canje;
   - del pasaporte, solo una huella: `sha256(municipio:pasaporte)`. Un índice único impide que un pasaporte canjee dos veces el mismo circuito;
   - se borran a los 400 días (el período más largo de «Estadísticas», para el Paso 4).
3. **La clave del local** (`set_passport_redeem_pin`, propietarios y administradores, auditada `passport.redeem_pin_set`):
   - de 4 a 8 números; se guarda solo su hash bcrypt (`pgcrypto`) y nunca se vuelve a mostrar;
   - cambiarla deja sin efecto la anterior;
   - `tenant_passport_rewards` dice a cualquier miembro qué circuitos la tienen.
4. **Canjear** (`portal_redeem_voucher`, anónima, porque el local no tiene cuenta):
   - con el código (en minúsculas, con guion o espacios) y la clave del circuito;
   - sin canjear (`p_redeem` falso) solo comprueba y muestra el comprobante; con verdadero lo marca canjeado una vez y lo audita (`passport.voucher_redeemed`);
   - responde «ya canjeado» con la fecha, «vencido» o, si el circuito no tiene clave, que se la pidan al municipio;
   - un código o una clave equivocados dan la misma respuesta y cuentan como fallo. Con 30 fallos en una hora en el municipio, la página deja de comprobar hasta la hora siguiente.
5. **Portal:**
   - en la página del circuito, con todas sus paradas selladas: «Pedir mi premio» → «Tu comprobante» con el código grande, el premio, hasta cuándo vale y cuántos sellos fueron con ubicación;
   - el comprobante se guarda en el teléfono, junto a los sellos. Al volver a la página se pregunta una vez si ya se canjeó, y entonces dice «Premio recibido»; si venció sin usarse, da uno nuevo;
   - la página del sello, al completar un circuito, enlaza a «Pedir mi premio»;
   - **`/canje`** («Canjear un premio», `noindex`, sin enlace desde el portal): código, clave del local, «Comprobar» y después «Marcar como canjeado y entregar el premio». El botón del asistente no aparece ahí;
   - `POST /premio` y `POST /canje/verificar`, solo desde una página del mismo portal;
   - «Cómo funciona» y la página de privacidad lo explican.
6. **Panel**, en el editor del circuito: sección «Premio y canje» con la dirección de `/canje` para dársela al local, si tiene clave (y desde cuándo) y el formulario para guardarla o cambiarla (propietarios y administradores). Sin premio, la sección lo dice.

## Consecuencias

- El premio solo se consigue con los sellos que el municipio firmó para ese teléfono, y se entrega una vez por pasaporte.
- Quien borre los datos del navegador empieza un pasaporte nuevo y podría volver a juntar los sellos, con una visita (o fotos de los QR) a cada lugar. Es la protección básica que pide el roadmap; si una foto circula, se renueva el QR (ADR-057).
- La clave del local es una por circuito: si dos locales entregan el mismo premio, comparten la clave. Cambiarla obliga a avisar a todos.
- El servidor guarda del visitante solo la huella del pasaporte en cada comprobante, sin datos personales.
- Las cifras de comprobantes pedidos y canjeados llegan a «Estadísticas» y al informe mensual en el Paso 4.
