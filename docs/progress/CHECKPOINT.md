# Checkpoint

> Archivo de continuidad. Se actualiza al final de cada paso. Cualquier sesión de trabajo empieza leyendo esto.

## Estado actual

- **Fase:** P1 — Fundación
- **Último paso completado:** P1 · Paso 1 — base del repositorio (2026-10-17)
- **Rama principal:** `main`

## Paso 1 — qué quedó hecho

- Monorepo pnpm: `apps/web` (Next.js 16, App Router, placeholder), `apps/worker` (esqueleto), `packages/core` (framework-free, regla ESLint que lo garantiza), `packages/db`, `packages/ui`, `packages/config` (contrato de variables de entorno con Zod + 5 tests).
- TypeScript strict compartido (`tsconfig.base.json`), ESLint flat config compartido (`eslint.base.mjs`), Prettier, EditorConfig, `.gitattributes` (LF).
- CI en GitHub Actions: format, lint, typecheck, test, build y escaneo de secretos con gitleaks.
- `.env.example` documentado; `.gitignore` excluye `.env*`, `seed-assets/` y builds.
- Documentación: `CONTRIBUTING.md`, `docs/architecture.md`, ADRs (índice 001–018, nuevas 019 y 020), `docs/roadmap.md`, `docs/performance-budget.md`, `docs/p0-closure.md`.

Versiones fijadas: Node 24 (`.nvmrc`), pnpm 12.14.0, Next.js 16.4.2, React 19.3.1, TypeScript 6.0.3, ESLint 10.12.0, Vitest 5.0.5, Zod 4.6.7.

## Cómo verificarlo

```bash
pnpm install
pnpm check   # format + lint + typecheck + test + build
pnpm dev     # http://localhost:3000 muestra el placeholder de Rikuy
```

## Siguiente paso — P1 · Paso 2 (requiere autorización)

Rama `feat/p1-step2-supabase-local`:

1. `supabase init` en la raíz; scripts `db:start`, `db:stop`, `db:reset`, `db:test`, `db:types`.
2. Migración P1: `tenants`, `tenant_domains`, `memberships`, `tenant_config_versions`, `audit_events` según `docs/architecture.md` §6 (FK compuestas, constraints, índices, RLS, grants mínimos, helpers definer acotados).
3. Tests pgTAP: anon, owner/admin/editor/analyst de A, miembro de A y B, miembro revocado, intento de cambiar `tenant_id`, último owner.
4. Seed sintético mínimo (dos tenants ficticios) sin datos reales.
5. Job de CI con Supabase CLI para correr los tests de base de datos.

Prerrequisitos del usuario: Docker Desktop abierto. Después de `pnpm db:start`, copiar la URL y las claves locales que imprime la CLI a `apps/web/.env.local` siguiendo `.env.example`.

## Decisiones pendientes del usuario

- Ninguna bloqueante para el Paso 2.
