# Rikuy

**Plataforma SaaS multi-tenant de turismo inmersivo para municipios.**
Cada municipio tiene su propio portal —con su marca, dominio y contenidos— con tours virtuales 360°, modelos 3D, mapa interactivo y una guía con IA, administrado desde un panel central.

> _Rikuy_ significa «ver, mirar» en quechua.

![CI](https://github.com/jorgesolizvidal/rikuy/actions/workflows/ci.yml/badge.svg)

**Estado:** en desarrollo — fase P1 (fundación). Ver [roadmap](docs/roadmap.md) y [checkpoint](docs/progress/CHECKPOINT.md).

## Características (objetivo del piloto)

- **Multi-tenant de verdad:** un solo build sirve a todos los municipios; dar de alta uno nuevo no requiere cambiar código. Aislamiento con Row Level Security en PostgreSQL.
- **White-label:** identidad, colores, contactos, SEO y PWA configurables por municipio, versionados y validados (contraste, accesibilidad).
- **Tours 360° y 3D con carga profesional:** preview inmediato, entrega según resolución (imagen única o tiles), modelos GLB optimizados que se cargan solo al abrirlos.
- **Publicación editorial:** borrador → revisión sellada → publicación → rollback, con auditoría.
- **IA con fuentes:** guía turística y asistente de administración que citan sus fuentes, se abstienen cuando no hay evidencia y nunca deciden permisos.
- **Rendimiento como contrato:** presupuestos de LCP/INP/CLS y de peso de JavaScript verificados en CI.

## Stack

Next.js 16 · React 19 · TypeScript · Supabase (PostgreSQL, Auth, Storage) · Photo Sphere Viewer · Vercel · pnpm monorepo · Vitest · GitHub Actions.

## Documentación

| Documento                                                | Contenido                                                     |
| -------------------------------------------------------- | ------------------------------------------------------------- |
| [Arquitectura](docs/architecture.md)                     | Vista general, tenancy, datos, medios, IA y ambientes         |
| [ADRs](docs/adr/README.md)                               | Decisiones de arquitectura y su estado                        |
| [Roadmap](docs/roadmap.md)                               | Fases, pasos y criterios de terminado                         |
| [Presupuesto de rendimiento](docs/performance-budget.md) | Objetivos medibles de carga                                   |
| [Cierre P0](docs/p0-closure.md)                          | Decisiones tomadas a partir de benchmarks reales              |
| [Guía de ingeniería](CONTRIBUTING.md)                    | Reglas no negociables, convenciones y definición de terminado |

## Desarrollo local

Requisitos: Node 24, pnpm 12 y Docker Desktop (para Supabase local, desde P1 · Paso 2).

```bash
pnpm install
cp .env.example apps/web/.env.local   # completar según los comentarios
pnpm dev                              # http://localhost:3000
pnpm check                            # lo mismo que corre el CI
```

---

## English summary

**Rikuy** is a multi-tenant SaaS platform for immersive municipal tourism: each municipality gets its own branded portal with 360° virtual tours, 3D models, an interactive map and an AI guide that cites its sources, all served from a single build and managed from a central admin. Built with Next.js, TypeScript and Supabase (Postgres RLS for tenant isolation), with performance budgets enforced in CI. Currently in active development — see the [roadmap](docs/roadmap.md).

---

© 2026 Jorge Bryan Soliz Vidal. Todos los derechos reservados. El código es visible con fines de portafolio; no se concede licencia de uso, copia ni distribución.
