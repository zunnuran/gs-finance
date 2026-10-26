# Publish GSS Finance with PM2

The production application starts without sample companies, users, or transactions. Its only super administrator is **admin**, with email **gamestrixstudios@gmail.com**. Set the initial password privately in `ADMIN_PASSWORD`. An existing administrator's password is preserved on restart; changing that environment variable does not reset it.

Use a **new, dedicated production database**. Do not upload the development database or run the optional development demo seed. Production startup rejects a database carrying the application's demo-seed marker. Normal chart-of-account and category templates are created only when you create a real company; they are configuration, not financial transactions.

## 1. Build a release on your development machine

Requirements: Node.js 22 or later, npm, and PostgreSQL 17 or later on the deployment server. The release uses a single PM2 application process and PostgreSQL-backed sessions.

From the source checkout:

```powershell
npm ci --include=dev
npm run check
npm test
npm run build
npm run release
```

The last command prints a new directory under `releases/`. It contains the compiled application, SQL migrations, production configuration template, dependency manifests, and deployment instructions. It excludes `.env`, database contents, uploaded files, the demo-seed script, screenshots, and tests. Each run creates a separate directory and never overwrites an earlier release.

Copy the **contents of that release directory** to a stable server directory, for example `/opt/gss-finance/app` on Linux or `C:\Apps\GSS-Finance` on Windows. Do not copy the entire source checkout or the development `node_modules` directory. The production server does not need TypeScript or Vite to run the compiled release.

If you deploy a Git clone directly on the server instead, run `npm ci --include=dev` and `npm run build` there before starting PM2. The Git repository excludes generated `dist/` files. A prebuilt release already contains those files and skips the build step.

If the build reports **`'vite' is not recognized`** on Windows, or **`vite: not found`** on Linux, the local build tools are missing. From the source directory containing `package.json`, run:

```powershell
npm ci --include=dev
npm run build
```

Build tools are development dependencies. npm may omit them when installed with `--omit=dev`, `--production`, or a shell-level `NODE_ENV=production`. Explicit `--include=dev` installs them even with production omission configured, as documented in [npm's installation options](https://docs.npmjs.com/cli/v10/commands/npm-ci/#include). This does not require changing the application's production configuration or installing Vite globally. Database migrations do not install build tools and do not need to be rerun for this error.

## 2. Provision the database and environment

Create a database and a dedicated login using your PostgreSQL administrator account. For example, in `psql`:

```sql
CREATE ROLE gss_finance_app LOGIN;
\password gss_finance_app
CREATE DATABASE gss_finance_production OWNER gss_finance_app;
```

The `\password` command prompts privately for the database password. The application role needs access to its own database and permission to apply schema migrations. Do not grant access to unrelated databases.

In the prebuilt release directory, install runtime dependencies and copy the template. If you are building from a Git clone, use `npm ci --include=dev` instead:

```powershell
npm ci --omit=dev
```

Linux:

```sh
cp .env.production.example .env
chmod 600 .env
```

Windows PowerShell:

```powershell
Copy-Item .env.production.example .env
```

Edit `.env` and replace every placeholder:

| Setting | Production value |
| --- | --- |
| `DATABASE_URL` | Connection URL for the new production database. URL-encode special characters in the database password. |
| `SESSION_SECRET` | An independent cryptographically random secret of at least 32 characters. |
| `ADMIN_PASSWORD` | A unique, strong initial administrator password of at least 12 characters. |
| `NODE_ENV` | `production`. The PM2 configuration also enforces this value. |
| `HOST` | `127.0.0.1` when the HTTPS proxy is on the same server. |
| `PORT` | `5000`, or a free local port. Match the reverse-proxy target. |
| `TRUST_PROXY` | `1` for the trusted single reverse proxy below. |
| `UPLOAD_DIR` | An absolute persistent path outside the application release directory. |

Generate a session secret locally with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`, and place the output in `.env`. Generate and store the initial password with your password manager. Never reuse the session secret as the password.

Create the upload directory and grant the deployment account read/write access. On Linux, the example is `/var/lib/gss-finance/uploads`; on Windows, use a value such as `C:/ProgramData/GSS-Finance/uploads`. Restrict `.env`, uploads, backups, and the PM2 account's files to authorized administrators. Run the application as a dedicated unprivileged account.

## 3. Put HTTPS in front of the application

Set your public hostname's DNS record to the server. A reverse proxy on the same machine should forward to the application's loopback port. For example, a **host-installed Caddy** configuration:

```caddyfile
finance.your-domain.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:5000
}
```

Replace the hostname with your own and make ports 80 and 443 reachable for the HTTPS proxy. The repository's other `Caddyfile` targets a Docker service; use the loopback target above for PM2. If using Nginx or another proxy, forward the original host and `X-Forwarded-Proto: https` and maintain the same single-proxy trust boundary.

Production sign-in requires HTTPS because session cookies are `Secure`, `HttpOnly`, and `SameSite=Lax`. Do not expose port 5000 directly to the public internet or disable secure cookies to work around a proxy configuration issue.

### Cloudflare Tunnel

When `cloudflared` runs on the same machine as the app, route the public hostname to `http://127.0.0.1:5000` (or your configured `PORT`). In the application's `.env`, set:

```dotenv
NODE_ENV=production
HOST=127.0.0.1
TRUST_PROXY=1
```

Use the public **HTTPS** URL in the browser. Cloudflare supplies `X-Forwarded-Proto` to identify the visitor's protocol; Express must trust the local proxy to recognize HTTPS and send its Secure session cookie. See [Cloudflare request headers](https://developers.cloudflare.com/fundamentals/reference/http-request-headers/#x-forwarded-proto) and [Express session proxy configuration](https://expressjs.com/en/resources/middleware/session/#cookiesecure).

If login returns to the sign-in screen or reports **Please sign in**, check that `TRUST_PROXY` is `1`, then run `npm run pm2:restart`. This reloads the configuration; no migration or password reset is needed. If PM2 was initially started from a shell exporting `TRUST_PROXY=0`, explicitly update that retained process value too. In PowerShell, run `$env:TRUST_PROXY = '1'` before `npm run pm2:restart`; in Command Prompt, run `set TRUST_PROXY=1` before restarting. Keep the same value in `.env` for future starts.

Keep the origin port private. If the tunnel runs in a different container or machine, restrict the app's listener/firewall to that connector instead of exposing the port publicly. Preserve `X-Forwarded-Proto` through any additional proxy. The API sends `Cache-Control: private, no-store`; make sure any custom Cloudflare cache rule bypasses `/api/*`.

The app now rejects production login when it cannot recognize HTTPS, with **Secure sign-in is unavailable**, rather than reporting success without setting a session cookie. A cookie blocked or lost after login is also shown explicitly.

## 4. Start and verify

From the deployment directory, using the deployment account:

```powershell
npm run pm2:start
npm run pm2:status
npm run pm2:logs
```

PM2 is a local runtime dependency; no global installation is required. Press Ctrl+C to leave the log viewer; the application continues running. The configuration starts one process, waits for the application's readiness message, disables file watching, and allows up to 15 seconds for shutdown.

Open `https://finance.your-domain.com/health`, then sign in as **admin** using your initial password. The application applies migrations and creates the administrator automatically. Confirm that there are no companies or transactions, then create your real company and configure its accounts and users. No email is sent as part of administrator provisioning; sign in using the username or email and password.

Useful commands:

```powershell
npm run pm2:restart
npm run pm2:stop
npm run pm2:status
npm run pm2:logs
```

Restart after changing `.env`. PM2 can retain explicitly exported environment variables from its process environment; keep application configuration in `.env` and remove conflicting shell/service variables. Secrets are deliberately absent from `ecosystem.config.cjs`.

## 5. Restore the process after a server reboot

On Linux, run these commands as the deployment account:

```sh
npx --no-install pm2 startup
# Execute the privileged installation command printed by PM2.
npx --no-install pm2 save
```

The startup command detects the platform's init system and prints the service-installation command. `pm2 save` saves the current process list for restoration. Run PM2 under the same account consistently, and save again after intentionally changing the managed application list. Regenerate the startup integration after changing the Node.js installation path. See the [official PM2 startup guide](https://pm2.keymetrics.io/docs/usage/startup/).

On native Windows, `pm2 startup` does not install a Windows boot service. Save the process list with `npx --no-install pm2 save`, then configure Task Scheduler under the **same deployment account** to run PM2's `resurrect` command at startup. Use full paths to `node.exe` and `node_modules/pm2/bin/pm2`, set the working directory to the deployment directory, and configure the task to run whether the account is logged on or not. Keep the same `PM2_HOME` if you set a custom value. Test a reboot before relying on automatic startup. An administrator must configure the account credentials and startup permissions on that server.

## 6. Upgrade and back up

Before every upgrade, stop `gss-finance`, back up PostgreSQL and the persistent upload directory, and retain the matching release. Follow the [backup and restore procedures](OPERATIONS.md); for this deployment, use the non-Docker instructions.

Copy the new release's files into the stable deployment directory while preserving the server's `.env` and external uploads. Then run:

```powershell
npm ci --omit=dev
npm run pm2:restart
npm run pm2:status
```

Verify health, sign-in, a known transaction, ledger balances, and an attachment download. Schema rollback is not automatic; restoring an earlier application may also require restoring its matching database backup. Never rerun the demo seed on production.

PM2 manages this application process; arrange PostgreSQL service startup, HTTPS proxy startup, backups, log retention, disk monitoring, and monitoring of restart failures on the server. The complete process-file options are documented in the [official PM2 ecosystem guide](https://pm2.keymetrics.io/docs/usage/application-declaration/).

## Verified release

This release was checked with 44 accounting and source API tests, 26 compiled-production API and safeguard tests, and an actual PM2 start/restart/stop cycle on Windows. The PM2 check used the generated release with only runtime dependencies installed and verified the empty database, sole administrator, email sign-in, Secure session cookie, static assets, and graceful shutdown. The runtime dependency audit reported no known vulnerabilities at packaging time.

These checks used isolated test schemas. DNS, HTTPS certificates, and reboot integration must be configured and checked on the destination server.
