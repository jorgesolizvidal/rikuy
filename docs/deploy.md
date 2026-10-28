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

| Hora (Bolivia) | Qué                                                     | Dónde                                      | Si algo falla                                                                             |
| -------------- | ------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| 03:37          | Limpieza de fotos y logos sin uso por más de 7 días     | Supabase (`rikuy-remove-unused-media`)     | El trabajo reintenta y, si se agota, aparece en «Trabajos»                                |
| 07:07          | Informe interno: espacio, base, trabajos y cuotas       | Supabase (`rikuy-daily-report`) → ejecutor | Correo a los operadores (con SMTP) y el mismo resumen en `/plataforma`                    |
| 08:23          | Control externo: inicio y `/mapa` de cada portal, panel | GitHub Actions («Daily health»)            | El job falla y GitHub le escribe al dueño del repositorio; el motivo queda como anotación |

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

3. **Aceptar:** en el inicio del panel aparece la invitación; «Aceptar».
4. **Marca:** en el municipio → «Marca del portal»: nombre, lema, colores, logo, contacto, redes y descripción para buscadores; «Publicar».
5. **Poner en línea:** en `/plataforma`, «Poner en línea» junto al municipio.
6. **Comprobar:**
   - el portal responde en su dirección y muestra «Muy pronto en este portal»;
   - mientras no tenga nada publicado, sus páginas llevan `<meta name="robots" content="noindex, follow">` (ver el código fuente de la página): los buscadores no lo indexan vacío;
   - al publicar el primer destino o un evento próximo, la etiqueta desaparece sola en la siguiente visita.
7. **Cuota:** cada municipio empieza con 300 MB de almacenamiento. Un panorama de 8K con sus teselas ocupa unos 17–20 MB. Antes de cargar muchos panoramas, súbela en `/plataforma` → «Cuotas por municipio». El total del plan gratuito de Supabase es de 1 GB para todos los municipios.
8. **Equipo:** en el municipio → «Miembros», invita a administradores, editores y analistas cuando haga falta. Con SMTP configurado ([«Correo con SMTP gratuito»](#correo-con-smtp-gratuito-gmail)) les llega un correo con la invitación y pueden recibir su código; sin él, solo entran los miembros del equipo de la organización de Supabase.

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

## Demo comercial para un municipio interesado

Cada municipio interesado recibe su propia demo, con su nombre y contenido de muestra (5 destinos, 3 eventos y un tour 360° con ilustraciones genéricas). El portal de una demo **no aparece en buscadores** y avisa que es una demostración ([ADR-034](adr/ADR-034-commercial-demos-and-mail.md)).

1. **Dirección:** en Vercel → Settings → Domains, agrega por ejemplo `rikuy-demo-<municipio>.vercel.app`.
2. **Alta:** en `/plataforma/nuevo`, igual que un municipio real, con **«Demo comercial»** marcado y tu correo como propietario (así preparas la demo tú; después puedes invitar a la gente del municipio desde «Miembros»).
3. **Aceptar** la invitación en el inicio del panel, ajustar la **marca** (nombre, colores, logo del municipio si lo tienes) y **ponerla en línea** en `/plataforma`.
4. **Contenido de muestra:** en el municipio → «Contenido de muestra»:
   - pega las coordenadas de la plaza principal (clic derecho en Google Maps) y pulsa «Cargar contenido de muestra» (alrededor de un minuto);
   - cuando los panoramas terminen de procesarse (la página se actualiza sola), pulsa «Armar el tour de muestra».
5. **A medida:** reemplaza lo que quieras con fotos y textos reales del municipio desde «Destinos», «Agenda», «Panoramas 360°» y «Tours 360°». Todo se edita como cualquier contenido.
6. **Mostrarla:** comparte el enlace del portal (y el QR del recorrido, en «Tours 360°»).
7. **Después:** si el municipio contrata, se da de alta su municipio real (como Ucureña, sin «Demo comercial») y la demo se suspende en `/plataforma`. La demo ocupa unos 3–5 MB de la cuota.
