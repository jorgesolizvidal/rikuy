# Instrucciones para asistentes de código

Antes de cualquier tarea en este repositorio:

1. Lee `CONTRIBUTING.md` (reglas no negociables de arquitectura, tenancy, seguridad y rendimiento).
2. Lee `docs/progress/CHECKPOINT.md` y continúa exactamente desde el "Siguiente paso".
3. Respeta `docs/roadmap.md`: trabaja solo en el paso autorizado; un paso = una rama = un PR.
4. Al terminar un paso, actualiza el checkpoint antes del commit final.
5. Commits: autor único Jorge Bryan Soliz Vidal, sin firma automática del entorno y **sin** trailers `Co-Authored-By` ni `Claude-Session`. Descripciones de PR sin firmas de herramientas.

## Entorno de trabajo

- **Dónde se trabaja:** el asistente trabaja en un contenedor en la nube con una copia del repositorio. La computadora del usuario solo se usa, en solo lectura, para consultar carpetas de material cuando hace falta.
- **Base local:** la base local con Docker (`pnpm db:start`) puede no levantar en ese contenedor. En ese caso, pgTAP, integración y e2e se prueban en el CI del PR, que es la prueba que vale para el merge.
- **GitHub:** el asistente crea la rama, hace los commits a nombre del usuario, el push y la revisión del CI. El merge lo hace el usuario.
- **Supabase de producción:** solo consultas de lectura. Las escrituras y los cambios de datos los hace el usuario desde el panel.
- **Vercel:** solo lectura. Despliega con el merge.
- **Después del merge:** el workflow «Deploy database» aplica las migraciones en producción.

@../CONTRIBUTING.md
@../docs/progress/CHECKPOINT.md
