# GSS Finance

An independent finance application for a game development / IT company. React and TypeScript provide business-oriented forms; Express and PostgreSQL handle accounting, permissions, and audit history. The app uses its own database and does not connect to GS-HRIS.

Fresh installations contain only the administrator account, with no sample companies or financial transactions. For deployment, see the [PM2 guide](docs/PM2.md).

## Run locally

Requirements: Node.js 22+, npm, and PostgreSQL 17 or later. Docker is optional for local development.

Clone the repository:

```powershell
git clone git@github.com:zunnuran/gs-finance.git
cd gs-finance
```

1. Copy `.env.example` to `.env`.
2. Create an empty database and set `DATABASE_URL` to its connection string. Use a dedicated database; do not point this application at an existing HRIS database.
3. Set `SESSION_SECRET` to a random value of at least 32 characters. Set `ADMIN_PASSWORD` to a strong password of at least 12 characters for the sole super administrator, username `admin`, email `gamestrixstudios@gmail.com`.
4. Run:

```powershell
npm ci --include=dev
npm run dev
```

Open [http://localhost:5000](http://localhost:5000), sign in using `admin` or `gamestrixstudios@gmail.com`, and create the first company. The app applies versioned SQL migrations at startup and creates the administrator only when the users table is empty. Changing `ADMIN_PASSWORD` after the first startup does not change an existing user's password.

The initial company has a PKR base currency, a chart of accounts, and operating expense categories. Create bank/cash accounts, clients, vendors, cash custodians, and additional users before recording transactions.

Transactions use **Pending → Posted**. Saving a transaction creates a Pending record without changing balances; a user with `transactions.post` can post it directly, including their own transaction. There are no submission, approval, or rejection steps. Pending transactions can be edited or cancelled; posted transactions are corrected through reversal. Cancelled and Reversed remain available in transaction history.

Projects, Fixed Assets, People & Advances, and Reconciliation are no longer available as modules or new transaction workflows. Clients & Receivables, Vendors & Payables, Bank & Cash, reports, categories, chart of accounts, users, and audit history remain. Basic cash custodians are managed from Bank & Cash. Existing project, asset, and advance records are retained for historical accounting; integration with another app is not yet implemented.

## Upgrade to the simplified workflow

Back up PostgreSQL before upgrading, build the updated source, and restart the application. Migration `005_simple_transactions.sql` converts existing Draft, Submitted, Approved, and Rejected records to Pending and records the old states in the audit trail. It does not post those transactions or modify existing posted documents/journals. Submit and Approve permissions are removed; existing Post permissions and explicit overrides are preserved. If a former approver should now post transactions, an administrator must explicitly grant `transactions.post`. Removed-module pending records can be cancelled; their posted history can be reversed by authorized users.

## Restricted users and petty cash

Action permissions and data visibility are separate. In **Users & permissions**, edit a user and select **Data visibility → Own data only**. Grant their company access and link their employee/custodian record for each company. Cash accounts assigned to that custodian appear in **My cash**.

Own-data users can view their permitted transactions and the cash assigned to their linked custodian record. Finance-created funding records are read-only. They can save their own cash expenses and transfers as Pending; posting and reversal require the corresponding action permission and never expand data visibility.

Company income, bank balances, payroll/private accounts, other employees, customer records, company reports, assets, audit history, reconciliation, and administration are excluded from own-data access. Restricted requests are checked on the server, including guessed transaction/attachment IDs and pending records created before a user's scope changed. Basic vendor names remain available for entering expenses, without vendor contact, tax, or bank details. A restricted user's own assigned cash balance includes all movements in that cash account.

The standard **Employee expenses** account is private by default, covering seeded salary and bonus categories. Mark any custom payroll or sensitive account **Private financial account** in the chart of accounts; its transactions and categories will also be hidden. Posted account classifications are checked even if the category is later remapped.

**Inherit role** gives employees own-data visibility and other roles company visibility. **All assigned company data** grants company-wide reading within existing company memberships. Super administrators retain full access. An explicit own-data setting takes precedence over broad role/action permissions. Employee links are company-validated and can belong to only one login.

## Development commands

```powershell
npm run check
npm test
npm run build
npm run db:migrate
npm run db:seed-demo
```

The optional demo seed adds two separate fictional companies and 13 sample documents using the current workflows. It is atomic and safe to rerun without duplication. See [demo data and verified balances](docs/DEMO-DATA.md) for the sample date range, expected totals, and testing results.

`npm test` runs accounting tests with embedded PostgreSQL through PGlite. Optional HTTP integration tests require an explicit `TEST_DATABASE_URL` pointing to a dedicated real PostgreSQL test database; they skip when it is absent. Each HTTP test run creates and removes its own temporary schema, upload directory, and application process. The configured database user needs permission to create schemas. Never use a production database for tests.

```powershell
$env:TEST_DATABASE_URL = 'postgres://gss:password@localhost:5432/gss_finance_test'
npm test
```

The production build writes the browser app and server bundle to `dist/`. `npm start` starts that build; use `NODE_ENV=production` and HTTPS for production sessions. Production requires real PostgreSQL; PGlite is a test dependency only.

## Production with PM2

Run `npm ci --include=dev`, `npm run check`, and `npm run build`, then `npm run release` to create an uploadable production folder without demo scripts, sample documents, local credentials, or uploads. Follow [PM2 deployment](docs/PM2.md) to configure a fresh PostgreSQL database, HTTPS, a strong initial password, and `npm run pm2:start`.

When deploying directly from a Git clone, install build dependencies before building:

```powershell
npm ci --include=dev
npm run build
npm run pm2:start
```

Vite, esbuild, TypeScript, and tsx are development dependencies needed to build the source. If Windows reports `'vite' is not recognized`, run `npm ci --include=dev` from the folder containing `package.json`, then retry the build. `npm ci --omit=dev` is for an already-built release containing `dist/`; that release does not need a build step. Keep production `.env` settings and HTTPS configured before starting PM2.

A fresh deployment contains only the `admin` user (`gamestrixstudios@gmail.com`); it has no companies or transactions until you create them. Production refuses demo-seeded databases. Existing passwords are preserved during restarts and upgrades. Additional staff can have configurable roles and permissions, but the super-admin identity is fixed.

## Production with Docker

The included Compose setup runs PostgreSQL, the application, and Caddy as an HTTPS reverse proxy. Only the proxy publishes host ports. Database data, private attachments, and Caddy certificates have persistent volumes.

Add these values to `.env` alongside the session secret and initial administrator settings:

```dotenv
POSTGRES_PASSWORD=replace-with-a-long-random-alphanumeric-password
APP_DOMAIN=finance.example.com
```

Use a URL-safe alphanumeric `POSTGRES_PASSWORD` with this Compose template, because it is interpolated into a PostgreSQL connection URL. Set the domain's DNS record to this server and allow inbound ports 80 and 443, then run:

```powershell
docker compose up -d --build
docker compose logs --tail=100 app
```

Caddy obtains HTTPS certificates for a reachable public domain. The default `APP_DOMAIN=localhost` uses a local certificate authority; a local test browser must trust its root certificate. For straightforward local development use `npm run dev` over HTTP instead.

Production session cookies are `Secure`, `HttpOnly`, and `SameSite=Lax`. HTTPS is required for sign-in to persist. `TRUST_PROXY=1` is appropriate for the supplied single-proxy setup; do not expose the application's port directly to untrusted clients with this setting. When deploying behind a different proxy, configure its forwarding headers and trust boundary accordingly.

After initial provisioning, use **Change password** for your password and **Users & permissions** for staff access. Keep `.env` and backups outside version control. See [operations](docs/OPERATIONS.md) for backup and restore procedures.

## Accounting workflow

- Pending transactions do not affect balances. Posting creates the journal entries; payment and expense recognition use separate documents where needed.
- Bank withdrawals and account transfers move company assets. Cash accounts identify a custodian.
- Customer invoices and vendor bills can be settled in parts. Payments are allocated to an outstanding document, and overpayments are rejected.
- Foreign-currency documents retain their nominal amount and the entered PKR exchange rate. Reports present base-currency totals. Rates are entered manually; no live exchange-rate feed is configured.
- Foreign bank/cash outflows release their average PKR carrying value and recognize exchange differences. Same-currency transfers preserve carrying value; cross-currency transfers record the actual received amount. Foreign account transactions must be entered chronologically, and later foreign account transactions must be reversed before earlier ones.
- Existing asset purchases and depreciation remain in transaction history and financial reports. The app no longer creates asset records or posts depreciation.
- Existing unpaid asset purchases and capital bills can still be settled through Vendors & Payables. Historical asset records and project associations are preserved.
- Posted journals are retained. Corrections use reversal and a replacement transaction. Locked periods prevent backdated posting; authorized users manage the lock date.
- Inter-company transfers post both companies together. Both entities must exist in the same application database, and the acting user needs access to both.
- Attachments are stored privately in `UPLOAD_DIR` and served through authenticated, company-scoped download routes.

The application's accounting policies and seeded heads are configurable starting points. Payroll calculation, statutory tax filing, bank feeds, live HRIS synchronization, and email-based authentication recovery are outside this implementation. Salary and tax amounts may be entered as finance transactions. Authentication uses username or email and password and a PostgreSQL session store.

## Project structure

- `client/`: React interface and styles.
- `server/`: authentication, permission guards, business routes, accounting posting, reports, and PostgreSQL access.
- `shared/`: input schemas and permission definitions.
- `migrations/`: ordered SQL schema migrations.
- `tests/`: accounting and integration verification.

Business inputs use ordinary action names. `server/accounting.ts` determines journal accounts, `server/routes.ts` enforces access and lifecycle transitions, and PostgreSQL constraints validate accounting balance. Financial money calculations use decimal values, and persisted amounts use PostgreSQL `numeric` columns.

## Verification

The implementation has been checked with TypeScript and the production build, 26 accounting integration tests, and 19 HTTP integration tests against PostgreSQL. The HTTP suite can also run against the compiled production server by setting `TEST_PRODUCTION=1` after building. Tests cover own-data restrictions even with broad permissions, private payroll, assigned cash, attachment access, historical records, and changes to an existing session's access. Docker packaging is provided but has not been executed in this workstation's environment.

The browser interface was verified for administrator sign-in, first-company setup, responsive navigation, the dashboard, and business transaction forms. `/health` checks both the application and its PostgreSQL connection.

The current build additionally passed 26 compiled-server HTTP and deployment safeguard tests. Earlier packaging validation covered PM2 start/restart/graceful-stop against an empty test schema; that PM2 check has not been repeated for the simplified workflow. To repeat it, set `TEST_DATABASE_URL` to a dedicated test database and run `node script/test-pm2.mjs <release-directory>` after installing that release's runtime dependencies. On Windows, run this on a host without an existing PM2 daemon; the test refuses to interfere with an existing daemon.
