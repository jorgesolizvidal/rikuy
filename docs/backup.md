# Respaldo y restauración

Runbook del respaldo diario y del ensayo semanal ([ADR-046](adr/ADR-046-backup-restore.md)). Para quien opera la plataforma: cómo activarlo, cómo saber que funciona, cómo abrir un respaldo y cómo restaurar de verdad.

## Qué se guarda y qué no

| Se guarda                                                                             | No se guarda (y se repone a mano, abajo)                                                |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Toda la base: municipios, contenido, tours, medios, conocimiento, métricas, auditoría | Los secretos de Vault (`rikuy_job_runner_url`, `rikuy_job_runner_secret`)               |
| Las cuentas (Auth), con sus factores de verificación en dos pasos                     | Las contraseñas de los roles `rikuy_worker` y `rikuy_ai`                                |
| Todos los archivos de `media-originals` y `media-public`, con su tipo y su caché      | La configuración de Auth (SMTP, plantilla, direcciones)                                 |
| El esquema y los roles (para comparar), y un manifiesto con filas y huellas           | Las variables de Vercel y de GitHub; el horario de `pg_cron` (lo crean las migraciones) |

- **Frecuencia:** un respaldo al día (02:41 de Bolivia). Se pierde, como mucho, un día de cambios (RPO de 24 h).
- **Dónde:** artefactos de GitHub Actions (workflow «Backup»), cifrados con age, por 90 días.
- **Ensayo:** cada domingo (05:17 de Bolivia), el workflow «Restore drill» restaura el más nuevo en una base nueva y lo comprueba.

## Activarlo (una vez)

1. **La clave del respaldo**, en tu computadora (no en un servidor):
   - Windows: `winget install --id FiloSottile.age` (o descarga `age` de su página de versiones en GitHub). macOS: `brew install age`. Linux: `sudo apt install age`.
   - `age-keygen -o rikuy-backup-key.txt`. Muestra la clave pública (`age1…`); el archivo tiene además la secreta (`AGE-SECRET-KEY-1…`).
   - **Guarda el archivo completo en tu gestor de contraseñas.** Sin la clave secreta, ningún respaldo se puede abrir; si solo está en GitHub y pierdes GitHub, pierdes los respaldos y la clave a la vez.
2. **GitHub** → Settings → Secrets and variables → Actions:
   - _Variable_ `BACKUP_AGE_RECIPIENT` = la clave **pública** (`age1…`). El respaldo solo la necesita a ella: no puede abrir lo que guarda.
   - _Secret_ `BACKUP_AGE_IDENTITY` = la línea `AGE-SECRET-KEY-1…`. Solo la usa el ensayo.
   - _Secret_ `SUPABASE_SECRET_KEY` = la _secret key_ del proyecto (la misma que tiene Vercel), para leer todos los archivos.
   - Ya existen: `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD` y `SUPABASE_PROJECT_REF`.
3. **Primer respaldo:** Actions → «Backup» → _Run workflow_. Al terminar, su resumen dice cuántas tablas, filas y archivos guardó, y el nombre del archivo cifrado.
4. **Primer ensayo:** Actions → «Restore drill» → _Run workflow_. Su resumen dice qué respaldo usó y la tabla de comprobaciones.

## Saber que funciona

- «Backup» en verde cada día y «Restore drill» en verde cada domingo. Si uno falla, GitHub te escribe.
- El ensayo también falla si el respaldo más nuevo tiene más de 48 h: el respaldo diario dejó de correr.
- Sus resúmenes muestran **solo cantidades**: nunca nombres, correos ni contenido (el repositorio es público).
- Los tiempos de «Restaurar la base» y «Restaurar los archivos» del ensayo son la medida del tiempo de restauración.

| Ensayo | Respaldo | Base | Archivos | Comprobaciones |
| ------ | -------- | ---- | -------- | -------------- |
| —      | —        | —    | —        | —              |

(Se anotan aquí las primeras corridas.)

**Si el ensayo falla:**

- «No backup to restore» o «… h old»: «Backup» no corrió. Mira su última corrida.
- «X filas en el respaldo, Y restauradas» o «No se pudo cargar la base»: una migración cambió algo que el volcado no carga (por ejemplo, una columna que ya no existe). El CI de cada PR corre la misma restauración, así que suele aparecer antes.
- «N archivos no volvieron iguales» o «La base registra N archivos y el respaldo trae M»: un archivo se subió o se borró mientras corría el respaldo, o Storage rechazó uno al subirlo. El del día siguiente suele estar bien; si se repite, revisa «Métricas por municipio» → integridad.

## Abrir un respaldo

1. Actions → «Backup» → la corrida del día → _Artifacts_ → descarga `rikuy-backup-<fecha>` (un `.zip` con el archivo `.age` dentro).
2. En una carpeta privada, con la clave de tu gestor de contraseñas en `rikuy-backup-key.txt`:

   ```bash
   unzip rikuy-backup-<fecha>.zip
   mkdir respaldo
   age -d -i rikuy-backup-key.txt rikuy-backup-<fecha>.tar.gz.age | tar -xzf - -C respaldo
   ```

3. Dentro: `manifest.json` (filas por tabla, archivos con su huella), `db/roles.sql`, `db/schema.sql`, `db/data.sql` y `storage/<bucket>/…`. Tiene datos personales (correos de las cuentas): bórralo al terminar.

## Restaurar de verdad

Hace falta: Node 24, pnpm, el repositorio, `psql` y `age`. Se hace desde tu computadora, no desde el panel.

**Antes de restaurar sobre producción:** para recuperar algo borrado por error (un destino, un tour), no se restaura todo. Se restaura en una pila local (`pnpm db:start` y los pasos 3 a 5 con su dirección) y se vuelve a cargar a mano lo que falta desde el panel. La restauración completa **reemplaza** todas las tablas.

1. **El proyecto.** Si el proyecto de Supabase se perdió, crea uno nuevo (São Paulo, plan gratuito). Configura Auth como en [despliegue](deploy.md#supabase-proyecto-rikuy), cambia `SUPABASE_PROJECT_REF` y `SUPABASE_DB_PASSWORD` en GitHub, y corre «Deploy database» **sin** el seed: crea las tablas, los buckets y el horario con las migraciones del repositorio.
2. **Abre el respaldo** (arriba) en una carpeta, por ejemplo `respaldo/`.
3. **La base.** Con la cadena de conexión del proyecto (Supabase → Connect → _Session pooler_):

   ```bash
   bash packages/db/scripts/backup-restore-db.sh respaldo "postgresql://postgres.<ref>:<contraseña>@<host>:5432/postgres"
   ```

   En una transacción vacía cada tabla del respaldo y carga sus filas; si algo falla, no cambia nada.

4. **Los archivos:**

   ```bash
   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SECRET_KEY=<secret key> \
     node packages/db/scripts/backup.mjs restore-storage respaldo
   ```

5. **Comprobar** (lo mismo que el ensayo):

   ```bash
   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SECRET_KEY=<secret key> \
   SUPABASE_PUBLISHABLE_KEY=<publishable key> SUPABASE_DB_URL="<la cadena del paso 3>" \
     node packages/db/scripts/backup.mjs verify respaldo
   ```

6. **Lo que no estaba en el respaldo:**
   - Vault y el rol del ejecutor: [runbook de trabajos](jobs.md), «Activación».
   - El rol de la IA: [«Activar la IA»](deploy.md#activar-la-ia-groq).
   - SMTP de Auth: [«Correo con SMTP gratuito»](deploy.md#correo-con-smtp-gratuito-gmail).
   - En Vercel, si el proyecto es nuevo: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `WORKER_DATABASE_URL`, `AI_DATABASE_URL`. Después, un _redeploy_ sin caché.
   - En GitHub: `SUPABASE_SECRET_KEY` del proyecto nuevo.
7. **Volver a usarlo:**
   - Entra al panel. Las sesiones anteriores no sirven en un proyecto nuevo, así que hay que entrar otra vez con el código. Los factores de verificación en dos pasos vuelven con las cuentas.
   - Corre «Daily health» y «Backup» a mano.
   - Anota qué pasó, cuánto tardó y qué faltó, al pie de este documento.

## Limitaciones

- Los respaldos viven en GitHub: perder la cuenta de GitHub es perderlos. La clave secreta, en cambio, se guarda fuera.
- No hay restauración de un solo municipio: se restaura en una pila aparte y se copian sus datos a mano.
- 90 días como máximo. Para guardar uno más tiempo, descárgalo.
