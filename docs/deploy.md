# Despliegue (P3 · Paso 8)

Cómo está montada la demo en la nube y qué se configura a mano una sola vez. Ningún secreto vive en el repositorio: las claves están en Vercel y en los _secrets_ de GitHub.

## Piezas

| Pieza                 | Dónde                                                                      | Notas                                                                                                                                  |
| --------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Base de datos         | Supabase, proyecto `rikuy` (ref `jltzysyxqureudfavgpj`), São Paulo         | Plan gratuito. Las migraciones las aplica el workflow «Deploy database»                                                                |
| Aplicación            | Vercel, proyecto `rikuy` (raíz `apps/web`), funciones en São Paulo (gru1)  | Plan Hobby: demo y pruebas. Para municipios reales (uso comercial) hace falta Pro                                                      |
| Plataforma            | `https://rikuy-app.vercel.app`                                             | `PLATFORM_ROOT_DOMAIN`                                                                                                                 |
| Panel                 | `https://rikuy-app-admin.vercel.app`                                       | `PLATFORM_ADMIN_HOST`                                                                                                                  |
| Portales de demo      | `https://rikuy-demo-norte.vercel.app`, `https://rikuy-demo-sur.vercel.app` | Registrados en `tenant_domains` (`supabase/demo/vercel-demo.sql`)                                                                      |
| Rendimiento real      | Vercel Speed Insights                                                      | Métricas anónimas, sin cookies (página de privacidad)                                                                                  |
| Lighthouse en la nube | Workflow «Lighthouse on production»                                        | Tras cada despliegue de producción, con `apps/web/lighthouse-budget.json`                                                              |
| Control diario        | Workflow «Daily health»                                                    | Cada día, los portales de `LIGHTHOUSE_ORIGINS` y el panel; evita la pausa de Supabase ([ADR-035](adr/ADR-035-free-plan-operations.md)) |
| Ejecutor de trabajos  | `POST https://rikuy-app.vercel.app/api/jobs/drain`, despertado por la base | `pg_cron` + `pg_net` ([ADR-025](adr/ADR-025-job-runner-wake-up.md)); activación en el [runbook](jobs.md)                               |
| IA                    | Groq (`openai/gpt-oss-120b`) a través del gateway, rol `rikuy_ai`          | Una sola clave para toda la plataforma ([ADR-036](adr/ADR-036-ai-gateway.md)); activación en [«Activar la IA»](#activar-la-ia-groq)    |

Un municipio nuevo con dirección gratuita se da de alta desde `/plataforma/nuevo` con un alias exacto como `rikuy-municipio.vercel.app`, que antes se agrega en Vercel → Settings → Domains. Un dominio propio (por ejemplo `turismo.municipio.gob.bo`) se agrega igual en Vercel y en el alta; no requiere cambios de código.

## Configuración única

### Supabase (proyecto `rikuy`)

1. **Contraseña de la base:** Project Settings → Database → _Reset database password_. Guárdala en tu gestor de contraseñas.
2. **Token para GitHub:** avatar → Account → Access Tokens → _Generate new token_ (`rikuy-github`).
3. **Autenticación:**
   - Authentication → Sign In / Providers → _Allow new users to sign up_: **desactivado** (nadie se registra solo). Email: activado, sin confirmación de correo, código de 6 dígitos, vence en 3600 s.
   - Authentication → URL Configuration → _Site URL_: `https://rikuy-app-admin.vercel.app`; _Redirect URLs_: `https://rikuy-app-admin.vercel.app/auth/callback`.
   - Authentication → Emails → _Magic link_: asunto «Tu código de acceso a Rikuy» y el contenido de `supabase/templates/magic-link.html` (incluye el código `{{ .Token }}` que pide el panel).
4. **Correo:** el servidor de correo incluido en Supabase solo envía a los miembros del equipo de la organización y pocos mensajes por hora. Para que entre gente de un municipio hace falta SMTP propio: ver [«Correo con SMTP gratuito»](#correo-con-smtp-gratuito-gmail).

### GitHub (Settings → Secrets and variables → Actions)

- _Secrets:_ `SUPABASE_ACCESS_TOKEN` (paso 2) y `SUPABASE_DB_PASSWORD` (paso 1).
- _Variables:_
  - `SUPABASE_PROJECT_REF` = `jltzysyxqureudfavgpj`;
  - `LIGHTHOUSE_ORIGINS` = los portales que se miden y se vigilan, `nombre=origen` separados por comas: `demo-norte=https://rikuy-demo-norte.vercel.app,demo-sur=https://rikuy-demo-sur.vercel.app,ucurena=https://rikuy-ucurena.vercel.app`. Un municipio nuevo en línea se suma aquí;
  - `ADMIN_ORIGIN` = `https://rikuy-app-admin.vercel.app` (opcional: el control diario también comprueba el panel).

### Vercel

1. Add New → Project → importar `jorgesolizvidal/rikuy`. _Root Directory_: `apps/web` (Next.js).
2. Environment Variables (Production y Preview):

   | Variable                               | Valor                                                         |
   | -------------------------------------- | ------------------------------------------------------------- |
   | `NEXT_PUBLIC_SUPABASE_URL`             | `https://jltzysyxqureudfavgpj.supabase.co`                    |
   | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | la _publishable key_ (Supabase → Project Settings → API Keys) |
   | `SUPABASE_SECRET_KEY`                  | la _secret key_ (misma pantalla), marcada como **Sensitive**  |
   | `PLATFORM_ROOT_DOMAIN`                 | `rikuy-app.vercel.app`                                        |
   | `PLATFORM_ADMIN_HOST`                  | `rikuy-app-admin.vercel.app`                                  |
   | `ENABLE_EXPERIMENTAL_COREPACK`         | `1` (usa el pnpm fijado en `package.json`)                    |

3. La región de las funciones (**São Paulo, gru1**, junto a la base) la fija `apps/web/vercel.json`; no hace falta elegirla en el panel. Settings → General → Node.js **24.x**.
4. Settings → Domains: agregar `rikuy-app-admin.vercel.app`, `rikuy-demo-norte.vercel.app` y `rikuy-demo-sur.vercel.app` (además de `rikuy-app.vercel.app`).
5. Speed Insights → _Enable_.

## Primer despliegue

1. Actions → «Deploy database» → _Run workflow_ en `main` con **seed** marcado (solo esta vez): crea las tablas y carga los dos municipios de demo.
2. En Supabase → SQL Editor, ejecutar `supabase/demo/vercel-demo.sql`: pasa la demo a sus direcciones `*.vercel.app` y quita el operador sintético.
3. Operador de la plataforma, desde tu PC (con la _secret key_ solo en la terminal, nunca en un archivo del repo):

   ```powershell
   $env:NEXT_PUBLIC_SUPABASE_URL="https://jltzysyxqureudfavgpj.supabase.co"
   $env:SUPABASE_SECRET_KEY="(secret key)"
   pnpm platform:add-operator tu-correo@ejemplo.com
   ```

   Con el correo incluido de Supabase, usa un correo que sea miembro del equipo de la organización.

4. Para editar la demo desde el panel, el operador necesita ser miembro de los municipios de demo: una sola vez, `supabase/demo/grant-demo-owner.sql` en el SQL Editor (cambiando el correo de la primera línea). Después todo sigue por «Miembros».

## Notas del primer despliegue (2026-10-19)

- `rikuy.vercel.app` y `rikuy-admin.vercel.app` ya estaban tomados en Vercel: la plataforma y el panel quedaron en `rikuy-app.vercel.app` y `rikuy-app-admin.vercel.app` (variables `PLATFORM_ROOT_DOMAIN` y `PLATFORM_ADMIN_HOST` y _Site URL_ de Supabase en consecuencia). Cambiar estas variables exige un _redeploy_ sin caché de compilación.
- Cada respuesta lleva `X-Rikuy-Version` (los primeros 12 caracteres del commit desplegado): así se sabe qué versión está en producción.

## Después

- Cada merge a `main` despliega la aplicación (Vercel) y, si trae migraciones, las aplica («Deploy database»). Las migraciones son solo _expand_, así que el orden entre ambos no rompe nada.
- Tras cada merge a `main`, «Lighthouse on production» espera a que producción sirva ese commit (`X-Rikuy-Version`) y mide la demo con el mismo presupuesto que el PR. También se puede correr a mano (Actions → _Run workflow_).
- El ejecutor de trabajos necesita `WORKER_DATABASE_URL` y `JOB_RUNNER_SECRET` en Vercel y dos secretos en Supabase Vault: pasos en [«Activar el ejecutor»](jobs.md#activar-el-ejecutor-una-sola-vez-por-ambiente). Sin ellos la aplicación funciona igual y los trabajos esperan en la cola.
- Para saber dónde corre una función, mira `x-vercel-id` en una ruta dinámica (por ejemplo `/mapa`): el segundo código es la región de la función (`…::gru1::…`). Si el job falla, el motivo aparece como anotación en la página del run (no hace falta descargar el log).

## Operación diaria con planes gratuitos

Lo que corre solo cada día ([ADR-035](adr/ADR-035-free-plan-operations.md)), sin configuración nueva más allá de las variables de GitHub:

| Hora (Bolivia) | Qué                                                                               | Dónde                                       | Si algo falla                                                                             |
| -------------- | --------------------------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 03:37          | Limpieza de fotos y logos sin uso por más de 7 días                               | Supabase (`rikuy-remove-unused-media`)      | El trabajo reintenta y, si se agota, aparece en «Trabajos»                                |
| 07:07          | Informe interno: espacio, base, trabajos y cuotas                                 | Supabase (`rikuy-daily-report`) → ejecutor  | Correo a los operadores (con SMTP) y el mismo resumen en `/plataforma`                    |
| 08:23          | Control externo: inicio y `/mapa` de cada portal, panel                           | GitHub Actions («Daily health»)             | El job falla y GitHub le escribe al dueño del repositorio; el motivo queda como anotación |
| Cada 15 min    | Reservas de IA abandonadas (más de 10 min abiertas)                               | Supabase (`rikuy-expire-ai-requests`)       | Se cuentan como usadas; también borra pedidos de más de 90 días                           |
| 03:47          | Propuestas del Copilot vencidas (30 días)                                         | Supabase (`rikuy-expire-copilot-proposals`) | Las borra; la auditoría conserva lo que se aceptó o rechazó                               |
| 03:27          | Sonda de cada portal en línea (inicio, `/mapa` y una imagen)                      | Supabase (`rikuy-probe-portals`) → ejecutor | El resultado, con su motivo si falló, en «Métricas por municipio»                         |
| 03:57          | Revisión de que lo publicado está completo                                        | Supabase (`rikuy-check-publication`)        | Los problemas, en «Métricas por municipio» → el municipio                                 |
| 04:07          | Borrado de métricas viejas (errores, tiempos y revisiones a 30 días; sondas a 90) | Supabase (`rikuy-delete-old-metrics`)       | —                                                                                         |

- **La pausa de Supabase:** el plan gratuito pausa el proyecto tras 7 días con poca actividad. «Daily health» pide `/mapa`, que lee la base en cada visita, así que mientras corra el proyecto no se pausa. GitHub desactiva los workflows programados de un repositorio sin commits en 60 días: si llega ese aviso, se vuelve a activar en Actions.
- **Probarlo a mano:** Actions → «Daily health» → _Run workflow_. La tabla del resumen dice qué respondió cada portal y con qué versión.
- **El informe interno** no envía nada si no hay nada que revisar. Avisa desde el 80 % del almacenamiento (1 GB) o de la base (500 MB), con trabajos fallidos en 24 h, con trabajo esperando más de 15 min (el ejecutor no se despierta) y con municipios al 80 % de una cuota. En los registros de Vercel queda una línea `operations.daily_report`.
- **La limpieza** solo toca fotos y logos que ninguna revisión de contenido, punto de tour ni versión de la marca usa. Panoramas, modelos 3D y copias públicas nunca se borran. Una foto subida y no guardada en 7 días hay que volver a subirla.
- **Medir el mapa en un celular:** abre `https://<portal>/mapa?medir`, espera a que el mapa cargue, pulsa «Medir la fluidez (5 s)» y «Copiar resultados». Nada se envía.

## Alta de un municipio real (por ejemplo, Ucureña)

Ningún dato del municipio entra al código ni a variables de entorno: todo se hace desde el panel, como operador de plataforma (con segundo factor).

1. **Dirección:** en Vercel → proyecto `rikuy` → Settings → Domains, agrega la dirección del portal, por ejemplo `rikuy-ucurena.vercel.app`. Si está tomada, prueba otra; es la que escribirás en el paso 2.
2. **Alta:** en `https://rikuy-app-admin.vercel.app/plataforma/nuevo`:
   - «Nombre del municipio»;
   - «Identificador» (se sugiere a partir del nombre);
   - «Dirección del portal», exactamente la del paso 1;
   - «Correo del propietario»: tu correo, para ser el propietario del municipio (debe poder recibir el código: con el correo incluido de Supabase, solo los miembros del equipo).

   La zona horaria es la de Bolivia (`America/La_Paz`).

3. **Aceptar:** en el inicio del panel aparece la invitación; «Aceptar». Al abrir el municipio, el panel pide la verificación en dos pasos (ver la sección siguiente).
4. **Marca:** en el municipio → «Marca del portal»: nombre, lema, colores, logo, contacto, redes y descripción para buscadores; «Publicar».
5. **Poner en línea:** en `/plataforma`, «Poner en línea» junto al municipio.
6. **Comprobar:**
   - el portal responde en su dirección y muestra «Muy pronto en este portal»;
   - mientras no tenga nada publicado, sus páginas llevan `<meta name="robots" content="noindex, follow">` (ver el código fuente de la página): los buscadores no lo indexan vacío;
   - al publicar el primer destino o un evento próximo, la etiqueta desaparece sola en la siguiente visita.
7. **Cuota:** cada municipio empieza con 300 MB de almacenamiento. Un panorama de 8K con sus teselas ocupa unos 17–20 MB. Antes de cargar muchos panoramas, súbela en `/plataforma` → «Cuotas por municipio». El total del plan gratuito de Supabase es de 1 GB para todos los municipios.
8. **Equipo:** en el municipio → «Miembros», invita a administradores, editores y analistas cuando haga falta. Con SMTP configurado ([«Correo con SMTP gratuito»](#correo-con-smtp-gratuito-gmail)) les llega un correo con la invitación y pueden recibir su código; sin él, solo entran los miembros del equipo de la organización de Supabase.

## Verificación en dos pasos de propietarios y administradores

Desde [ADR-043](adr/ADR-043-staff-second-factor.md), un propietario o administrador entra a su municipio solo con un segundo factor: una app de autenticación (Google Authenticator, Microsoft Authenticator, 1Password…) además del código del correo. Editores y analistas no lo necesitan.

- **La primera vez:**
  - el inicio del panel muestra «Pide verificación en dos pasos» junto al municipio;
  - al abrirlo, `/verificacion` muestra un QR y una clave para la app, y pide el código de 6 dígitos;
  - quien ya configuró la app (por ejemplo, el operador en `/plataforma`) solo escribe el código.
- **Después:** al iniciar sesión, el código de la app se pide una vez por sesión y vale para todos sus municipios.
- **En «Miembros»** cada propietario y administrador dice «Con verificación en dos pasos» o «Sin verificación en dos pasos: se le pedirá al entrar».
- **Perdió el teléfono:**
  1. el operador confirma que la persona es quien dice ser (por ejemplo, por teléfono);
  2. en `/plataforma` → «Restablecer la verificación en dos pasos», escribe su correo y confirma;
  3. la persona configura una app nueva la próxima vez que abre su municipio.

  Queda en la auditoría de cada uno de sus municipios. Las sesiones que ya tenía abiertas siguen abiertas: si alguien más pudo entrar a su cuenta, el propietario le quita el acceso en «Miembros».

- **El operador perdió su propio teléfono:** en Supabase → SQL Editor, con su correo:

  ```sql
  delete from auth.mfa_factors
  where user_id = (select id from auth.users where email = 'correo-del-operador@ejemplo.com');
  ```

  Al volver a `/plataforma`, configura una app nueva. Solo para este caso: para cualquier otra persona, usa la página del operador.

## Métricas por municipio

Desde [ADR-044](adr/ADR-044-tenant-metrics.md), `/plataforma` → «Métricas por municipio» (operador con segundo factor) muestra, por municipio, los errores del servidor, los tiempos de las rutas del asistente, el mapa y el recorrido, la sonda diaria, los trabajos, el uso y el costo estimado de la IA y si lo publicado está completo. Cada cifra dice su fuente y su período.

- **No pide configuración nueva:** usa la misma `WORKER_DATABASE_URL` del ejecutor (rol `rikuy_worker`). Sin ella, no se registra nada y el portal funciona igual.
- **Un visitante o un municipio reporta un error:** la página de error muestra un «Código de referencia». En el municipio (o en «Errores sin municipio»), búscalo en «ID de petición o código de referencia». Cada respuesta lleva también la cabecera `X-Rikuy-Request-Id`.
- **Costo de la IA:** es una estimación con la tarifa pública de Groq guardada en `ai_prices` (hoy `groq-2026-10`); el plan gratuito cuesta 0. Cuando Groq cambie su tarifa, se agrega una fila nueva con su fecha en una migración; lo ya calculado no cambia.
- **«Lo publicado está completo» con problemas:** cada problema dice qué falta. «Publicado y todavía sin leer por el asistente» con más de unos minutos indica un `knowledge.index` fallido (míralo en «Trabajos»); un archivo que falta se arregla volviendo a publicar ese contenido o tour.

## Correo con SMTP gratuito (Gmail)

Un mismo SMTP envía dos cosas ([ADR-034](adr/ADR-034-commercial-demos-and-mail.md)):

- **los códigos de acceso**, que envía Supabase Auth;
- **los correos de invitación**, que envía el ejecutor de trabajos (necesita estar activado: [runbook](jobs.md#activar-el-ejecutor-una-sola-vez-por-ambiente)).

Sin dominio propio, lo más simple y gratuito es una **cuenta de Gmail dedicada** (por ejemplo `rikuy.avisos@gmail.com`), que permite unos 500 correos al día. Brevo (300 al día) y Resend (100 al día) piden un dominio verificado para entregar bien; se cambia a ellos cuando el municipio tenga su dominio, modificando solo las variables.

1. **Cuenta:** crea la cuenta de Gmail y activa la verificación en dos pasos (Cuenta de Google → Seguridad).
2. **Contraseña de aplicación:** Cuenta de Google → Seguridad → _Contraseñas de aplicaciones_ → nombre «Rikuy». Google la muestra una sola vez (16 letras): guárdala en tu gestor de contraseñas. **Nunca** va al repositorio ni a un chat.
3. **Supabase** → Authentication → Emails → _SMTP Settings_ → _Enable custom SMTP_:

   | Campo        | Valor                                |
   | ------------ | ------------------------------------ |
   | Sender email | la cuenta de Gmail                   |
   | Sender name  | `Rikuy`                              |
   | Host         | `smtp.gmail.com`                     |
   | Port         | `465`                                |
   | Username     | la cuenta de Gmail                   |
   | Password     | la contraseña de aplicación (paso 2) |

   Después, Authentication → _Rate Limits_: con SMTP propio Supabase permite 30 correos por hora; súbelo a 60 si hace falta.

4. **Vercel** → Settings → Environment Variables, solo **Production**, las dos últimas como **Sensitive**:

   | Variable        | Valor                         |
   | --------------- | ----------------------------- |
   | `SMTP_HOST`     | `smtp.gmail.com`              |
   | `SMTP_PORT`     | `465`                         |
   | `SMTP_USER`     | la cuenta de Gmail            |
   | `SMTP_PASSWORD` | la contraseña de aplicación   |
   | `MAIL_FROM`     | `Rikuy <la-cuenta@gmail.com>` |

   Luego _Redeploy_ de producción.

5. **Comprobar:** desde el panel, «Miembros» → invita a un correo tuyo que no sea miembro del equipo de Supabase. En menos de un minuto llega «Invitación al panel de…» y la fila dice «Se le envió un correo». Al entrar al panel con ese correo llega el código. Si no llega, `/plataforma/trabajos` muestra el error del trabajo «Correo de invitación» (por ejemplo, una contraseña de aplicación mal copiada).

## Activar la IA (Groq)

Sin esto no hay IA y el portal funciona igual: el asistente muestra su aviso ([ADR-036](adr/ADR-036-ai-gateway.md)). Se hace una sola vez.

1. **La clave de Groq:** en [console.groq.com](https://console.groq.com) → _API Keys_ → _Create API Key_, con el nombre `rikuy-produccion`. Cópiala: se muestra una sola vez. **Una sola clave para toda la plataforma**: Groq aplica sus límites a la organización (tu cuenta), no a cada clave, así que una clave por municipio no agrega capacidad. El reparto entre municipios lo hacen las cuotas de Rikuy.
2. **El rol de la IA en la base:** genera una contraseña larga **solo con letras y números** (por ejemplo, 40 caracteres en tu gestor de contraseñas con los símbolos desactivados) y, en Supabase → _SQL Editor_:

   ```sql
   alter role rikuy_ai with login password '<CONTRASEÑA_DE_LA_IA>';
   ```

3. **La conexión:** Supabase → _Connect_ → _Transaction pooler_. Copia la cadena y cambia el usuario `postgres.<ref>` por `rikuy_ai.<ref>` y la contraseña por la del paso 2:
   `postgresql://rikuy_ai.<ref>:<CONTRASEÑA_DE_LA_IA>@<host-del-pooler>:6543/postgres`

   La contraseña va dentro de una dirección: `#`, `/`, `?` o `%` la rompen. Si la tuya los tiene, cámbiala o escríbelos codificados (`%23`, `%2F`, `%3F`, `%25`).

4. **Vercel** → _Settings_ → _Environment Variables_, solo en _Production_ y marcadas como _Sensitive_:
   - `AI_DATABASE_URL`: la cadena del paso 3;
   - `GROQ_API_KEY`: la clave del paso 1.

   `AI_PROVIDER` (por defecto `groq`), `AI_MODEL` (por defecto `openai/gpt-oss-120b`) y `AI_TRANSCRIPTION_MODEL` (el dictado por voz, por defecto `whisper-large-v3-turbo`, [ADR-041](adr/ADR-041-assistant-voice.md)) no hace falta definirlas. Luego _Redeploy_ de producción.

5. **Comprobar:** `/plataforma` → «Asistente con IA» dice «Conectado a Groq con openai/gpt-oss-120b (dictado por voz con whisper-large-v3-turbo)». Elige un municipio y pulsa «Probar la IA»: debe responder «listo» en uno o dos segundos. La prueba cuenta en la cuota de ese municipio (unos 100 tokens). El dictado por voz se prueba en el portal, desde un celular (con https): en el asistente, el botón del micrófono pasa tu voz a texto. Cada dictado cuenta al menos 10 s en «Uso del plan» → «Dictado por voz».

**Si no funciona:**

- «Sin configurar»: falta una variable. «Configuración con errores en …»: esa variable está mal escrita; si es `AI_DATABASE_URL`, casi siempre es un símbolo de la contraseña (paso 3). En Vercel → _Logs_, `ai.misconfigured` dice cuál.
- «La IA no está configurada… o su conexión a la base no responde»: la conexión del paso 3 (usuario `rikuy_ai.<ref>`, puerto 6543, contraseña). En los registros aparece `ai.begin_failed`.
- «Groq rechazó el pedido»: la clave (cópiala de nuevo) o el modelo.
- «Groq no respondió»: Groq caído o saturado; vuelve a probar en unos minutos.

**El asistente en el portal** ([ADR-038](adr/ADR-038-visitor-assistant.md)): con la IA activa, todos los portales muestran el botón del asistente. Cada municipio le pone nombre, saludo y tono en «Marca del portal» → «Asistente del portal» (por ejemplo, «Chaski» en Ucureña) y publica la marca. Sin nombre, el botón dice «Asistente». Responde con lo publicado, así que en un portal sin contenido dirá que no tiene esa información y ofrecerá el contacto del municipio.

**Evaluar el asistente:** `/plataforma` → «Evaluar el asistente» corre las 40 preguntas del gold con el modelo real sobre una demo en línea con su contenido de muestra (la guía del asistente se carga con él; en una demo cargada antes, «Cargar contenido de muestra» la agrega). Va de a 5 preguntas por vez, con unos segundos entre una y otra para no pasar los 8.000 tokens por minuto de Groq. Las 40 gastan unos 100–150 mil tokens: ese día, sube la cuota de IA de la demo a 200 (miles) en `/plataforma/cuotas` y vuelve a bajarla al terminar. «Copiar resultados» los deja listos para pegar.

**Límites del plan gratuito de Groq:** 200.000 tokens y 1.000 pedidos por día para toda la cuenta. Además, 8.000 tokens por minuto: unas tres preguntas por minuto en toda la plataforma; más que eso, el asistente responde «Prueba en unos minutos». Rikuy corta antes: la plataforma usa como mucho 180.000 por día y cada municipio 40.000 por defecto (unas 15–20 preguntas del asistente). Las cuotas de IA se cambian en `/plataforma/cuotas`, en miles de tokens por día. Al pasar al plan de pago de Groq se suben esos valores.

## Demo comercial para un municipio interesado

Cada municipio interesado recibe su propia demo, con su nombre y contenido de muestra (5 destinos, 3 eventos, un tour 360° con ilustraciones genéricas y una guía para el asistente). El portal de una demo **no aparece en buscadores** y avisa que es una demostración ([ADR-034](adr/ADR-034-commercial-demos-and-mail.md)).

1. **Dirección:** en Vercel → Settings → Domains, agrega por ejemplo `rikuy-demo-<municipio>.vercel.app`.
2. **Alta:** en `/plataforma/nuevo`, igual que un municipio real, con **«Demo comercial»** marcado y tu correo como propietario (así preparas la demo tú; después puedes invitar a la gente del municipio desde «Miembros»).
3. **Aceptar** la invitación en el inicio del panel, ajustar la **marca** (nombre, colores, logo del municipio si lo tienes) y **ponerla en línea** en `/plataforma`.
4. **Contenido de muestra:** en el municipio → «Contenido de muestra»:
   - pega las coordenadas de la plaza principal (clic derecho en Google Maps) y pulsa «Cargar contenido de muestra» (alrededor de un minuto);
   - cuando los panoramas terminen de procesarse (la página se actualiza sola), pulsa «Armar el tour de muestra».
5. **A medida:** reemplaza lo que quieras con fotos y textos reales del municipio desde «Destinos», «Agenda», «Panoramas 360°» y «Tours 360°». Todo se edita como cualquier contenido.
6. **Mostrarla:** comparte el enlace del portal (y el QR del recorrido, en «Tours 360°»).
7. **Después:** si el municipio contrata, se da de alta su municipio real (como Ucureña, sin «Demo comercial») y la demo se suspende en `/plataforma`. La demo ocupa unos 3–5 MB de la cuota.

## Evaluar con el modelo real (P6 · Paso 3)

`/plataforma/asistente` y `/plataforma/copilot` corren el gold con Groq sobre **dos demos** y guardan cada resultado con su costo estimado ([ADR-045](adr/ADR-045-real-model-gold.md)). Los resultados se anotan en [gold con el modelo real](gold-modelo-real.md).

1. **Demo A:** la demo que se muestra a los clientes (por ejemplo, Demo Valle), en línea, con su contenido de muestra y su tour de muestra. Nunca recibe datos de prueba.
2. **Demo B:** crea otra demo solo para evaluar (por ejemplo, «Demo Pruebas», con su dirección en Vercel), como en «Demo comercial para un municipio interesado», pasos 1 a 4: contenido de muestra **y** tour de muestra. Tienes que ser propietario de las dos.
3. **Cuotas:** una corrida completa del asistente usa unos 180.000 tokens; la del Copilot, unos 60.000. En «Cuotas por municipio», sube la cuota de IA de las dos demos (por ejemplo, a 150 mil tokens por día) mientras dure. La plataforma tiene 180.000 por día: la corrida del asistente se reparte en dos días.
4. **Asistente:** en `/plataforma/asistente` elige demo A y demo B → «Empezar una corrida» → «Preparar los datos de prueba» (y recarga hasta que no diga «la está leyendo») → «Correr la siguiente tanda» hasta terminar (5 casos por tanda, ~1,5 min cada una). Si una tanda se queda sin cuota, esos casos quedan «Sin evaluar» y se repiten solos en la tanda siguiente.
5. **Calificar:** en «Resultados», pon tu nota (1–5) a las 40 reservadas de la primera repetición: claridad y que suene natural para un visitante.
6. **Copilot:** en `/plataforma/copilot`, igual (2 casos por tanda; 14 en total). Las propuestas que crea se rechazan solas.
7. **Al terminar:** «Retirar los datos de prueba», «Copiar resultados» de cada página y «Terminar la corrida». Vuelve las cuotas a sus valores.
