# Despliegue (P3 · Paso 8)

Cómo está montada la demo en la nube y qué se configura a mano una sola vez. Ningún secreto vive en el repositorio: las claves están en Vercel y en los _secrets_ de GitHub.

## Piezas

| Pieza                 | Dónde                                                                      | Notas                                                                             |
| --------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Base de datos         | Supabase, proyecto `rikuy` (ref `jltzysyxqureudfavgpj`), São Paulo         | Plan gratuito. Las migraciones las aplica el workflow «Deploy database»           |
| Aplicación            | Vercel, proyecto `rikuy` (raíz `apps/web`), funciones en São Paulo (gru1)  | Plan Hobby: demo y pruebas. Para municipios reales (uso comercial) hace falta Pro |
| Plataforma            | `https://rikuy.vercel.app`                                                 | `PLATFORM_ROOT_DOMAIN`                                                            |
| Panel                 | `https://rikuy-admin.vercel.app`                                           | `PLATFORM_ADMIN_HOST`                                                             |
| Portales de demo      | `https://rikuy-demo-norte.vercel.app`, `https://rikuy-demo-sur.vercel.app` | Registrados en `tenant_domains` (`supabase/demo/vercel-demo.sql`)                 |
| Rendimiento real      | Vercel Speed Insights                                                      | Métricas anónimas, sin cookies (página de privacidad)                             |
| Lighthouse en la nube | Workflow «Lighthouse on production»                                        | Tras cada despliegue de producción, con `apps/web/lighthouse-budget.json`         |

Un municipio nuevo con dirección gratuita se da de alta desde `/plataforma/nuevo` con un alias exacto como `rikuy-municipio.vercel.app`, que antes se agrega en Vercel → Settings → Domains. Un dominio propio (por ejemplo `turismo.municipio.gob.bo`) se agrega igual en Vercel y en el alta; no requiere cambios de código.

## Configuración única

### Supabase (proyecto `rikuy`)

1. **Contraseña de la base:** Project Settings → Database → _Reset database password_. Guárdala en tu gestor de contraseñas.
2. **Token para GitHub:** avatar → Account → Access Tokens → _Generate new token_ (`rikuy-github`).
3. **Autenticación:**
   - Authentication → Sign In / Providers → _Allow new users to sign up_: **desactivado** (nadie se registra solo). Email: activado, sin confirmación de correo, código de 6 dígitos, vence en 3600 s.
   - Authentication → URL Configuration → _Site URL_: `https://rikuy-admin.vercel.app`; _Redirect URLs_: `https://rikuy-admin.vercel.app/auth/callback`.
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
   | `PLATFORM_ROOT_DOMAIN`                 | `rikuy.vercel.app`                                            |
   | `PLATFORM_ADMIN_HOST`                  | `rikuy-admin.vercel.app`                                      |
   | `ENABLE_EXPERIMENTAL_COREPACK`         | `1` (usa el pnpm fijado en `package.json`)                    |

3. Settings → Functions → _Function Region_: **São Paulo (gru1)**, junto a la base. Settings → General → Node.js **24.x**.
4. Settings → Domains: agregar `rikuy-admin.vercel.app`, `rikuy-demo-norte.vercel.app` y `rikuy-demo-sur.vercel.app` (además de `rikuy.vercel.app`).
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

4. Para editar la demo desde el panel, el operador (o quien se agregue) necesita ser miembro de los municipios de demo: se hace una vez por SQL y luego todo sigue por «Miembros».

## Después

- Cada merge a `main` despliega la aplicación (Vercel) y, si trae migraciones, las aplica («Deploy database»). Las migraciones son solo _expand_, así que el orden entre ambos no rompe nada.
- Tras cada despliegue de producción corre «Lighthouse on production» con el mismo presupuesto que el PR.
