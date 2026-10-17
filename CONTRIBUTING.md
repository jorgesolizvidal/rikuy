# Guía de ingeniería — Rikuy

Este documento define **cómo se construye Rikuy**. Las reglas marcadas como _no negociables_ protegen el aislamiento entre municipios, la seguridad y la velocidad de carga; un cambio que las rompa no se mergea aunque "funcione".

Lectura previa recomendada: [arquitectura](docs/architecture.md), [roadmap](docs/roadmap.md), [ADRs](docs/adr/README.md) y el estado actual en [CHECKPOINT](docs/progress/CHECKPOINT.md).

## 1. Reglas no negociables

### 1.1 Capas (ADR-016)

```
UI (RSC / Client Components)
  → Server Action / Route Handler (adaptador HTTP: valida input, sesión, CSRF)
    → caso de uso en @rikuy/core/application (autoriza y orquesta)
      → puerto de repositorio → adaptador en @rikuy/db (Supabase Data API / RPC)
```

- `@rikuy/core` es framework-free: **no importa** Next.js, React, Supabase, SDKs de IA ni runtimes de jobs (ESLint lo impide).
- Los componentes **no** importan `@supabase/*` ni hacen SQL. Reciben DTOs.
- Toda mutación sensible es un caso de uso por intención (`publishContent`, `inviteMember`), no un CRUD genérico.
- Las operaciones que tocan varias tablas (publicar, membresías, dominios, cuotas) son **una transacción** vía RPC, nunca varias llamadas sueltas.

### 1.2 Multi-tenancy (ADR-003, ADR-015)

- El tenant se resuelve **en el servidor** a partir del host, consultando el registro `tenant_domains`. Nunca desde headers, query, body ni cookies enviados por el cliente.
- Host desconocido o tenant suspendido → 404/503 explícito. **No hay tenant por defecto** ni fallback a Ucureña.
- Toda fila de un tenant lleva `tenant_id NOT NULL`; las relaciones entre entidades de tenant usan **FK compuestas** `(tenant_id, id)`.
- **Ningún literal de municipio en el código** ("Ucureña", rutas, colores, textos, prompts). Todo eso es dato del tenant. Dar de alta un municipio nuevo no requiere tocar código ni variables de entorno (ZC-01).
- Cachés (CDN, Next, React Query) incluyen tenant, idioma y versión publicada en la clave.
- Las Server Actions **no** usan `redirect()`: Next renderiza el destino con un fetch interno a su propio origen y se salta la resolución por host. La acción devuelve estado y el cliente navega (regla de ESLint en `actions.ts`).

### 1.3 Datos y seguridad

- RLS habilitada y grants mínimos en **todas** las tablas expuestas. Cada migración trae sus tests (pgTAP) con casos negativos: usuario de A pidiendo datos de B, rol revocado, visitante leyendo borradores.
- `SUPABASE_SECRET_KEY` solo en adaptadores de plataforma aislados (aprovisionamiento, firma de Storage). Nunca en peticiones ordinarias, nunca en el navegador, nunca al alcance del LLM.
- La IA nunca decide tenant ni permisos; las herramientas del Copilot llaman a los mismos casos de uso que la UI.
- Rich text como AST permitido; sin HTML/CSS/JS arbitrario de tenants.

### 1.4 Secretos

- Solo se versiona `.env.example`. Los valores reales van en `apps/web/.env.local` (ignorado) y en el panel de Vercel.
- El CI ejecuta **gitleaks** en cada push y PR. Si detecta un secreto: se rota la clave primero y después se limpia el historial.

### 1.5 Medios

- **Ningún binario de contenido en el repositorio**: imágenes, panorámicas, GLB, logos de municipios. Son assets del tenant y viven en Storage.
- Para cargar datos iniciales se usa `seed-assets/` (ignorada por git) y un script de seed.
- Originales privados e inmutables; el público solo recibe derivados publicados (ADR-006, ADR-017, ADR-020).

### 1.6 Rendimiento y accesibilidad

- Cada ruta pública respeta el [presupuesto de rendimiento](docs/performance-budget.md). Visores 360°/3D, mapas y librerías pesadas se cargan con import dinámico, nunca en el bundle inicial.
- Accesibilidad básica obligatoria: nombres accesibles, foco visible, navegación por teclado, `alt`, `prefers-reduced-motion` y alternativa textual a los canvas (tour y modelo 3D).

## 2. Convenciones

| Tema        | Convención                                                                                                                                                |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Idioma      | Código, identificadores y commits en **inglés**. Documentación e interfaz en **español**.                                                                 |
| Commits     | [Conventional Commits](https://www.conventionalcommits.org/): `feat(web): ...`, `fix(db): ...`, `docs: ...`, `ci: ...`, `chore: ...`                      |
| Ramas       | `feat/<paso>`, `fix/<tema>`, `docs/<tema>`. Un paso del roadmap = una rama = un PR.                                                                       |
| PR          | CI en verde, checkpoint actualizado, sin secretos ni binarios. Descripción con qué cambia, cómo se probó y riesgos.                                       |
| Migraciones | `supabase/migrations/<timestamp>_<nombre>.sql`, siempre con tests. Expand → migrate → contract; nunca destructivas en el mismo release que su consumidor. |
| Versiones   | Dependencias fijadas (sin `^`). Actualizaciones en PR propio.                                                                                             |

## 3. Comandos

```bash
pnpm install          # instala todo el monorepo
pnpm dev              # portal/admin en http://localhost:3000
pnpm check            # format + lint + typecheck + test + build (lo mismo que el CI)
pnpm format           # aplica Prettier

# Base de datos local (requiere Docker Desktop abierto)
pnpm db:start         # levanta Supabase local; imprime URL y claves locales
pnpm db:status        # vuelve a mostrar URL y claves
pnpm db:reset         # recrea la base: migraciones + seed sintético
pnpm db:test          # tests pgTAP de RLS, aislamiento e invariantes
pnpm db:lint          # lint de SQL/PLpgSQL
pnpm db:types         # genera tipos TypeScript del esquema
pnpm db:stop          # detiene los contenedores
```

Requisitos: Node 24 (`.nvmrc`), pnpm 12 y Docker Desktop (para Supabase local).

Nueva migración: `pnpm exec supabase migration new <nombre>` → escribir SQL + su test en `supabase/tests/database/` → `pnpm db:reset && pnpm db:test`.

## 4. Definición de terminado (por paso)

1. `pnpm check` pasa en local y el CI está en verde.
2. Las reglas de la sección 1 se cumplen; las nuevas tablas tienen RLS + tests negativos.
3. No hay secretos, binarios ni literales de municipio.
4. `docs/progress/CHECKPOINT.md` actualizado: qué se hizo, cómo verificarlo y el siguiente paso exacto.
5. Si cambia una decisión de arquitectura, se registra como ADR nuevo (no se reescriben los anteriores).
