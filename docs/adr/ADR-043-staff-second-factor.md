# ADR-043 — Segundo factor obligatorio para propietarios y administradores de los municipios

- **Estado:** Aceptada — 2026-11-07
- **Concreta:** ADR-004 para el roadmap P6 · Paso 1 (criterio 2 del gate)

## Contexto

ADR-004 separa la identidad global (Supabase Auth) de la autorización por membresía en cada municipio. Desde P1 · Paso 6, el operador de plataforma actúa solo con segundo factor:

- la base exige `aal2` en el JWT en cada verificación de operador (`private.is_platform_operator`);
- el panel lo configura con TOTP (app de autenticación) en `/plataforma`.

Los propietarios y administradores de un municipio podían, en cambio, publicar, cambiar la marca, gestionar miembros y volver a versiones anteriores solo con el código de acceso que llega por correo. El criterio 2 del gate P6 pide que no sea así.

Hechos:

- **Toda** autorización por municipio pasa por una sola función, `private.has_tenant_role`: RPC por intención, políticas RLS de tablas y políticas de Storage.
- TOTP funciona en el plan gratuito de Supabase y ya está en producción para el operador.
- El nivel `aal2` queda en la sesión: un refresco del token lo conserva. Una persona verifica una vez por sesión, no una vez por municipio.
- Hoy hay pocas personas con esos roles en producción: el usuario y una administradora de Ucureña.
- Supabase Auth no trae códigos de recuperación.

Decisiones del usuario (2026-11-07):

- **todo el panel del municipio:** sin segundo factor, un propietario o administrador no entra a ese municipio;
- **desde el despliegue**, sin período de gracia;
- **una pantalla para configurarlo** al abrir el municipio, mientras sigue usando los municipios donde es editor o analista;
- **el operador lo restablece** si alguien pierde el teléfono.

## Decisión

### En la base

`private.has_tenant_role` cuenta una membresía activa de propietario o administrador **solo si el JWT tiene `aal2`**. Editores y analistas no cambian. Como todo pasa por ahí, la regla vale a la vez para las RPC, las tablas y Storage, sin tocar cada función.

Sin `aal2`, un propietario no conserva un acceso menor: para la base no es miembro de ese municipio. Ver sin publicar sería un acceso a medias que la decisión descarta.

`my_memberships()` (cualquier persona con sesión) devuelve sus membresías activas en municipios en preparación o en línea, con su rol y `needs_second_factor`. La misma regla, leída del mismo JWT, decide qué muestra el panel. Sin ella, el municipio desaparecería de la lista, porque la tabla `tenants` ya no se lee sin el factor.

### En el panel

- La lista de inicio muestra cada municipio que lo pide con «Pide verificación en dos pasos».
- Al abrir uno, la página lleva a **`/verificacion`**:
  - quien no tiene factor ve el QR y la clave para la app;
  - quien ya lo tiene, el campo del código.
- Al verificar, vuelve al municipio. La sesión queda en `aal2` para todos sus municipios.
- Las acciones del servidor no ven un municipio que pide el factor (resultado «sin permiso»). La base lo rechaza igual.
- `/verificacion` usa el mismo componente que `/plataforma`. A quien no le hace falta, lo devuelve a donde iba.

### Restablecer

En `/plataforma/segundo-factor`, el operador (con su propio segundo factor) escribe el correo de la persona y confirma.

`platform_second_factor_reset(p_email)` hace todo en **una transacción**:

1. comprueba al operador con `aal2`;
2. exige que la persona sea propietaria o administradora (activa o invitada) de algún municipio y que no sea el propio operador;
3. borra sus factores TOTP de `auth.mfa_factors` (sus desafíos se borran en cascada);
4. deja en la auditoría de cada uno de sus municipios `membership.second_factor_reset`, con el operador y cuántos factores se borraron.

La persona configura uno nuevo al volver a entrar. No hace falta la clave secreta: el rol dueño de la función puede borrar en `auth.mfa_factors` (comprobado en producción con una consulta de solo lectura de privilegios). Así el borrado y su auditoría no pueden quedar a medias.

Restablecer **no cierra las sesiones abiertas**: una sesión que ya verificó conserva su `aal2`. Si se sospecha de una cuenta tomada, el propietario le quita el acceso en «Miembros» (el efecto es inmediato).

En «Miembros», propietarios y administradores ven, para cada propietario y administrador, si ya configuró la verificación en dos pasos (`tenant_member_second_factors`).

### Datos de prueba

El seed local le da a los dos propietarios de demo un factor TOTP verificado con una clave conocida y documentada. Así las pruebas de integración y del navegador pasan el segundo factor con un código real de GoTrue. El operador del seed sigue sin factor, porque el ensayo ZC-01 prueba su enrolamiento.

## Consecuencias

- Criterio 2 del gate:
  - sin segundo factor, un propietario o administrador no lee, no publica y no gestiona miembros;
  - lo prueban pgTAP (casos negativos por RPC, tabla y Storage) y RC-15 sobre la API real.
- La primera vez después del despliegue, el usuario y la administradora de Ucureña configuran la app. El panel los lleva solo.
- Una persona que es editora en un municipio y propietaria en otro sigue trabajando como editora sin el factor.
- Durante el despliegue (base y web no salen en el mismo segundo):
  - si la web nueva sale antes que la base, lee las membresías como antes;
  - si la base sale antes que la web, los municipios de propietarios y administradores sin factor desaparecen de la lista por unos minutos.
- Sin códigos de recuperación, perder el teléfono depende del operador. Si el operador pierde el suyo, se borra su factor con una consulta en el SQL Editor de Supabase. Queda en el [runbook de despliegue](../deploy.md).
