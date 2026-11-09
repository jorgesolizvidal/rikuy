# ADR-046 — Respaldo diario cifrado de la base y los archivos, con un ensayo de restauración semanal automático

- **Estado:** Aceptada — 2026-11-08
- **Concreta:** criterio 10 del gate P6 («backup/recovery probado», auditoría 14) y la auditoría 02 («los respaldos incluyen base de datos y objetos; no asumir que el respaldo de PostgreSQL contiene los binarios de Storage; ensayar la restauración aislada»)

## Contexto

- El proyecto de Supabase está en el plan gratuito, que **no tiene respaldos diarios** en el panel (solo Pro, Team y Enterprise). La guía de Supabase recomienda exportar con `supabase db dump` y guardar la copia en otro lugar.
- Un respaldo de PostgreSQL guarda solo los **datos** de los archivos (`storage.objects`), no los archivos. Los originales de panoramas, modelos y fotos no se pueden regenerar.
- Al 8 de noviembre: base de 29 MB y Storage de 57 MB (50 MB de originales, 232 archivos).
- El repositorio es **público**: los registros y los artefactos de Actions los puede ver cualquiera con una cuenta de GitHub.
- No hay presupuesto para otro servicio: solo planes gratuitos hasta tener contrato (Hito).

## Decisión

Decisiones del usuario (2026-11-08):

1. **Qué:** la base completa (con las cuentas) **y** todos los archivos de Storage.
2. **Dónde:** artefactos de GitHub Actions, **cifrados**, guardados 90 días.
3. **Cada cuánto:** a diario.
4. **Ensayo:** automático cada semana, restaurando el último respaldo en una base nueva y comprobándolo.

### El respaldo (`.github/workflows/backup.yml`, 06:41 UTC)

- `supabase db dump --linked`, en tres archivos:
  - roles (sin contraseñas);
  - esquema;
  - datos con `COPY`. Deja fuera solo el horario de `pg_cron` y el registro de `pg_net`, que crean las migraciones. Tampoco entran los esquemas que Supabase excluye siempre, entre ellos **Vault**.
- `packages/db/scripts/backup.mjs download` recorre los dos buckets con la clave secreta y guarda cada archivo con su tipo, su `Cache-Control`, su tamaño y su huella SHA-256.
- `manifest.json` reúne las filas de cada tabla (contadas en el volcado), los archivos, la fecha y el commit.
- Todo va en un `tar.gz` cifrado con **age** para la **clave pública** del respaldo (`BACKUP_AGE_RECIPIENT`). El job no puede descifrarlo: si alguien leyera ese job, no tendría con qué abrir los respaldos.
- El workflow comprueba que el archivo empieza con la cabecera de age antes de subirlo. Se sube como artefacto `rikuy-backup-<fecha>`, sin volver a comprimir y por 90 días. Los registros muestran **solo cantidades**.

### El ensayo (`.github/workflows/restore-drill.yml`, domingos 09:17 UTC)

1. Busca el respaldo más nuevo. Si tiene más de 48 h, falla: el respaldo diario dejó de correr.
2. Lo descarga y lo descifra con la **clave secreta** (`BACKUP_AGE_IDENTITY`).
3. Levanta una pila nueva de Supabase en el runner. Antes, `supabase link` copia las versiones de los servicios de producción, para que el ensayo use las mismas.
4. Pausa el horario de esa copia.
5. Restaura (`backup-restore-db.sh`): en **una transacción**, sin triggers ni comprobación de claves foráneas (como espera el volcado), vacía cada tabla del respaldo y carga sus filas. Las filas que crearon las migraciones se reemplazan por las del respaldo.
6. Sube los archivos con su tipo y su caché.
7. Comprueba (`backup.mjs verify`):
   - **cada tabla** tiene las filas del respaldo;
   - **cada archivo** vuelve byte por byte (SHA-256) y la base registra exactamente esos archivos;
   - un archivo público responde sin clave;
   - **cada portal en línea** se resuelve por su dirección y lista sus destinos, por la misma API anónima que usa el portal;
   - Auth lee todas las cuentas.
8. Anota en el resumen los tiempos de restauración de la base y de los archivos (la medida del RTO).

Si algo falla, el workflow falla y GitHub le escribe al dueño. Producción solo se lee para conocer sus versiones; nunca se escribe en ella.

### En cada PR

El job de integración del CI corre **los mismos scripts** sobre su propia pila, con los datos de las pruebas:

1. respalda y cifra con una clave de un solo uso;
2. vacía Storage y comprueba que no quedó ningún archivo, para que la restauración no pueda «aprobar» con archivos viejos;
3. vuelve la base a las migraciones;
4. restaura y verifica.

Así, un cambio de esquema que rompa la restauración se ve en el PR, no el domingo.

### Lo que no hay en el respaldo, y el runbook lo repone

- los secretos de **Vault** (`rikuy_job_runner_url`, `rikuy_job_runner_secret`);
- las contraseñas de los roles `rikuy_worker` y `rikuy_ai`;
- la configuración de Auth (SMTP, plantillas, direcciones);
- las variables de Vercel y de GitHub.

[`docs/backup.md`](../backup.md) lista sus **nombres** y cómo volver a ponerlos. Los valores nunca entran en el respaldo ni en el repositorio.

## Alternativas consideradas

| Opción                                           | Por qué no                                                                                                     |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Supabase Pro (respaldos diarios, PITR)           | De pago; tampoco guarda los archivos de Storage                                                                |
| Cloudflare R2 o Google Drive                     | Fuera de GitHub, pero piden otra cuenta, tarjeta o una cuenta de servicio; decisión del usuario: artefactos    |
| Solo la base                                     | Si se pierde Storage, los originales de panoramas y modelos no se pueden regenerar                             |
| `supabase storage cp -r`                         | No guarda el tipo ni la caché de cada archivo, y su orden de carpetas no está documentado; el script propio sí |
| Restaurar con `schema.sql` en vez de migraciones | Las migraciones son la fuente de verdad y es lo que corre una base nueva; `schema.sql` queda para comparar     |
| Contraseña simétrica (`gpg`, `openssl`)          | Con age, el job del respaldo solo tiene la clave pública y no puede leer lo que guarda                         |
| Ensayo en cada respaldo                          | ~10 min de Actions por día; el semanal basta para detectar que dejó de servir, y el PR prueba cada cambio      |

## Consecuencias

- (+) **RPO de 24 h** (un respaldo por día). El **RTO** se mide en cada ensayo: el tiempo de restaurar la base y los archivos queda en su resumen, más el alta de un proyecto nuevo y los pasos del runbook.
- (+) La restauración está probada **cada semana con datos reales** y en **cada PR** con los de prueba.
- (+) Sin costo: los artefactos de un repositorio público y los minutos de Actions son gratis.
- (−) **Los respaldos viven en GitHub.** Si se pierde la cuenta de GitHub, se pierden también. La clave secreta del respaldo debe guardarse además fuera de GitHub (gestor de contraseñas): sin ella, ningún respaldo se puede abrir.
- (−) 90 días de retención como máximo (el límite de GitHub). Para guardar uno más tiempo, se descarga a mano.
- (−) **La clave secreta de Supabase** está también en los secretos de GitHub, para leer todos los archivos. Solo la usa `backup.mjs`, en el job del respaldo.
- (−) La restauración es **de todo el proyecto**. Restaurar **un solo municipio** (lo propone la auditoría 02) no está automatizado: se restaura en una pila aparte y se copian sus filas a mano. Queda en «Pendientes registrados».
- (−) Un respaldo es una foto: un archivo subido entre el volcado de la base y la copia de los archivos puede aparecer en uno y no en el otro. El manifiesto lo avisa, y el ensayo falla si no coinciden.
- (−) GitHub pausa los workflows programados tras 60 días sin commits: «Daily health», «Backup» y «Restore drill» se reactivan juntos desde Actions.
