# ADR-057 — Pasaporte turístico: sellos con QR

- **Estado:** Aceptada — 2026-11-13
- **Concreta:** C2 · Paso 2 (pasaporte turístico con sellos QR)
- **Se apoya en:** [ADR-056](ADR-056-passport-circuits.md) (circuitos), [ADR-021](ADR-021-visitor-location.md) (la ubicación no sale del dispositivo) y [ADR-047](ADR-047-slug-redirects.md) (la dirección de un destino puede cambiar)

## Contexto

Las decisiones de toda la fase C2 (ADR-056) son estas: el sello es un QR firmado por lugar, más la ubicación si el visitante la comparte; los sellos se guardan solo en el teléfono, sin cuenta; el premio (Paso 3) se canjea con un comprobante que el local verifica una vez.

Decisiones del usuario para este paso (2026-11-13):

- **radio:** el de «Estás cerca de…» de la marca del municipio (150 m por defecto), sin un ajuste nuevo;
- **renovar el QR:** propietarios y administradores lo renuevan desde el panel; el impreso deja de sellar (por ejemplo, si alguien lo fotografía y lo comparte para sellar sin ir);
- **un solo sello por lugar**, que vale para todos los circuitos que lo tienen;
- **los sellos no vencen.**

## Decisión

1. **El código de sello** (`passport_stamp_codes`, migración `20261120000000_c2_passport_stamps.sql`, solo expand):
   - 22 caracteres base64url al azar (128 bits) por destino, creados por un trigger la primera vez que el destino entra en un circuito, y conservados si sale y vuelve;
   - el QR abre `/sello/{código}` en el portal;
   - el código es el secreto: quien lo tiene puede sellar. Por eso lo ven propietarios, administradores y editores (lo imprimen), no los analistas, y nadie lee la tabla directamente;
   - `renew_passport_stamp_code` (propietarios y administradores, con la versión que vio la persona; `PT409` si cambió) le da un código nuevo y lo audita (`passport.stamp_code_renewed`). Los sellos que ya tienen los visitantes siguen valiendo.
2. **El sello es una firma del municipio**:
   - `portal_collect_stamp` (anónima) solo sella con un código vigente de un destino publicado que es parada de un circuito publicado, en un municipio en línea;
   - devuelve el lugar (su id: una dirección cambiada no rompe nada), la hora del servidor, si estaba en el lugar y la firma `HMAC-SHA256(clave, "v1:{municipio}:{lugar}:{pasaporte}:{hora}:{cerca}")`;
   - la clave es de cada municipio (32 bytes al azar en `private.passport_keys`, que solo leen las funciones). `private.passport_stamp_valid` comprueba la firma para el premio (Paso 3): un sello cambiado en el teléfono («sin ubicación» pasado a «con ubicación», otro pasaporte u otro municipio) deja de valer;
   - el servidor no guarda nada del visitante: ni el sello, ni el pasaporte, ni si estaba cerca.
3. **El pasaporte vive en el teléfono** (`localStorage` del portal, clave `rikuy:passport`):
   - un identificador al azar de 128 bits que crea el teléfono al primer sello (no dice quién es la persona) y un sello por lugar;
   - el primer sello de un lugar se conserva, salvo que llegue uno «con ubicación» para uno «sin ubicación»;
   - nada se escribe hasta que el visitante pulsa «Sellar».
4. **La ubicación no sale del teléfono** (ADR-021):
   - se pide solo al pulsar «Sellar con mi ubicación»; el teléfono calcula la distancia al lugar con el radio de la marca y envía solo «estoy cerca: sí o no»;
   - una lectura menos precisa que el radio (o 100 m) no cuenta como cerca, como en el aviso «Estás cerca de…»;
   - lejos, sin permiso, sin señal o con «Sellar sin compartir mi ubicación», el sello vale igual y queda «sin ubicación», y la página dice por qué.
5. **Portal:**
   - `/sello/{código}`: renderizada en cada petición, `noindex` y sin `Referer` (el código está en la dirección); «Sellar con mi ubicación» o «Sellar sin compartir mi ubicación», el resultado en palabras y el avance de cada circuito con ese lugar. Un código renovado, de otro municipio o inventado dice «Este código no sella»;
   - `POST /sellar` (solo desde una página del mismo portal, hasta 1 KB);
   - en `/pasaporte` y en cada circuito, lo que tiene este teléfono: «Tienes 2 de 4 sellos», «Sellado el 13 nov · con ubicación» en cada parada y «¡Completaste el circuito!». Las páginas siguen en la caché del municipio: eso se llena en el navegador, en un espacio reservado;
   - privacidad: qué se envía al sellar, que no se guarda y que los sellos viven en el navegador.
6. **Panel, «Pasaporte turístico»:** «Códigos de sello de cada lugar», con el QR de cada parada (PNG y SVG, con la versión en el nombre del archivo), los circuitos que la usan, un aviso si todavía no sella (destino sin publicar o ningún circuito publicado) y «Renovar el QR» con confirmación.

## Consecuencias

- Un sello no se puede inventar ni cambiar en el teléfono: el premio (Paso 3) lo comprueba con la clave del municipio.
- Una foto del QR compartida sigue sellando hasta que se renueva. La marca «con ubicación» es lo que dice el teléfono: un GPS falseado la engaña. Es una protección básica, como pide el roadmap, no una prueba de presencia.
- Borrar los datos del navegador, o cambiar de navegador o de teléfono, deja los sellos atrás: no hay cuenta para recuperarlos.
- Renovar un código no invalida los sellos ya entregados; la clave del municipio no se rota en este paso.
- Los sellos todavía no se cuentan en «Estadísticas»: llegan con el Paso 4.
