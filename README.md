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

The initial company has a PKR base currency, a seeded chart of accounts, expense categories, and approval enabled. Create bank/cash accounts, contacts, projects, and additional users before recording transactions. For approval-enabled companies, anyone with `transactions.approve` permission and access to the company can approve a submitted transaction, including its creator. A separate reviewer is not required. Configure this permission on a role or explicitly enable/disable it for a user under Users & permissions. Approval and posting remain separate permissions. Company settings can disable approval when direct finance posting is appropriate.

## Restricted users and petty cash

Action permissions and data visibility are separate. In **Users & permissions**, edit a user and select **Data visibility → Own data only**. Grant their company access and link their employee/custodian record for each company. Cash accounts assigned to that employee and advances issued to them will then appear in **My cash** and **My advances**.

Own-data users can view their permitted submissions and cash/advance transactions involving their assigned employee record. Finance-created funding and advance records are read-only; users can submit separate expense settlements or returns. Their creation, submission, approval, posting, and reversal abilities still depend on the corresponding action permissions. Approval permission never expands an own-data user's visibility or permits approval of someone else's record.

Company income, bank balances, payroll/private accounts, other employees, customer records, company reports, assets, audit history, reconciliation, and administration are excluded from own-data access. Restricted requests are checked on the server, including guessed transaction/attachment IDs and drafts created before a user's scope changed. Basic vendor and project names remain available for entering expenses, without vendor contact, tax, or bank details. A restricted user's own assigned cash balance includes all movements in that cash account.

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

The optional demo seed adds two separate fictional companies and 43 sample documents. It is atomic and safe to rerun without duplication. See [demo data and verified balances](docs/DEMO-DATA.md) for the sample date range, expected totals, and testing results.

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

- Draft and submitted transactions do not affect balances. Posting creates the journal entries; payment and expense recognition use separate documents where needed.
- Bank withdrawals and account transfers move company assets. Employee cash accounts identify a custodian; employee advances have their own settlement documents.
- Customer invoices and vendor bills can be settled in parts. Payments are allocated to an outstanding document, and overpayments are rejected.
- Foreign-currency documents retain their nominal amount and the entered PKR exchange rate. Reports present base-currency totals. Rates are entered manually; no live exchange-rate feed is configured.
- Foreign bank/cash outflows release their average PKR carrying value and recognize exchange differences. Same-currency transfers preserve carrying value; cross-currency transfers record the actual received amount. Foreign account transactions must be entered chronologically, and later foreign account transactions must be reversed before earlier ones.
- Asset purchases create asset records. Monthly straight-line depreciation is posted explicitly from the asset workflow; it does not run on a background schedule.
- Depreciation uses full months starting with the acquisition month, includes any missed months up to the selected date, preserves salvage value, and carries the purchase's project attribution. Each monthly posting can be reversed through the transaction history.
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

The implementation has been checked with TypeScript and the production build, 25 accounting integration tests, and 19 HTTP integration tests against PostgreSQL. The HTTP suite can also run against the compiled production server by setting `TEST_PRODUCTION=1` after building. Tests cover own-data restrictions even with broad permissions, private payroll, assigned cash, attachment access, linked advances, and changes to an existing session's access. Docker packaging is provided but has not been executed in this workstation's environment.

The browser interface was verified for administrator sign-in, first-company setup, responsive navigation, the dashboard, and business transaction forms. `/health` checks both the application and its PostgreSQL connection.

Production packaging additionally passed 22 compiled-server HTTP and deployment safeguard tests, plus PM2 start/restart/graceful-stop verification against an empty test schema. To repeat the PM2 smoke test, set `TEST_DATABASE_URL` to a dedicated test database and run `node script/test-pm2.mjs <release-directory>` after installing that release's runtime dependencies. On Windows, run this on a host without an existing PM2 daemon; the test refuses to interfere with an existing daemon.
