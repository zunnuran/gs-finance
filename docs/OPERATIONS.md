# Operations

## Provisioning and upgrades

Keep the database and uploads on persistent storage. On startup the application applies pending SQL migrations under a PostgreSQL advisory lock; migration statements and their completion record share a transaction. The session table is initialized by the PostgreSQL session-store adapter.

Before an upgrade, create a restorable backup of both PostgreSQL and attachments. Build and test the new release, then run `docker compose up -d --build`. Check application logs, sign in, inspect a known ledger balance, and verify an attachment download. A schema rollback is not automatic; use the matching application release and full backup when restoration is required.

## Back up a consistent snapshot

The following commands target the supplied Docker Compose services. They create the archive inside the database container before copying it, avoiding binary redirection problems in Windows PowerShell. Choose a new timestamped backup directory for each backup.

```powershell
New-Item -ItemType Directory -Path backups/2026-10-21 -Force
docker compose stop app
docker compose exec -T db pg_dump -U gss -d gss_finance -Fc -f /tmp/gss-finance.dump
docker compose cp db:/tmp/gss-finance.dump backups/2026-10-21/database.dump
docker compose cp app:/app/uploads backups/2026-10-21/uploads
docker compose start app
```

Stopping the app prevents financial writes and uploads during the snapshot. Confirm all commands completed successfully before considering the backup complete. Also retain the application version, migration files, deployment configuration, and necessary secrets in an encrypted backup system. The database contains users and financial data; attachment backups contain receipts and invoices. Restrict backup access and copy backups to separate storage.

For a non-Docker deployment, stop the app, run `pg_dump -Fc` against `DATABASE_URL`, copy the configured `UPLOAD_DIR`, then restart the app. Use the PostgreSQL client's file-output option rather than piping a binary archive through PowerShell.

## Restore into a clean deployment

Restore into a new environment first. Never overwrite an active database as a routine restore test.

1. Use the application version and migration files corresponding to the backup.
2. Start only PostgreSQL: `docker compose up -d db`.
3. Copy the archive into the database container and restore it into the empty database:

```powershell
docker compose cp backups/2026-10-21/database.dump db:/tmp/gss-finance.dump
docker compose exec -T db pg_restore -U gss -d gss_finance --no-owner --exit-on-error /tmp/gss-finance.dump
docker compose create app
docker compose cp backups/2026-10-21/uploads/. app:/app/uploads
```

4. Ensure restored uploads are readable and writable by the app's `node` user (UID 1000 in the supplied image). On a new volume, this one-time maintenance command restores ownership:

```powershell
docker compose run --rm --no-deps --user root app chown -R node:node /app/uploads
docker compose up -d
```

5. Verify user sign-in, company membership, trial-balance equality, outstanding receivables/payables, Pending and Posted records, recent journals, and several attachment downloads. Compare any historical asset and advance ledger balances with the backup records. Record the restore test result.

## Application configuration

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | Dedicated PostgreSQL connection URL; Compose constructs this internally. |
| `SESSION_SECRET` | Random signing secret, at least 32 characters. Rotating it signs users out. |
| `ADMIN_PASSWORD` | Initial password, at least 12 characters; used only for an empty user table. |
| `PORT` | HTTP listener; defaults to 5000. |
| `HOST` | Listener address; use `127.0.0.1` for PM2 behind a local reverse proxy. Defaults to `0.0.0.0` for container networking. |
| `NODE_ENV` | `development` runs Vite; `production` serves built static files and uses Secure cookies. |
| `TRUST_PROXY` | Set to `1` only behind the trusted single proxy in this deployment. |
| `UPLOAD_DIR` | Private attachment directory; defaults to `./uploads`. |
| `POSTGRES_PASSWORD` | PostgreSQL password used by Docker Compose. |
| `APP_DOMAIN` | HTTPS hostname used by Caddy. |

## Routine checks

The sole super administrator is `admin`, email `gamestrixstudios@gmail.com`. Its identity is fixed; change its password through **Change password**. Startup preserves existing passwords. Additional staff use configurable non-super-admin roles and permissions.

For PM2 installation, startup, backups, and upgrades, see [PM2 deployment](PM2.md). Production refuses databases containing the demo-seed marker. Use a clean dedicated database when first publishing; do not delete ledger history to prepare a release.

Monitor container restart counts, available disk space, PostgreSQL backup success, and application errors. Confirm that new transactions are posting and that the date lock reflects the company's closed periods. Test restoration periodically; a successful archive creation alone does not verify recoverability. This repository does not configure an external monitoring or backup scheduler.
