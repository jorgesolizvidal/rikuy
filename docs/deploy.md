# Despliegue (P3 · Paso 8)

Cómo está montada la demo en la nube y qué se configura a mano una sola vez. Ningún secreto vive en el repositorio: las claves están en Vercel y en los _secrets_ de GitHub.

## Piezas

| Pieza                 | Dónde                                                                      | Notas                                                                                                    |
| --------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Base de datos         | Supabase, proyecto `rikuy` (ref `jltzysyxqureudfavgpj`), São Paulo         | Plan gratuito. Las migraciones las aplica el workflow «Deploy database»                                  |
| Aplicación            | Vercel, proyecto `rikuy` (raíz `apps/web`), funciones en São Paulo (gru1)  | Plan Hobby: demo y pruebas. Para municipios reales (uso comercial) hace falta Pro                        |
| Plataforma            | `https://rikuy-app.vercel.app`                                             | `PLATFORM_ROOT_DOMAIN`                                                                                   |
| Panel                 | `https://rikuy-app-admin.vercel.app`                                       | `PLATFORM_ADMIN_HOST`                                                                                    |
| Portales de demo      | `https://rikuy-demo-norte.vercel.app`, `https://rikuy-demo-sur.vercel.app` | Registrados en `tenant_domains` (`supabase/demo/vercel-demo.sql`)                                        |
| Rendimiento real      | Vercel Speed Insights                                                      | Métricas anónimas, sin cookies (página de privacidad)                                                    |
| Lighthouse en la nube | Workflow «Lighthouse on production»                                        | Tras cada despliegue de producción, con `apps/web/lighthouse-budget.json`                                |
| Ejecutor de trabajos  | `POST https://rikuy-app.vercel.app/api/jobs/drain`, despertado por la base | `pg_cron` + `pg_net` ([ADR-025](adr/ADR-025-job-runner-wake-up.md)); activación en el [runbook](jobs.md) |

Un municipio nuevo con dirección gratuita se da de alta desde `/plataforma/nuevo` con un alias exacto como `rikuy-municipio.vercel.app`, que antes se agrega en Vercel → Settings → Domains. Un dominio propio (por ejemplo `turismo.municipio.gob.bo`) se agrega igual en Vercel y en el alta; no requiere cambios de código.

## Configuración única

### Supabase (proyecto `rikuy`)

1. **Contraseña de la base:** Project Settings → Database → _Reset database password_. Guárdala en tu gestor de contraseñas.
2. **Token para GitHub:** avatar → Account → Access Tokens → _Generate new token_ (`rikuy-github`).
3. **Autenticación:**
   - Authentication → Sign In / Providers → _Allow new users to sign up_: **desactivado** (nadie se registra solo). Email: activado, sin confirmación de correo, código de 6 dígitos, vence en 3600 s.
   - Authentication → URL Configuration → _Site URL_: `https://rikuy-app-admin.vercel.app`; _Redirect URLs_: `https://rikuy-app-admin.vercel.app/auth/callback`.
   - Authentication → Emails → _Magic link_: asunto «Tu código de acceso a Rikuy» y el contenido de `supabase/templates/magic-link.html` (incluye el código `{{ .Token }}` que pide el panel).
4. **Correo:** el servidor de correo incluido en Supabase solo envía a los miembros del equipo de la organización y pocos mensajes por hora. Para la demo basta; para municipios reales hace falta un proveedor SMTP propio (Authentication → Emails → SMTP).

### GitHub (Settings → Secrets and variables → Actions)

- _Secrets:_ `SUPABASE_ACCESS_TOKEN` (paso 2) y `SUPABASE_DB_PASSWORD` (paso 1).
- _Variables:_ `SUPABASE_PROJECT_REF` = `jltzysyxqureudfavgpj` y `LIGHTHOUSE_ORIGINS` = `demo-norte=https://rikuy-demo-norte.vercel.app,demo-sur=https://rikuy-demo-sur.vercel.app`.

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
8. **Equipo:** en el municipio → «Miembros», invita a administradores, editores y analistas cuando haga falta. Con el correo incluido de Supabase, solo pueden entrar los miembros del equipo de la organización; para gente del municipio hace falta SMTP propio (Hito · Paso 2).
