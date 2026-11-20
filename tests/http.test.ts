import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { createServer } from "node:net";
import pg from "pg";

// Explicit opt-in only. Every run gets a dedicated schema, app process and upload folder.
// Production and local-development schemas are never reset or truncated.
const databaseUrl = process.env.TEST_DATABASE_URL;
const productionBuild = process.env.TEST_PRODUCTION === "1";
describe(
  "HTTP authentication, company access and transaction workflow",
  { skip: !databaseUrl, timeout: 90_000 },
  () => {
    const schema = `gss_http_${randomUUID().replaceAll("-", "")}`;
    const password = "Http-integration-test-password-42";
    let control: pg.Pool;
    let child: ChildProcess | undefined;
    let uploadDir = "";
    let output = "";
    let base = "";
    let adminCookie = "",
      employeeCookie = "",
      viewerCookie = "",
      managerCookie = "";
    let company = 0,
      otherCompany = 0,
      employeeId = 0,
      viewerId = 0;
    let bank = 0,
      head = 0,
      adminDocument = 0,
      employeeDocument = 0;
    let roles: any[] = [];
    let initialAdmin: any;
    let initialCompanies: any[] = [];
    let initialDocumentCount = -1;

    async function request(
      path: string,
      options: {
        method?: string;
        body?: any;
        cookie?: string;
        csrf?: boolean;
      } = {},
    ) {
      const headers: Record<string, string> = {};
      if (productionBuild) headers["X-Forwarded-Proto"] = "https";
      if (options.cookie) headers.Cookie = options.cookie;
      if (options.csrf !== false) headers["X-GSS-Request"] = "1";
      const multipart = options.body instanceof FormData;
      if (options.body !== undefined && !multipart)
        headers["Content-Type"] = "application/json";
      const response = await fetch(`${base}${path}`, {
        method: options.method || "GET",
        headers,
        body:
          options.body === undefined
            ? undefined
            : multipart
              ? options.body
              : JSON.stringify(options.body),
        signal: AbortSignal.timeout(15_000),
      });
      const data = response.headers
        .get("content-type")
        ?.includes("application/json")
        ? await response.json()
        : await response.text();
      return { response, data };
    }
    async function ok(
      path: string,
      options: Parameters<typeof request>[1] = {},
    ) {
      const result = await request(path, { cookie: adminCookie, ...options });
      assert.equal(
        result.response.status,
        200,
        `${path}: ${JSON.stringify(result.data)}`,
      );
      return result.data;
    }
    async function login(username: string, loginPassword = password) {
      const { response, data } = await request("/api/login", {
        method: "POST",
        body: { username, password: loginPassword },
      });
      assert.equal(response.status, 200, JSON.stringify(data));
      const cookie = response.headers.get("set-cookie")?.split(";")[0];
      assert.ok(cookie, "Login creates a session cookie");
      assert.match(response.headers.get("set-cookie")!, /HttpOnly/i);
      assert.match(response.headers.get("set-cookie")!, /SameSite=Lax/i);
      return cookie;
    }
    async function addUser(username: string, role: string) {
      return ok("/api/admin/users", {
        method: "POST",
        body: {
          username,
          full_name: username,
          password,
          role_id: roles.find((r) => r.name === role).id,
          active: true,
          companies: [company],
          overrides: {},
          data_scope: "company",
        },
      });
    }
    async function createPending(body: any) {
      const document = await ok(`/api/c/${company}/documents`, {
        method: "POST",
        body,
      });
      assert.equal(document.status, "pending");
      return document;
    }
    async function post(documentId: number) {
      return ok(`/api/c/${company}/documents/${documentId}/post`, {
        method: "POST",
        body: {},
      });
    }

    before(async () => {
      control = new pg.Pool({ connectionString: databaseUrl });
      await control.query(`CREATE SCHEMA ${schema}`);
      const scopedUrl = new URL(databaseUrl!);
      // No public fallback: existing users/session/migration tables cannot be selected.
      scopedUrl.searchParams.set("options", `-c search_path=${schema}`);
      uploadDir = await mkdtemp(join(tmpdir(), "gss-http-"));
      const probe = createServer();
      await new Promise<void>((resolve) =>
        probe.listen(0, "127.0.0.1", resolve),
      );
      const address = probe.address();
      assert.ok(address && typeof address !== "string");
      const port = address.port;
      await new Promise<void>((resolve, reject) =>
        probe.close((error) => (error ? reject(error) : resolve())),
      );
      base = `http://127.0.0.1:${port}`;
      child = spawn(
        process.execPath,
        productionBuild
          ? ["dist/server.js"]
          : ["--import", "tsx", "server/index.ts"],
        {
          cwd: process.cwd(),
          windowsHide: true,
          env: {
            ...process.env,
            DATABASE_URL: scopedUrl.toString(),
            PORT: String(port),
            NODE_ENV: productionBuild ? "production" : "development",
            TRUST_PROXY: productionBuild ? "1" : "0",
            ADMIN_PASSWORD: password,
            SESSION_SECRET: randomUUID() + randomUUID(),
            UPLOAD_DIR: uploadDir,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      child.stdout?.on("data", (data) => {
        output += String(data);
      });
      child.stderr?.on("data", (data) => {
        output += String(data);
      });
      const started = Date.now();
      while (Date.now() - started < 40_000) {
        if (child.exitCode !== null)
          throw new Error(`Test app exited: ${output}`);
        try {
          const ready = await fetch(`${base}/api/auth/user`, {
            signal: AbortSignal.timeout(500),
          });
          if (ready.status === 401) break;
        } catch {
          /* Startup is still applying migrations/building middleware. */
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(
        Date.now() - started < 40_000,
        `Test app did not start: ${output}`,
      );
      adminCookie = await login("admin");
      initialAdmin = await ok("/api/admin");
      initialCompanies = await ok("/api/companies");
      initialDocumentCount = Number(
        (await control.query(`SELECT count(*) FROM ${schema}.documents`))
          .rows[0].count,
      );
      company = (
        await ok("/api/companies", {
          method: "POST",
          body: { name: "HTTP main company" },
        })
      ).id;
      otherCompany = (
        await ok("/api/companies", {
          method: "POST",
          body: { name: "HTTP other company" },
        })
      ).id;
      roles = (await ok("/api/admin")).roles;
      employeeId = (await addUser("http_employee", "employee")).id;
      viewerId = (await addUser("http_viewer", "viewer")).id;
      await addUser("http_manager", "manager");
      employeeCookie = await login("http_employee");
      viewerCookie = await login("http_viewer");
      managerCookie = await login("http_manager");
      const bootstrap = await ok(`/api/c/${company}/bootstrap`);
      head = bootstrap.accounts.find((a: any) => a.purpose === "office").id;
      bank = (
        await ok(`/api/c/${company}/accounts`, {
          method: "POST",
          body: {
            code: "HTTPBANK",
            name: "HTTP Bank",
            type: "asset",
            purpose: "bank",
            currency: "PKR",
          },
        })
      ).id;
      const opening = await ok(`/api/c/${company}/documents`, {
        method: "POST",
        body: {
          kind: "opening",
          date: "2026-10-01",
          amount: "100000",
          description: "Test funding",
          targetId: bank,
        },
      });
      await ok(`/api/c/${company}/documents/${opening.id}/post`, {
        method: "POST",
        body: {},
      });
      adminDocument = (
        await ok(`/api/c/${company}/documents`, {
          method: "POST",
          body: {
            kind: "expense",
            date: "2026-10-02",
            amount: "200",
            description: "Administrator expense",
            sourceId: bank,
            headId: head,
          },
        })
      ).id;
      employeeDocument = (
        await ok(`/api/c/${company}/documents`, {
          method: "POST",
          cookie: employeeCookie,
          body: {
            kind: "expense",
            date: "2026-10-02",
            amount: "100",
            description: "Employee expense",
            sourceId: bank,
            headId: head,
          },
        })
      ).id;
    });

    after(async () => {
      if (child && child.exitCode === null) {
        const ended = new Promise<void>((resolve) =>
          child!.once("exit", () => resolve()),
        );
        child.kill();
        await Promise.race([
          ended,
          new Promise((resolve) => setTimeout(resolve, 3000)),
        ]);
        if (child.exitCode === null) child.kill("SIGKILL");
      }
      if (control) {
        // Only the generated identifier created by this test can be removed.
        assert.match(schema, /^gss_http_[a-f0-9]{32}$/);
        await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await control.end();
      }
      if (uploadDir) {
        assert.equal(dirname(resolve(uploadDir)), resolve(tmpdir()));
        assert.ok(basename(uploadDir).startsWith("gss-http-"));
        await rm(uploadDir, { recursive: true, force: true });
      }
    });

    test("fresh deployment creates only the fixed administrator and no sample financial data", async () => {
      assert.equal(initialAdmin.users.length, 1);
      const admin = initialAdmin.users[0];
      assert.equal(admin.username, "admin");
      assert.equal(admin.email, "gamestrixstudios@gmail.com");
      assert.equal(admin.active, true);
      assert.equal(
        initialAdmin.roles.find((r: any) => r.id === admin.role_id)?.name,
        "super_admin",
      );
      assert.deepEqual(initialCompanies, []);
      assert.equal(initialDocumentCount, 0);
      const emailCookie = await login("gamestrixstudios@gmail.com");
      const actor = await ok("/api/auth/user", { cookie: emailCookie });
      assert.equal(actor.id, admin.id);
      assert.equal(actor.username, "admin");
      assert.equal(actor.email, "gamestrixstudios@gmail.com");
      await ok("/api/logout", { method: "POST", cookie: emailCookie });
    });

    test("login persists a fixed two-day or remembered fourteen-day session and resets it on reauthentication", async () => {
      const dayMs = 24 * 60 * 60 * 1000;
      let previousCookie: string | undefined;
      let previousSid: string | undefined;
      for (const rememberMe of [undefined, true, false]) {
        const duration = (rememberMe ? 14 : 2) * dayMs;
        const started = Date.now();
        const { response, data } = await request("/api/login", {
          method: "POST",
          cookie: previousCookie,
          body: { username: "admin", password, rememberMe },
        });
        const finished = Date.now();
        assert.equal(response.status, 200, JSON.stringify(data));
        const header = response.headers.get("set-cookie")!;
        const cookie = header.split(";")[0];
        assert.ok(cookie.startsWith("gss.sid="));
        assert.match(header, /HttpOnly/i);
        assert.match(header, /SameSite=Lax/i);
        assert.equal(/; Secure/i.test(header), productionBuild);
        const expires = Date.parse(/Expires=([^;]+)/i.exec(header)![1]);
        assert.ok(expires >= started + duration - 1000);
        assert.ok(expires <= finished + duration + 1000);
        const signed = decodeURIComponent(
          cookie.slice(cookie.indexOf("=") + 1),
        );
        assert.ok(signed.startsWith("s:"));
        const sid = signed.slice(2, signed.lastIndexOf("."));
        const stored = (
          await control.query(
            `SELECT sess, extract(epoch FROM expire AT TIME ZONE current_setting('TimeZone')) * 1000 AS expires_ms FROM ${schema}.sessions WHERE sid=$1`,
            [sid],
          )
        ).rows[0];
        assert.ok(stored);
        assert.equal(stored.sess.cookie.originalMaxAge, duration);
        assert.ok(stored.sess.expiresAt >= started + duration);
        assert.ok(stored.sess.expiresAt <= finished + duration);
        assert.ok(
          Math.abs(Number(stored.expires_ms) - stored.sess.expiresAt) < 1100,
        );
        assert.ok(Math.abs(expires - stored.sess.expiresAt) < 1100);
        const activity = await request("/api/auth/user", { cookie });
        assert.equal(activity.response.status, 200);
        assert.equal(activity.response.headers.get("set-cookie"), null);
        const afterActivity = (
          await control.query(
            `SELECT sess, extract(epoch FROM expire AT TIME ZONE current_setting('TimeZone')) * 1000 AS expires_ms FROM ${schema}.sessions WHERE sid=$1`,
            [sid],
          )
        ).rows[0];
        assert.deepEqual(
          afterActivity,
          stored,
          "Activity must not extend the chosen session lifetime",
        );
        if (previousCookie && previousSid) {
          assert.notEqual(
            cookie,
            previousCookie,
            "Reauthentication rotates the session identifier",
          );
          assert.equal(
            (await request("/api/auth/user", { cookie: previousCookie }))
              .response.status,
            401,
          );
          assert.equal(
            (
              await control.query(
                `SELECT 1 FROM ${schema}.sessions WHERE sid=$1`,
                [previousSid],
              )
            ).rowCount,
            0,
          );
        }
        previousCookie = cookie;
        previousSid = sid;
      }
      await ok("/api/logout", { method: "POST", cookie: previousCookie });
      assert.equal(
        (await request("/api/auth/user", { cookie: previousCookie })).response
          .status,
        401,
      );
      assert.equal(
        (
          await control.query(`SELECT 1 FROM ${schema}.sessions WHERE sid=$1`, [
            previousSid,
          ])
        ).rowCount,
        0,
      );
    });

    test("remember-me requires a boolean and an expired server deadline rejects a replayed cookie", async () => {
      const count = (
        await control.query(`SELECT count(*) FROM ${schema}.sessions`)
      ).rows[0].count;
      for (const rememberMe of ["true", 1, null, []]) {
        const invalid = await request("/api/login", {
          method: "POST",
          body: { username: "admin", password, rememberMe },
        });
        assert.equal(invalid.response.status, 400);
        assert.equal(invalid.response.headers.get("set-cookie"), null);
      }
      assert.equal(
        (await control.query(`SELECT count(*) FROM ${schema}.sessions`)).rows[0]
          .count,
        count,
      );
      const { response } = await request("/api/login", {
        method: "POST",
        body: { username: "admin", password, rememberMe: true },
      });
      assert.equal(response.status, 200);
      const cookie = response.headers.get("set-cookie")!.split(";")[0];
      const signed = decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1));
      const sid = signed.slice(2, signed.lastIndexOf("."));
      // Leave the browser cookie and store expiry in the future to exercise the
      // server's fixed deadline rather than the session store's expiry filter.
      await control.query(
        `UPDATE ${schema}.sessions SET sess=jsonb_set(sess::jsonb,'{expiresAt}',to_jsonb($2::bigint)) WHERE sid=$1`,
        [sid, Date.now() - 1000],
      );
      const expired = await request("/api/auth/user", { cookie });
      assert.equal(expired.response.status, 401);
      assert.ok(
        Date.parse(
          /Expires=([^;]+)/i.exec(
            expired.response.headers.get("set-cookie")!,
          )![1],
        ) < Date.now(),
      );
      assert.equal(
        (
          await control.query(`SELECT 1 FROM ${schema}.sessions WHERE sid=$1`, [
            sid,
          ])
        ).rowCount,
        0,
      );
      assert.equal(
        (await request("/api/companies", { cookie })).response.status,
        401,
      );
    });

    test("only the fixed administrator can hold the super administrator role", async () => {
      const before = await ok("/api/admin");
      const superRole = roles.find((r) => r.name === "super_admin");
      const financeRole = roles.find((r) => r.name === "finance");
      const existing = before.users.find((u: any) => u.id === viewerId);
      const baseUser = {
        username: "second_super_admin",
        full_name: "Second administrator",
        email: "second-admin@example.com",
        password,
        role_id: superRole.id,
        active: true,
        companies: [company],
        overrides: {},
      };
      assert.equal(
        (
          await request("/api/admin/users", {
            method: "POST",
            cookie: adminCookie,
            body: baseUser,
          })
        ).response.status,
        403,
      );
      assert.equal(
        (
          await request("/api/admin/users", {
            method: "POST",
            cookie: adminCookie,
            body: { ...baseUser, ...existing, role_id: superRole.id },
          })
        ).response.status,
        403,
      );
      const delegated = await ok("/api/admin/users", {
        method: "POST",
        body: {
          ...baseUser,
          username: "http_access_manager",
          email: "access-manager@example.com",
          role_id: financeRole.id,
          overrides: { "users.manage": true },
        },
      });
      const delegatedCookie = await login("http_access_manager");
      const fixedAdmin = before.users.find((u: any) => u.username === "admin");
      assert.equal(
        (
          await request("/api/admin/users", {
            method: "POST",
            cookie: delegatedCookie,
            body: {
              ...baseUser,
              ...fixedAdmin,
              email: "changed-admin@example.com",
              role_id: financeRole.id,
              active: false,
            },
          })
        ).response.status,
        403,
      );
      const after = await ok("/api/admin");
      assert.equal(after.users.length, before.users.length + 1);
      assert.ok(after.users.some((u: any) => u.id === delegated.id));
      assert.deepEqual(
        after.users.filter((u: any) => u.role_id === superRole.id),
        [fixedAdmin],
      );
      assert.equal(
        after.users.find((u: any) => u.id === viewerId).role_id,
        existing.role_id,
      );
      await ok("/api/logout", { method: "POST", cookie: delegatedCookie });
    });

    test("normal user emails are optional, validated, and usable for login", async () => {
      const before = await ok("/api/admin");
      const baseUser = {
        username: "http_email_user",
        full_name: "Email user",
        password,
        role_id: roles.find((r) => r.name === "viewer").id,
        active: true,
        companies: [company],
        overrides: {},
      };
      assert.equal(
        (
          await request("/api/admin/users", {
            method: "POST",
            cookie: adminCookie,
            body: { ...baseUser, email: "invalid-address" },
          })
        ).response.status,
        400,
      );
      assert.equal((await ok("/api/admin")).users.length, before.users.length);
      const added = await ok("/api/admin/users", {
        method: "POST",
        body: { ...baseUser, email: "http-email@example.com" },
      });
      const saved = (await ok("/api/admin")).users.find(
        (u: any) => u.id === added.id,
      );
      assert.equal(saved.email, "http-email@example.com");
      const cookie = await login(saved.email);
      assert.equal((await ok("/api/auth/user", { cookie })).id, added.id);
      await ok("/api/logout", { method: "POST", cookie });
      const noEmail = await ok("/api/admin/users", {
        method: "POST",
        body: { ...baseUser, username: "http_without_email", email: null },
      });
      assert.equal(
        (await ok("/api/admin")).users.find((u: any) => u.id === noEmail.id)
          .email,
        null,
      );
    });

    test("rejects anonymous access, missing request protection, and invalid credentials", async () => {
      assert.equal((await request("/api/companies")).response.status, 401);
      assert.equal(
        (
          await request("/api/login", {
            method: "POST",
            csrf: false,
            body: { username: "admin", password },
          })
        ).response.status,
        403,
      );
      assert.equal(
        (
          await request("/api/login", {
            method: "POST",
            body: { username: "admin", password: "incorrect" },
          })
        ).response.status,
        401,
      );
    });

    test("company setup seeds accounting and enforces explicit memberships", async () => {
      const bootstrap = await ok(`/api/c/${company}/bootstrap`);
      assert.equal(bootstrap.company.currency, "PKR");
      assert.equal(bootstrap.company.approvals, false);
      assert.deepEqual(bootstrap.projects, []);
      assert.ok(
        bootstrap.accounts.some((a: any) => a.purpose === "receivable"),
      );
      assert.ok(bootstrap.categories.length > 10);
      const visible = await ok("/api/companies", { cookie: employeeCookie });
      assert.deepEqual(
        visible.map((c: any) => c.id),
        [company],
      );
      assert.equal(
        (
          await request(`/api/c/${otherCompany}/bootstrap`, {
            cookie: employeeCookie,
          })
        ).response.status,
        403,
      );
      assert.equal(
        (
          await request(`/api/c/${company}/contacts`, {
            cookie: viewerCookie,
            method: "POST",
            body: { name: "Forbidden vendor", kind: "vendor" },
          })
        ).response.status,
        403,
      );
    });

    test("super admin can find an unused child expense account after saving and reloading, and explicitly map its category", async () => {
      const admin = initialAdmin.users.find(
        (user: any) => user.username === "admin",
      );
      assert.equal(
        roles.find((role: any) => role.id === admin.role_id)?.name,
        "super_admin",
      );
      const prefix = `/api/c/${company}`;
      const before = await ok(`${prefix}/bootstrap`);
      const parent = before.accounts.find(
        (account: any) =>
          account.type === "expense" && account.purpose === "office",
      );
      assert.ok(
        parent,
        "The new account belongs under an existing office expense account",
      );
      const input = {
        code: "IMP-GROCERY",
        name: "Grocery & kitchen",
        type: "expense",
        active: true,
        purpose: "general",
        currency: "PKR",
        parent_id: parent.id,
        restricted: false,
        custodian_id: null,
      };
      const account = await ok(`${prefix}/accounts`, {
        method: "POST",
        body: input,
      });
      assert.deepEqual(account, {
        ...input,
        id: account.id,
        company_id: company,
      });
      for (const stage of ["immediately after saving", "after reloading"]) {
        const bootstrap = await ok(`${prefix}/bootstrap`);
        assert.deepEqual(
          bootstrap.accounts.find((row: any) => row.id === account.id),
          account,
          `The chart includes the child expense account ${stage}`,
        );
        assert.ok(
          !bootstrap.categories.some(
            (row: any) => row.account_id === account.id,
          ),
          "Creating an account does not implicitly create an expense category",
        );
        assert.ok(
          bootstrap.accounts.every((row: any) => row.company_id === company),
        );
      }
      assert.equal(
        Number(
          (
            await control.query(
              `SELECT count(*) FROM ${schema}.journal_lines WHERE account_id=$1`,
              [account.id],
            )
          ).rows[0].count,
        ),
        0,
        "An account is visible without posting any journal entries",
      );
      const category = await ok(`${prefix}/categories`, {
        method: "POST",
        body: { name: account.name, account_id: account.id },
      });
      const mapped = await ok(`${prefix}/bootstrap`);
      assert.deepEqual(
        mapped.categories.find((row: any) => row.id === category.id),
        category,
      );
      assert.equal(category.account_id, account.id);
      const other = await ok(`/api/c/${otherCompany}/bootstrap`);
      assert.ok(!other.accounts.some((row: any) => row.id === account.id));
      assert.ok(!other.categories.some((row: any) => row.id === category.id));
    });

    test("company data access permits employee visibility while other users' submissions remain protected from editing", async () => {
      const own = await ok(`/api/c/${company}/documents`, {
        cookie: employeeCookie,
      });
      assert.ok(own.some((d: any) => d.id === employeeDocument));
      assert.ok(own.some((d: any) => d.id === adminDocument));
      const companyDocs = await ok(`/api/c/${company}/documents`, {
        cookie: managerCookie,
      });
      assert.ok(companyDocs.some((d: any) => d.id === adminDocument));
      const denied = await request(
        `/api/c/${company}/documents/${adminDocument}/cancel`,
        { method: "POST", cookie: employeeCookie, body: {} },
      );
      assert.ok([400, 403].includes(denied.response.status));
    });

    test("posting permission moves a pending transaction directly to posted with a traceable audit", async () => {
      const admin = await ok("/api/auth/user");
      const before = (await ok(`/api/c/${company}/documents`)).find(
        (d: any) => d.id === adminDocument,
      );
      assert.equal(before.status, "pending");
      assert.equal(
        (
          await request(`/api/c/${company}/documents/${adminDocument}/post`, {
            method: "POST",
            cookie: employeeCookie,
            body: {},
          })
        ).response.status,
        403,
      );
      await post(adminDocument);
      const posted = (await ok(`/api/c/${company}/documents`)).find(
        (d: any) => d.id === adminDocument,
      );
      assert.equal(posted.status, "posted");
      assert.equal(posted.approved_by, null);
      const rows = (
        await control.query(
          `SELECT user_id,before_value,after_value FROM ${schema}.audit WHERE entity='document' AND entity_id=$1 AND action='post'`,
          [adminDocument],
        )
      ).rows;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].user_id, admin.id);
      assert.equal(rows[0].before_value.status, "pending");
      assert.equal(rows[0].after_value.status, "posted");
      for (const action of ["submit", "approve", "reject"]) {
        const result = await request(
          `/api/c/${company}/documents/${employeeDocument}/${action}`,
          { method: "POST", cookie: adminCookie, body: {} },
        );
        assert.equal(result.response.status, 410);
      }
      const settings = await ok("/api/admin");
      assert.ok(!settings.permissions.includes("transactions.submit"));
      assert.ok(!settings.permissions.includes("transactions.approve"));
    });

    test("transaction ledger exposes stored posting and reversal entries with transaction-view access", async () => {
      const category = await ok(`/api/c/${company}/categories`, {
        method: "POST",
        body: { name: "Ledger history category", account_id: head },
      });
      const document = await createPending({
        kind: "expense",
        date: "2026-10-03",
        amount: "125.50",
        description: "Ledger detail history test",
        sourceId: bank,
        categoryId: category.id,
      });
      const path = `/api/c/${company}/documents/${document.id}/ledger`;
      assert.equal((await request(path)).response.status, 401);
      assert.deepEqual(await ok(path), { journals: [] });
      await post(document.id);
      const original = await ok(path, { cookie: employeeCookie });
      assert.equal(original.journals.length, 1);
      assert.equal(original.journals[0].date, "2026-10-03");
      assert.equal(original.journals[0].reversal_of, null);
      assert.deepEqual(
        original.journals[0].lines.map((line: any) => [
          line.account_id,
          line.debit,
          line.credit,
          line.currency,
          line.foreign_amount,
        ]),
        [
          [head, "125.50", "0.00", "PKR", "125.50"],
          [bank, "0.00", "125.50", "PKR", "-125.50"],
        ],
      );
      const bankLine = original.journals[0].lines.find(
        (line: any) => line.account_id === bank,
      );
      assert.equal(bankLine.account_code, "HTTPBANK");
      assert.equal(bankLine.account_name, "HTTP Bank");
      assert.deepEqual(Object.keys(bankLine).sort(), [
        "account_code",
        "account_id",
        "account_name",
        "credit",
        "currency",
        "debit",
        "foreign_amount",
        "id",
      ]);
      const setup = await ok(`/api/c/${company}/bootstrap`);
      await ok(`/api/c/${company}/categories/${category.id}`, {
        method: "PATCH",
        body: {
          name: category.name,
          account_id: setup.accounts.find((a: any) => a.purpose === "software")
            .id,
        },
      });
      assert.deepEqual(
        await ok(path),
        original,
        "Historical entries do not follow a remapped category",
      );
      await ok(`/api/c/${company}/documents/${document.id}/reverse`, {
        method: "POST",
        body: { date: "2026-10-04" },
      });
      const reversed = await ok(path);
      assert.equal(reversed.journals.length, 2);
      assert.deepEqual(reversed.journals[0], original.journals[0]);
      assert.equal(reversed.journals[1].reversal_of, original.journals[0].id);
      assert.equal(reversed.journals[1].date, "2026-10-04");
      for (const line of original.journals[0].lines) {
        const undo = reversed.journals[1].lines.find(
          (candidate: any) => candidate.account_id === line.account_id,
        );
        assert.equal(undo.debit, line.credit);
        assert.equal(undo.credit, line.debit);
      }
      assert.equal(
        (
          await request(
            `/api/c/${otherCompany}/documents/${document.id}/ledger`,
            { cookie: adminCookie },
          )
        ).response.status,
        404,
      );
      assert.equal(
        (
          await request(
            `/api/c/${otherCompany}/documents/${document.id}/ledger`,
            { cookie: viewerCookie },
          )
        ).response.status,
        403,
      );
      assert.equal(
        (
          await request(`/api/c/${company}/documents/2147483647/ledger`, {
            cookie: adminCookie,
          })
        ).response.status,
        404,
      );
      const cancelled = await createPending({
        kind: "expense",
        date: "2026-10-03",
        amount: "5",
        description: "Cancelled ledger detail",
        sourceId: bank,
        headId: head,
      });
      await ok(`/api/c/${company}/documents/${cancelled.id}/cancel`, {
        method: "POST",
        body: {},
      });
      assert.deepEqual(
        await ok(`/api/c/${company}/documents/${cancelled.id}/ledger`),
        { journals: [] },
      );
      await ok("/api/admin/users", {
        method: "POST",
        body: {
          username: "http_no_ledger_access",
          full_name: "No transaction view",
          password,
          role_id: roles.find((r) => r.name === "viewer").id,
          active: true,
          companies: [company],
          data_scope: "company",
          overrides: { "transactions.view": false },
        },
      });
      const deniedCookie = await login("http_no_ledger_access");
      assert.equal(
        (await request(path, { cookie: deniedCookie })).response.status,
        403,
      );
      assert.equal(
        (
          await request(`/api/c/${company}/documents/${cancelled.id}/ledger`, {
            cookie: deniedCookie,
          })
        ).response.status,
        403,
      );
    });

    test("inter-company transaction details reveal only the current company's journal", async () => {
      const target = await ok(`/api/c/${otherCompany}/accounts`, {
        method: "POST",
        body: {
          code: "LEDGER-RECEIVER",
          name: "Receiver-only bank",
          type: "asset",
          purpose: "bank",
          currency: "PKR",
        },
      });
      await ok("/api/admin/users", {
        method: "POST",
        body: {
          username: "http_ledger_receiver",
          full_name: "Receiver-only viewer",
          password,
          role_id: roles.find((r) => r.name === "viewer").id,
          active: true,
          companies: [otherCompany],
          data_scope: "company",
          overrides: {},
        },
      });
      const receiverCookie = await login("http_ledger_receiver");
      const document = await createPending({
        kind: "intercompany",
        date: "2026-10-05",
        amount: "300",
        description: "Company-local ledger details",
        sourceId: bank,
        targetId: target.id,
        otherCompanyId: otherCompany,
      });
      const incomingPath = `/api/c/${otherCompany}/documents/${document.id}/ledger`;
      assert.equal(
        (await request(incomingPath, { cookie: receiverCookie })).response
          .status,
        404,
      );
      await post(document.id);
      const outgoing = await ok(
        `/api/c/${company}/documents/${document.id}/ledger`,
      );
      const incoming = await ok(incomingPath, { cookie: receiverCookie });
      assert.equal(outgoing.journals.length, 1);
      assert.equal(incoming.journals.length, 1);
      assert.notEqual(outgoing.journals[0].id, incoming.journals[0].id);
      assert.equal(outgoing.journals[0].lines.length, 2);
      assert.equal(incoming.journals[0].lines.length, 2);
      assert.ok(
        incoming.journals[0].lines.some(
          (line: any) =>
            line.account_id === target.id && line.debit === "300.00",
        ),
      );
      assert.ok(
        !incoming.journals[0].lines.some(
          (line: any) => line.account_id === bank,
        ),
      );
      assert.ok(
        !outgoing.journals[0].lines.some(
          (line: any) => line.account_id === target.id,
        ),
      );
      assert.doesNotMatch(JSON.stringify(incoming), /HTTPBANK|HTTP Bank/);
      assert.equal(
        (
          await request(`/api/c/${company}/documents/${document.id}/ledger`, {
            cookie: receiverCookie,
          })
        ).response.status,
        403,
      );
      await ok(`/api/c/${company}/documents/${document.id}/reverse`, {
        method: "POST",
        body: { date: "2026-10-06" },
      });
      const reversed = await ok(incomingPath, { cookie: receiverCookie });
      assert.equal(reversed.journals.length, 2);
      assert.equal(reversed.journals[1].reversal_of, incoming.journals[0].id);
      assert.doesNotMatch(JSON.stringify(reversed), /HTTPBANK|HTTP Bank/);
    });

    test("uploads reach their handler and downloads retain document access checks", async () => {
      assert.equal(
        (
          await ok(`/api/c/${company}/documents`, { cookie: employeeCookie })
        ).find((d: any) => d.id === employeeDocument).attachment_count,
        0,
      );
      const form = new FormData();
      form.append(
        "files",
        new Blob(["%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF"], {
          type: "application/pdf",
        }),
        "receipt.pdf",
      );
      await ok(`/api/c/${company}/documents/${employeeDocument}/attachments`, {
        method: "POST",
        cookie: employeeCookie,
        body: form,
      });
      const attachments = await ok(
        `/api/c/${company}/documents/${employeeDocument}/attachments`,
        { cookie: employeeCookie },
      );
      assert.equal(attachments.length, 1);
      assert.equal(
        (
          await ok(`/api/c/${company}/documents`, { cookie: employeeCookie })
        ).find((d: any) => d.id === employeeDocument).attachment_count,
        1,
      );
      const download = await request(
        `/api/c/${company}/documents/${employeeDocument}/attachments/${attachments[0].id}`,
        { cookie: employeeCookie },
      );
      assert.equal(download.response.status, 200);
      assert.match(
        download.response.headers.get("content-disposition") || "",
        /attachment/,
      );
      assert.match(download.data, /%PDF-1\.4/);
      const wrongCompany = await request(
        `/api/c/${otherCompany}/documents/${employeeDocument}/attachments/${attachments[0].id}`,
        { cookie: employeeCookie },
      );
      assert.equal(wrongCompany.response.status, 403);
    });

    test("posting overrides take effect immediately without granting other creators' edit rights", async () => {
      const poster = await addUser("http_employee_poster", "employee");
      const cookie = await login("http_employee_poster");
      const expense = {
        kind: "expense",
        date: "2026-10-02",
        amount: "25",
        description: "Permission-controlled posting",
        sourceId: bank,
        headId: head,
      };
      const own = await ok(`/api/c/${company}/documents`, {
        method: "POST",
        cookie,
        body: expense,
      });
      const peer = await ok(`/api/c/${company}/documents`, {
        method: "POST",
        body: expense,
      });
      const action = (doc: number, operation: string) =>
        request(`/api/c/${company}/documents/${doc}/${operation}`, {
          method: "POST",
          cookie,
          body: {},
        });
      assert.equal((await action(own.id, "post")).response.status, 403);
      assert.equal(
        (
          await request(`/api/c/${company}/documents/bulk-post`, {
            method: "POST",
            cookie,
            body: { ids: [own.id, peer.id] },
          })
        ).response.status,
        403,
      );
      const setPermission = (enabled: boolean) =>
        ok("/api/admin/users", {
          method: "POST",
          body: {
            id: poster.id,
            username: "http_employee_poster",
            full_name: "http_employee_poster",
            role_id: roles.find((r) => r.name === "employee").id,
            active: true,
            companies: [company],
            overrides: { "transactions.post": enabled },
            data_scope: "company",
          },
        });
      await setPermission(true);
      assert.equal((await action(peer.id, "cancel")).response.status, 400);
      assert.equal(
        (
          await request(`/api/c/${company}/documents/${peer.id}`, {
            method: "PATCH",
            cookie,
            body: { ...expense, amount: "999" },
          })
        ).response.status,
        400,
      );
      const adjustment = await createPending({
        ...expense,
        kind: "adjustment",
        targetId: head,
      });
      const bulk = await ok(`/api/c/${company}/documents/bulk-post`, {
        method: "POST",
        cookie,
        body: { ids: [adjustment.id, own.id, peer.id] },
      });
      assert.deepEqual(
        bulk.results.map((r: any) => [r.id, r.status]),
        [
          [adjustment.id, "failed"],
          [own.id, "posted"],
          [peer.id, "posted"],
        ],
      );
      assert.equal(bulk.posted, 2);
      assert.equal(bulk.failed, 1);
      assert.equal(
        (
          await control.query(
            `SELECT status FROM ${schema}.documents WHERE id=$1`,
            [adjustment.id],
          )
        ).rows[0].status,
        "pending",
        "Posting permission alone cannot post accounting adjustments",
      );
      const pending = await ok(`/api/c/${company}/documents`, {
        method: "POST",
        cookie,
        body: expense,
      });
      await setPermission(false);
      assert.equal((await action(pending.id, "post")).response.status, 403);
      assert.equal(
        (
          await request(`/api/c/${company}/documents/bulk-post`, {
            method: "POST",
            cookie,
            body: { ids: [pending.id] },
          })
        ).response.status,
        403,
      );
      assert.equal(
        (
          await request(`/api/c/${otherCompany}/documents/${own.id}/post`, {
            method: "POST",
            cookie,
            body: {},
          })
        ).response.status,
        403,
      );
      assert.equal(
        (
          await control.query(
            `SELECT status FROM ${schema}.documents WHERE id=$1`,
            [pending.id],
          )
        ).rows[0].status,
        "pending",
      );
      assert.equal((await action(pending.id, "cancel")).response.status, 200);
      await setPermission(true);
      assert.equal(
        (await action(pending.id, "post")).response.status,
        400,
        "Cancelled records cannot be posted",
      );
    });

    test("finance can record paid asset adjustments and accounting overrides take effect in the same session", async () => {
      const fixtureCompany = await ok("/api/companies", {
        method: "POST",
        body: { name: "Finance adjustment permissions" },
      });
      const prefix = `/api/c/${fixtureCompany.id}`;
      const profile = {
        username: "http_finance_adjustments",
        full_name: "Finance adjustments",
        role_id: roles.find((role) => role.name === "finance").id,
        active: true,
        companies: [fixtureCompany.id],
        data_scope: null,
      };
      const user = await ok("/api/admin/users", {
        method: "POST",
        body: { ...profile, password, overrides: {} },
      });
      const cookie = await login(profile.username);
      const actor = await ok("/api/auth/user", { cookie });
      assert.equal(actor.role, "finance");
      assert.equal(actor.dataScope, "company");
      assert.ok(actor.permissions.includes("accounting.manage"));
      assert.ok(actor.permissions.includes("transactions.create"));
      assert.ok(actor.permissions.includes("transactions.post"));
      assert.ok(!actor.permissions.includes("users.manage"));
      const bootstrap = await ok(`${prefix}/bootstrap`, { cookie });
      const fixedAsset = bootstrap.accounts.find(
        (account: any) => account.purpose === "fixed_asset",
      );
      assert.ok(fixedAsset);
      const paymentAccount = await ok(`${prefix}/accounts`, {
        method: "POST",
        body: {
          code: "ADJUSTMENT-BANK",
          name: "Asset purchase bank",
          type: "asset",
          purpose: "bank",
          currency: "PKR",
        },
      });
      const opening = await ok(`${prefix}/documents`, {
        method: "POST",
        body: {
          kind: "opening",
          date: "2026-10-01",
          amount: "10000",
          description: "Adjustment test funding",
          targetId: paymentAccount.id,
        },
      });
      await ok(`${prefix}/documents/${opening.id}/post`, {
        method: "POST",
        body: {},
      });
      const input = {
        kind: "adjustment",
        date: "2026-10-02",
        amount: "3000",
        currency: "PKR",
        description: "Workstation purchased with company bank funds",
        sourceId: paymentAccount.id,
        targetId: fixedAsset.id,
      };
      const create = () =>
        ok(`${prefix}/documents`, {
          method: "POST",
          cookie,
          body: input,
        });
      const purchase = await create();
      assert.equal(purchase.status, "pending");
      const posted = await ok(`${prefix}/documents/${purchase.id}/post`, {
        method: "POST",
        cookie,
        body: {},
      });
      assert.equal(posted.status, "posted");
      const lines = (
        await control.query(
          `SELECT l.account_id,l.debit,l.credit FROM ${schema}.journal_lines l
         JOIN ${schema}.journals j ON j.id=l.journal_id
         WHERE j.document_id=$1 ORDER BY l.account_id`,
          [purchase.id],
        )
      ).rows;
      assert.deepEqual(lines, [
        { account_id: fixedAsset.id, debit: "3000.00", credit: "0.00" },
        { account_id: paymentAccount.id, debit: "0.00", credit: "3000.00" },
      ]);
      assert.equal(
        Number(
          (
            await control.query(
              `SELECT count(*) FROM ${schema}.assets WHERE company_id=$1`,
              [fixtureCompany.id],
            )
          ).rows[0].count,
        ),
        0,
        "An adjustment records the ledger entry without recreating asset management",
      );
      const pending = await create();
      const setAccounting = (enabled: boolean) =>
        ok("/api/admin/users", {
          method: "POST",
          body: {
            ...profile,
            id: user.id,
            overrides: { "accounting.manage": enabled },
          },
        });
      await setAccounting(false);
      const deniedActor = await ok("/api/auth/user", { cookie });
      assert.ok(!deniedActor.permissions.includes("accounting.manage"));
      assert.ok(deniedActor.permissions.includes("transactions.post"));
      for (const [path, body] of [
        [`${prefix}/documents`, input],
        [`${prefix}/documents/${pending.id}/post`, {}],
      ] as const) {
        const denied = await request(path, { method: "POST", cookie, body });
        assert.equal(denied.response.status, 400);
        assert.match(denied.data.message, /Accounting permission is required/);
      }
      await setAccounting(true);
      const enabledActor = await ok("/api/auth/user", { cookie });
      assert.ok(enabledActor.permissions.includes("accounting.manage"));
      assert.equal(
        (
          await ok(`${prefix}/documents/${pending.id}/post`, {
            method: "POST",
            cookie,
            body: {},
          })
        ).status,
        "posted",
      );
      assert.equal((await create()).status, "pending");
    });

    test("restricted Finance can purchase assets from assigned cash without gaining company data or manual accounting access", async () => {
      const fixtureCompany = await ok("/api/companies", {
        method: "POST",
        body: { name: "Restricted asset purchasing" },
      });
      const prefix = `/api/c/${fixtureCompany.id}`;
      const master = (table: string, body: any) =>
        ok(`${prefix}/${table}`, { method: "POST", body });
      const setup = await ok(`${prefix}/bootstrap`);
      const fixedAsset = setup.accounts.find(
        (a: any) => a.purpose === "fixed_asset",
      );
      const office = setup.accounts.find((a: any) => a.purpose === "office");
      const payroll = setup.accounts.find(
        (a: any) => a.purpose === "employee_expense",
      );
      const custodian = await master("contacts", {
        name: "Asset buyer",
        kind: "employee",
      });
      const colleague = await master("contacts", {
        name: "Other asset buyer",
        kind: "employee",
      });
      const vendor = await master("contacts", {
        name: "Hardware supplier",
        kind: "vendor",
        bank_details: "CONFIDENTIAL VENDOR BANK",
      });
      const bankAccount = await master("accounts", {
        code: "CAPITAL-BANK",
        name: "CONFIDENTIAL COMPANY BANK",
        type: "asset",
        purpose: "bank",
      });
      const cash = await master("accounts", {
        code: "CAPITAL-CASH",
        name: "Asset buyer cash",
        type: "asset",
        purpose: "cash",
        custodian_id: custodian.id,
      });
      const otherCash = await master("accounts", {
        code: "CAPITAL-OTHER",
        name: "CONFIDENTIAL OTHER CASH",
        type: "asset",
        purpose: "cash",
        custodian_id: colleague.id,
      });
      const adminPost = async (body: any) => {
        const doc = await master("documents", {
          date: "2026-10-01",
          description: "Asset purchase fixture funding",
          ...body,
        });
        await ok(`${prefix}/documents/${doc.id}/post`, {
          method: "POST",
          body: {},
        });
        return doc;
      };
      await adminPost({
        kind: "opening",
        amount: "50000",
        targetId: bankAccount.id,
      });
      await adminPost({
        kind: "withdrawal",
        amount: "10000",
        sourceId: bankAccount.id,
        targetId: cash.id,
      });
      await adminPost({
        kind: "withdrawal",
        amount: "5000",
        sourceId: bankAccount.id,
        targetId: otherCash.id,
      });
      const profile = {
        username: "http_restricted_asset_buyer",
        full_name: "Restricted asset buyer",
        role_id: roles.find((r) => r.name === "finance").id,
        active: true,
        companies: [fixtureCompany.id],
        data_scope: "own",
        employee_links: [
          { company_id: fixtureCompany.id, contact_id: custodian.id },
        ],
      };
      const user = await ok("/api/admin/users", {
        method: "POST",
        body: {
          ...profile,
          password,
          overrides: { "transactions.post": false },
        },
      });
      const cookie = await login(profile.username);
      const setAccess = (
        purchase: boolean,
        post: boolean,
        employee_links = profile.employee_links,
      ) =>
        ok("/api/admin/users", {
          method: "POST",
          body: {
            ...profile,
            id: user.id,
            employee_links,
            overrides: {
              "transactions.purchase_assets": purchase,
              "transactions.post": post,
            },
          },
        });
      const input = {
        kind: "capital_purchase",
        date: "2026-10-02",
        amount: "1000",
        sourceId: cash.id,
        contactId: vendor.id,
        description: "Workstation bought with my assigned cash",
      };
      const create = (overrides: any = {}) =>
        ok(`${prefix}/documents`, {
          method: "POST",
          cookie,
          body: { ...input, ...overrides },
        });
      const denied = async (
        path: string,
        options: Parameters<typeof request>[1] = {},
        expected = [400, 403, 410],
      ) => {
        const response = await request(path, { cookie, ...options });
        assert.ok(
          expected.includes(response.response.status),
          `${path}: expected rejection, got ${response.response.status}: ${JSON.stringify(response.data)}`,
        );
        return response;
      };
      const defaultActor = await ok("/api/auth/user", { cookie });
      assert.equal(defaultActor.dataScope, "own");
      assert.ok(
        !defaultActor.permissions.includes("transactions.purchase_assets"),
        "Asset purchasing is explicitly granted, not inherited automatically",
      );
      await denied(
        `${prefix}/documents`,
        { method: "POST", body: input },
        [403],
      );
      await setAccess(true, false);
      const actor = await ok("/api/auth/user", { cookie });
      assert.ok(actor.permissions.includes("transactions.purchase_assets"));
      for (const permission of [
        "accounting.manage",
        "reports.view",
        "masters.manage",
        "users.manage",
      ])
        assert.ok(
          !actor.permissions.includes(permission),
          `${permission} remains outside own-data access`,
        );
      const ownSetup = await ok(`${prefix}/bootstrap`, { cookie });
      assert.ok(ownSetup.accounts.some((a: any) => a.id === cash.id));
      assert.ok(
        ownSetup.accounts.every(
          (a: any) =>
            a.id === cash.id || (a.type === "expense" && !a.restricted),
        ),
      );
      assert.ok(
        !ownSetup.accounts.some((a: any) =>
          [fixedAsset.id, bankAccount.id, otherCash.id, payroll.id].includes(
            a.id,
          ),
        ),
      );
      assert.doesNotMatch(JSON.stringify(ownSetup), /CONFIDENTIAL/);
      const purchase = await create();
      assert.equal(purchase.status, "pending");
      assert.equal(
        purchase.head_id,
        null,
        "The business action chooses its asset account internally",
      );
      await ok(`${prefix}/documents/${purchase.id}`, {
        method: "PATCH",
        cookie,
        body: { ...input, reference: "ASSET-RECEIPT-1" },
      });
      const receipt = new FormData();
      receipt.append(
        "files",
        new Blob(["%PDF-1.4\n%%EOF"], { type: "application/pdf" }),
        "workstation-receipt.pdf",
      );
      await ok(`${prefix}/documents/${purchase.id}/attachments`, {
        method: "POST",
        cookie,
        body: receipt,
      });
      const attachments = await ok(
        `${prefix}/documents/${purchase.id}/attachments`,
        { cookie },
      );
      assert.equal(attachments.length, 1);
      assert.equal(
        (
          await request(
            `${prefix}/documents/${purchase.id}/attachments/${attachments[0].id}`,
            { cookie },
          )
        ).response.status,
        200,
      );
      for (const changes of [
        { sourceId: bankAccount.id },
        { sourceId: otherCash.id },
        { sourceId: null },
        { headId: fixedAsset.id },
        { headId: office.id },
        { headId: payroll.id },
        { targetId: cash.id },
        { categoryId: ownSetup.categories[0].id },
        { relatedId: purchase.id },
        { otherCompanyId: otherCompany },
        { contactId: colleague.id },
        { assetName: "Old asset module" },
      ]) {
        await denied(`${prefix}/documents`, {
          method: "POST",
          body: { ...input, ...changes },
        });
        await denied(`${prefix}/documents/${purchase.id}`, {
          method: "PATCH",
          body: { ...input, ...changes },
        });
      }
      await denied(`${prefix}/documents`, {
        method: "POST",
        body: { ...input, kind: "adjustment", targetId: fixedAsset.id },
      });
      for (const path of [
        `${prefix}/reports`,
        "/api/admin",
        `${prefix}/accounts`,
      ])
        await denied(path);
      await denied(
        `${prefix}/documents/${purchase.id}/post`,
        { method: "POST", body: {} },
        [403],
      );
      await setAccess(true, true);
      const posted = await ok(`${prefix}/documents/${purchase.id}/post`, {
        method: "POST",
        cookie,
        body: {},
      });
      assert.equal(posted.status, "posted");
      const lines = (
        await control.query(
          `SELECT l.account_id,l.debit,l.credit FROM ${schema}.journal_lines l JOIN ${schema}.journals j ON j.id=l.journal_id WHERE j.document_id=$1 ORDER BY l.account_id`,
          [purchase.id],
        )
      ).rows;
      assert.deepEqual(lines, [
        { account_id: fixedAsset.id, debit: "1000.00", credit: "0.00" },
        { account_id: cash.id, debit: "0.00", credit: "1000.00" },
      ]);
      const ownBalances = await ok(`${prefix}/my-cash`, { cookie });
      assert.equal(
        ownBalances.find((a: any) => a.id === cash.id).balance,
        "9000.00",
      );
      const report = await ok(
        `${prefix}/reports?from=2026-10-01&to=2026-10-31`,
      );
      assert.equal(report.summary.expenses, "0.00");
      assert.equal(report.summary.profit, "0.00");
      assert.equal(
        report.cashFlow.find((row: any) => row.id === "Investing").balance,
        "-1000.00",
      );
      assert.equal(
        Number(
          (
            await control.query(
              `SELECT count(*) FROM ${schema}.assets WHERE company_id=$1`,
              [fixtureCompany.id],
            )
          ).rows[0].count,
        ),
        0,
      );
      const ledger = await ok(`${prefix}/documents/${purchase.id}/ledger`, {
        cookie,
      });
      assert.equal(ledger.journals.length, 1);
      assert.equal(ledger.journals[0].lines.length, 2);
      const assetLine = ledger.journals[0].lines.find(
        (line: any) => line.debit === "1000.00",
      );
      assert.equal(assetLine.account_id, null);
      assert.equal(assetLine.account_code, null);
      assert.equal(assetLine.account_name, "Fixed assets");
      assert.equal(
        ledger.journals[0].lines.find(
          (line: any) => line.account_id === cash.id,
        ).credit,
        "1000.00",
      );
      assert.doesNotMatch(
        JSON.stringify(ledger),
        /CONFIDENTIAL|CAPITAL-BANK|CAPITAL-OTHER|contact_id|company_id/,
      );
      const peerPurchase = await master("documents", {
        ...input,
        sourceId: otherCash.id,
        description: "CONFIDENTIAL PEER PURCHASE",
      });
      const listed = await ok(`${prefix}/documents`, { cookie });
      assert.ok(
        listed.some(
          (d: any) => d.id === purchase.id && !d.retired && d.can_manage,
        ),
      );
      assert.ok(!listed.some((d: any) => d.id === peerPurchase.id));
      assert.doesNotMatch(JSON.stringify(listed), /CONFIDENTIAL/);
      await denied(`${prefix}/documents/${peerPurchase.id}/ledger`);
      await denied(`${prefix}/documents/${peerPurchase.id}/attachments`);

      const pending = await create({ amount: "100" });
      const cancellable = await create({ amount: "100" });
      await setAccess(false, true);
      const revoked = await ok("/api/auth/user", { cookie });
      assert.ok(!revoked.permissions.includes("transactions.purchase_assets"));
      const retained = await ok(`${prefix}/documents`, { cookie });
      assert.ok(retained.some((d: any) => d.id === purchase.id));
      assert.ok(retained.some((d: any) => d.id === pending.id));
      await denied(
        `${prefix}/documents`,
        { method: "POST", body: input },
        [403],
      );
      await denied(
        `${prefix}/documents/${pending.id}`,
        {
          method: "PATCH",
          body: { ...input, kind: "expense", headId: office.id },
        },
        [403],
      );
      await denied(
        `${prefix}/documents/${pending.id}/post`,
        { method: "POST", body: {} },
        [403],
      );
      await denied(
        `${prefix}/documents/${purchase.id}/reverse`,
        { method: "POST", body: { date: "2026-10-03" } },
        [403],
      );
      const bulkDenied = await ok(`${prefix}/documents/bulk-post`, {
        method: "POST",
        cookie,
        body: { ids: [pending.id] },
      });
      assert.equal(bulkDenied.failed, 1);
      assert.equal(bulkDenied.posted, 0);
      await ok(`${prefix}/documents/${cancellable.id}/cancel`, {
        method: "POST",
        cookie,
        body: {},
      });
      await setAccess(true, true);
      const bulkPosted = await ok(`${prefix}/documents/bulk-post`, {
        method: "POST",
        cookie,
        body: { ids: [pending.id] },
      });
      assert.equal(bulkPosted.posted, 1);
      await ok(`${prefix}/documents/${pending.id}/reverse`, {
        method: "POST",
        cookie,
        body: { date: "2026-10-03" },
      });
      const reassigned = await create({ amount: "100" });
      await setAccess(true, true, []);
      await denied(
        `${prefix}/documents/${reassigned.id}/post`,
        { method: "POST", body: {} },
        [403],
      );
      await denied(`${prefix}/documents/${purchase.id}/ledger`, {}, [403]);
      assert.ok(
        !(await ok(`${prefix}/documents`, { cookie })).some((d: any) =>
          [purchase.id, reassigned.id].includes(d.id),
        ),
        "Removing the cash assignment removes access even to self-created capital purchases",
      );
      assert.equal(
        (
          await control.query(
            `SELECT status FROM ${schema}.documents WHERE id=$1`,
            [reassigned.id],
          )
        ).rows[0].status,
        "pending",
      );
    });

    test("explicit own-data scope restricts financial data and actions even with broad permissions", async () => {
      const ownCompany = await ok("/api/companies", {
        method: "POST",
        body: { name: "Own-data isolation company" },
      });
      const prefix = `/api/c/${ownCompany.id}`;
      await ok(`/api/companies/${ownCompany.id}`, {
        method: "PATCH",
        body: { name: ownCompany.name, approvals: false, locked_through: null },
      });
      const setup = await ok(`${prefix}/bootstrap`);
      const purpose = (value: string) =>
        setup.accounts.find((a: any) => a.purpose === value).id;
      const master = (table: string, body: any) =>
        ok(`${prefix}/${table}`, { method: "POST", body });
      const employee = await master("contacts", {
        name: "Linked custodian",
        kind: "employee",
        bank_details: "PRIVATE EMPLOYEE BANK",
      });
      const colleague = await master("contacts", {
        name: "Other custodian",
        kind: "employee",
      });
      const vendor = await master("contacts", {
        name: "Public vendor name",
        kind: "vendor",
        tax_number: "PRIVATE TAX",
        bank_details: "PRIVATE VENDOR BANK",
      });
      const customer = await master("contacts", {
        name: "Private customer",
        kind: "customer",
      });
      const ownBank = await master("accounts", {
        code: "SCOPE-BANK",
        name: "Private bank",
        type: "asset",
        purpose: "bank",
      });
      const cash = await master("accounts", {
        code: "SCOPE-CASH",
        name: "Linked cash",
        type: "asset",
        purpose: "cash",
        custodian_id: employee.id,
      });
      const cash2 = await master("accounts", {
        code: "SCOPE-CASH2",
        name: "Linked travel cash",
        type: "asset",
        purpose: "cash",
        custodian_id: employee.id,
      });
      const otherCash = await master("accounts", {
        code: "SCOPE-OTHER",
        name: "Other cash",
        type: "asset",
        purpose: "cash",
        custodian_id: colleague.id,
      });
      const payroll = purpose("employee_expense");
      assert.equal(
        setup.accounts.find((a: any) => a.id === payroll).restricted,
        true,
      );
      const privateCategory = await master("categories", {
        name: "Private payroll category",
        account_id: payroll,
      });
      const officeCategory = await master("categories", {
        name: "Public office category",
        account_id: purpose("office"),
      });
      const adminSettings = await ok("/api/admin");
      const allPermissions = Object.fromEntries(
        adminSettings.permissions.map((p: string) => [p, true]),
      );
      const profile: any = {
        username: "http_own_data",
        full_name: "Own-data user",
        password,
        role_id: roles.find((r) => r.name === "finance").id,
        active: true,
        companies: [ownCompany.id],
        overrides: allPermissions,
        data_scope: "company",
        employee_links: [
          { company_id: ownCompany.id, contact_id: employee.id },
        ],
      };
      const ownUser = await ok("/api/admin/users", {
        method: "POST",
        body: profile,
      });
      delete profile.password;
      profile.id = ownUser.id;
      let ownCookie = await login(profile.username);
      const create = (body: any, cookie = adminCookie) =>
        ok(`${prefix}/documents`, {
          method: "POST",
          cookie,
          body: {
            date: "2026-10-10",
            amount: "100",
            description: "Scope fixture",
            ...body,
          },
        });
      const action = (doc: any, operation: string, cookie = adminCookie) =>
        ok(`${prefix}/documents/${doc.id}/${operation}`, {
          method: "POST",
          cookie,
          body: operation === "reverse" ? { date: "2026-10-11" } : {},
        });
      const posted = async (body: any, cookie = adminCookie) => {
        const doc = await create(body, cookie);
        await action(doc, "post", cookie);
        return doc;
      };
      await posted({ kind: "opening", targetId: ownBank.id, amount: "100000" });
      const deposit = await posted({
        kind: "withdrawal",
        sourceId: ownBank.id,
        targetId: cash.id,
        amount: "1000",
      });
      const otherDeposit = await posted({
        kind: "withdrawal",
        sourceId: ownBank.id,
        targetId: otherCash.id,
        amount: "500",
      });
      const salary = await posted({
        kind: "expense",
        sourceId: cash.id,
        categoryId: privateCategory.id,
        contactId: employee.id,
        description: "PRIVATE SALARY DETAILS",
      });
      const income = await posted(
        {
          kind: "receipt",
          targetId: ownBank.id,
          headId: purpose("revenue"),
          contactId: customer.id,
          description: "PRIVATE CLIENT INCOME",
        },
        ownCookie,
      );
      const oldDraft = await create(
        {
          kind: "expense",
          sourceId: ownBank.id,
          headId: purpose("office"),
          description: "Draft made before restriction",
        },
        ownCookie,
      );
      const financeDraft = await create({
        kind: "expense",
        sourceId: cash.id,
        headId: purpose("office"),
        description: "Finance-authored assigned cash expense",
      });
      const attach = async (doc: any, filename: string) => {
        const form = new FormData();
        form.append(
          "files",
          new Blob(["%PDF-1.4\n%%EOF"], { type: "application/pdf" }),
          filename,
        );
        await ok(`${prefix}/documents/${doc.id}/attachments`, {
          method: "POST",
          body: form,
        });
        return (await ok(`${prefix}/documents/${doc.id}/attachments`))[0];
      };
      const ownAttachment = await attach(deposit, "cash-funding.pdf");
      const privateAttachment = await attach(salary, "private-payroll.pdf");
      await ok("/api/admin/users", {
        method: "POST",
        body: { ...profile, data_scope: "own" },
      });
      const linkedAdmin = await ok("/api/admin");
      assert.equal(
        linkedAdmin.users.find((u: any) => u.id === ownUser.id).data_scope,
        "own",
      );
      assert.ok(
        linkedAdmin.employeeLinks.some(
          (link: any) =>
            link.user_id === ownUser.id &&
            link.company_id === ownCompany.id &&
            link.contact_id === employee.id,
        ),
      );
      assert.ok(
        linkedAdmin.employees.some(
          (contact: any) => contact.id === employee.id,
        ),
      );
      const denied = async (
        path: string,
        options: Parameters<typeof request>[1] = {},
      ) => {
        const result = await request(path, { cookie: ownCookie, ...options });
        assert.ok(
          [400, 403, 410].includes(result.response.status),
          `${path} must reject own-data access, got ${result.response.status}`,
        );
      };
      const actor = await ok("/api/auth/user", { cookie: ownCookie });
      assert.equal(actor.dataScope, "own");
      assert.ok(actor.permissions.includes("transactions.post"));
      for (const permission of [
        "reports.view",
        "dashboard.view",
        "audit.view",
        "accounting.manage",
        "masters.manage",
        "users.manage",
      ])
        assert.ok(
          !actor.permissions.includes(permission),
          `${permission} is removed from explicit own scope`,
        );
      const ownSetup = await ok(`${prefix}/bootstrap`, { cookie: ownCookie });
      assert.ok(ownSetup.accounts.some((a: any) => a.id === cash.id));
      assert.ok(ownSetup.accounts.some((a: any) => a.id === cash2.id));
      assert.ok(
        ownSetup.accounts.every(
          (a: any) =>
            [cash.id, cash2.id].includes(a.id) ||
            (a.type === "expense" && !a.restricted),
        ),
      );
      assert.ok(
        !ownSetup.accounts.some((a: any) =>
          [ownBank.id, otherCash.id, payroll].includes(a.id),
        ),
      );
      assert.ok(
        ownSetup.categories.some((c: any) => c.id === officeCategory.id),
      );
      assert.ok(
        !ownSetup.categories.some((c: any) => c.id === privateCategory.id),
      );
      assert.ok(ownSetup.contacts.some((c: any) => c.id === employee.id));
      assert.ok(ownSetup.contacts.some((c: any) => c.id === vendor.id));
      assert.ok(
        !ownSetup.contacts.some((c: any) =>
          [colleague.id, customer.id].includes(c.id),
        ),
      );
      assert.doesNotMatch(
        JSON.stringify(ownSetup),
        /PRIVATE EMPLOYEE BANK|PRIVATE VENDOR BANK|PRIVATE TAX/,
      );
      const visible = await ok(`${prefix}/documents`, { cookie: ownCookie });
      for (const doc of [deposit]) {
        const found = visible.find((d: any) => d.id === doc.id);
        assert.ok(
          found,
          "Finance-created deposits stay visible to their custodian",
        );
        assert.equal(found.can_manage, false);
        assert.ok(found.source_id == null, "A private bank source is redacted");
      }
      for (const doc of [otherDeposit, salary, income])
        assert.ok(
          !visible.some((d: any) => d.id === doc.id),
          "Payroll, income and another employee's transactions stay hidden",
        );
      assert.doesNotMatch(
        JSON.stringify(visible),
        /PRIVATE SALARY DETAILS|PRIVATE CLIENT INCOME/,
      );
      const ownLedger = await ok(`${prefix}/documents/${deposit.id}/ledger`, {
        cookie: ownCookie,
      });
      assert.equal(ownLedger.journals.length, 1);
      assert.equal(ownLedger.journals[0].lines.length, 2);
      const cashLine = ownLedger.journals[0].lines.find(
        (line: any) => line.account_id === cash.id,
      );
      assert.equal(cashLine.account_name, "Linked cash");
      assert.equal(cashLine.account_code, "SCOPE-CASH");
      assert.equal(cashLine.debit, "1000.00");
      const hiddenLine = ownLedger.journals[0].lines.find(
        (line: any) => line.account_id === null,
      );
      assert.equal(hiddenLine.account_code, null);
      assert.equal(hiddenLine.account_name, "Other account");
      assert.equal(hiddenLine.credit, "1000.00");
      assert.doesNotMatch(
        JSON.stringify(ownLedger),
        /Private bank|SCOPE-BANK|contact_id|company_id/,
      );
      for (const doc of [otherDeposit, salary, income])
        await denied(`${prefix}/documents/${doc.id}/ledger`);
      assert.deepEqual(
        await ok(`${prefix}/documents/${financeDraft.id}/ledger`, {
          cookie: ownCookie,
        }),
        { journals: [] },
      );
      const ownBalances = await ok(`${prefix}/my-cash`, { cookie: ownCookie });
      assert.deepEqual(
        ownBalances.map((a: any) => a.id).sort((a: number, b: number) => a - b),
        [cash.id, cash2.id],
      );
      assert.equal(
        ownBalances.find((a: any) => a.id === cash.id).balance,
        "900.00",
      );
      assert.equal(
        Number(ownBalances.find((a: any) => a.id === cash2.id).balance),
        0,
      );
      const safeDownload = `${prefix}/documents/${deposit.id}/attachments/${ownAttachment.id}`;
      assert.equal(
        (await request(safeDownload, { cookie: ownCookie })).response.status,
        200,
      );
      await denied(`${prefix}/documents/${salary.id}/attachments`);
      await denied(
        `${prefix}/documents/${salary.id}/attachments/${privateAttachment.id}`,
      );
      await denied(
        `${prefix}/documents/${deposit.id}/attachments/${privateAttachment.id}`,
      );
      await ok(`${prefix}/categories/${privateCategory.id}`, {
        method: "PATCH",
        body: { name: privateCategory.name, account_id: purpose("office") },
      });
      assert.ok(
        !(await ok(`${prefix}/documents`, { cookie: ownCookie })).some(
          (d: any) => d.id === salary.id,
        ),
        "Historical private ledger accounts remain private after category remapping",
      );
      await denied(`${prefix}/documents/${salary.id}/ledger`);
      await denied(
        `${prefix}/documents/${salary.id}/attachments/${privateAttachment.id}`,
      );
      await ok(`${prefix}/categories/${privateCategory.id}`, {
        method: "PATCH",
        body: { name: privateCategory.name, account_id: payroll },
      });
      const forbiddenUpload = new FormData();
      forbiddenUpload.append(
        "files",
        new Blob(["%PDF-1.4\n%%EOF"], { type: "application/pdf" }),
        "forbidden.pdf",
      );
      await denied(`${prefix}/documents/${deposit.id}/attachments`, {
        method: "POST",
        body: forbiddenUpload,
      });
      for (const path of [
        `${prefix}/reports`,
        `${prefix}/audit`,
        `${prefix}/assets`,
        `${prefix}/reconciliation`,
        "/api/admin",
      ])
        await denied(path);
      await denied(`${prefix}/projects`, {
        method: "POST",
        body: { name: "Forbidden master" },
      });
      await denied(`/api/c/${company}/documents`);
      await denied(`/api/c/${company}/my-cash`);
      const countBefore = (
        await control.query(
          `SELECT count(*)::integer count FROM ${schema}.documents WHERE company_id=$1`,
          [ownCompany.id],
        )
      ).rows[0].count;
      const forged = [
        { kind: "receipt", targetId: cash.id, headId: purpose("revenue") },
        { kind: "withdrawal", sourceId: ownBank.id, targetId: cash.id },
        { kind: "expense", sourceId: ownBank.id, headId: purpose("office") },
        { kind: "expense", sourceId: otherCash.id, headId: purpose("office") },
        { kind: "expense", sourceId: cash.id, headId: payroll },
        {
          kind: "expense",
          sourceId: cash.id,
          headId: purpose("office"),
          categoryId: privateCategory.id,
        },
        { kind: "advance", sourceId: ownBank.id, contactId: employee.id },
        { kind: "advance", contactId: colleague.id },
        {
          kind: "advance_expense",
          relatedId: deposit.id,
          contactId: employee.id,
          headId: purpose("office"),
        },
        {
          kind: "advance_return",
          relatedId: deposit.id,
          contactId: employee.id,
          targetId: ownBank.id,
        },
        { kind: "transfer", sourceId: cash.id, targetId: otherCash.id },
      ];
      for (const body of forged)
        await denied(`${prefix}/documents`, {
          method: "POST",
          body: {
            date: "2026-10-10",
            amount: "10",
            description: "Forged own-scope input",
            ...body,
          },
        });
      assert.equal(
        (
          await control.query(
            `SELECT count(*)::integer count FROM ${schema}.documents WHERE company_id=$1`,
            [ownCompany.id],
          )
        ).rows[0].count,
        countBefore,
      );
      for (const operation of ["post", "reverse"])
        await denied(`${prefix}/documents/${deposit.id}/${operation}`, {
          method: "POST",
          body: { date: "2026-10-11" },
        });
      for (const operation of ["post", "cancel"])
        await denied(`${prefix}/documents/${financeDraft.id}/${operation}`, {
          method: "POST",
          body: {},
        });
      await denied(`${prefix}/documents/${oldDraft.id}/post`, {
        method: "POST",
        body: {},
      });
      const expense = await create(
        {
          kind: "expense",
          sourceId: cash.id,
          categoryId: officeCategory.id,
          contactId: vendor.id,
          amount: "25",
        },
        ownCookie,
      );
      for (const operation of ["post"])
        await action(expense, operation, ownCookie);
      const ownExpense = (
        await ok(`${prefix}/documents`, { cookie: ownCookie })
      ).find((d: any) => d.id === expense.id);
      assert.equal(ownExpense.can_manage, true);
      assert.equal(ownExpense.status, "posted");
      assert.equal(ownExpense.approved_by, null);
      const bulkExpense = await create(
        {
          kind: "expense",
          sourceId: cash.id,
          categoryId: officeCategory.id,
          amount: "10",
        },
        ownCookie,
      );
      const bulk = await ok(`${prefix}/documents/bulk-post`, {
        method: "POST",
        cookie: ownCookie,
        body: {
          ids: [
            salary.id,
            income.id,
            financeDraft.id,
            oldDraft.id,
            bulkExpense.id,
          ],
        },
      });
      assert.equal(bulk.posted, 1);
      assert.equal(bulk.failed, 4);
      assert.equal(bulk.alreadyPosted, 0);
      assert.deepEqual(
        bulk.results.map((r: any) => [r.id, r.status]),
        [
          [salary.id, "failed"],
          [income.id, "failed"],
          [financeDraft.id, "failed"],
          [oldDraft.id, "failed"],
          [bulkExpense.id, "posted"],
        ],
      );
      assert.doesNotMatch(
        JSON.stringify(bulk),
        /PRIVATE SALARY DETAILS|PRIVATE CLIENT INCOME/,
      );
      for (const row of bulk.results.slice(0, 3))
        assert.equal(row.message, "Transaction not found or unavailable");
      assert.deepEqual(
        (
          await control.query(
            `SELECT status FROM ${schema}.documents WHERE id=ANY($1::integer[]) ORDER BY id`,
            [[financeDraft.id, oldDraft.id]],
          )
        ).rows.map((r: any) => r.status),
        ["pending", "pending"],
      );
      await posted(
        {
          kind: "transfer",
          sourceId: cash.id,
          targetId: cash2.id,
          amount: "25",
        },
        ownCookie,
      );
      await ok("/api/admin/users", {
        method: "POST",
        body: { ...profile, data_scope: "own", active: false },
      });
      assert.equal(
        (await request(`${prefix}/documents`, { cookie: ownCookie })).response
          .status,
        401,
      );
      await ok("/api/admin/users", {
        method: "POST",
        body: { ...profile, data_scope: "own", active: true },
      });
      ownCookie = await login(profile.username);
      assert.equal(
        (await ok("/api/auth/user", { cookie: ownCookie })).dataScope,
        "own",
      );
      await denied(`${prefix}/reports`);
      assert.ok(
        !(await ok(`${prefix}/documents`, { cookie: ownCookie })).some(
          (d: any) => d.id === income.id,
        ),
      );
      await ok("/api/admin/users", {
        method: "POST",
        body: {
          ...profile,
          data_scope: null,
          role_id: roles.find((r) => r.name === "employee").id,
        },
      });
      const defaultEmployee = await ok("/api/auth/user", { cookie: ownCookie });
      assert.equal(
        defaultEmployee.dataScope,
        "own",
        "Employees default to own data even with posting permission",
      );
      assert.ok(defaultEmployee.permissions.includes("transactions.post"));
      assert.ok(
        !(await ok(`${prefix}/documents`, { cookie: ownCookie })).some(
          (d: any) => d.id === income.id,
        ),
      );
    });

    test("permission revocation and account disable take effect for existing sessions", async () => {
      await ok("/api/admin/users", {
        method: "POST",
        body: {
          id: viewerId,
          username: "http_viewer",
          full_name: "http_viewer",
          role_id: roles.find((r) => r.name === "viewer").id,
          active: true,
          companies: [company],
          overrides: { "transactions.view": false },
        },
      });
      assert.equal(
        (await request(`/api/c/${company}/documents`, { cookie: viewerCookie }))
          .response.status,
        403,
      );
      await ok("/api/admin/users", {
        method: "POST",
        body: {
          id: employeeId,
          username: "http_employee",
          full_name: "http_employee",
          role_id: roles.find((r) => r.name === "employee").id,
          active: false,
          companies: [company],
          overrides: {},
        },
      });
      assert.equal(
        (await request("/api/auth/user", { cookie: employeeCookie })).response
          .status,
        401,
      );
      assert.equal(
        (
          await request(`/api/c/${company}/documents`, {
            cookie: employeeCookie,
          })
        ).response.status,
        401,
      );
      assert.equal(
        (
          await request("/api/login", {
            method: "POST",
            body: { username: "http_employee", password },
          })
        ).response.status,
        401,
      );
    });

    test("bulk posting rejects invalid selections before changing documents", async () => {
      const document = await createPending({
        kind: "expense",
        date: "2026-10-03",
        amount: "20",
        description: "Bulk validation fixture",
        sourceId: bank,
        headId: head,
      });
      for (const body of [
        {},
        { ids: [] },
        { ids: [document.id, document.id] },
        { ids: [document.id, 0] },
        { ids: [document.id, -1] },
        { ids: [document.id, 1.5] },
        { ids: [document.id, String(document.id)] },
        { ids: [document.id, Number.MAX_SAFE_INTEGER + 1] },
        { ids: Array.from({ length: 101 }, (_, i) => i + 1) },
      ]) {
        const result = await request(`/api/c/${company}/documents/bulk-post`, {
          method: "POST",
          cookie: adminCookie,
          body,
        });
        assert.equal(result.response.status, 400, JSON.stringify(body));
      }
      assert.equal(
        (
          await control.query(
            `SELECT status FROM ${schema}.documents WHERE id=$1`,
            [document.id],
          )
        ).rows[0].status,
        "pending",
      );
      assert.equal(
        (
          await control.query(
            `SELECT count(*) FROM ${schema}.journals WHERE document_id=$1`,
            [document.id],
          )
        ).rows[0].count,
        "0",
      );
    });

    test("concurrent bulk posting and retries create one balanced journal and audit per document", async () => {
      const documents = [];
      for (const amount of ["35", "45"])
        documents.push(
          await createPending({
            kind: "expense",
            date: "2026-10-03",
            amount,
            description: "Bulk retry fixture",
            sourceId: bank,
            headId: head,
          }),
        );
      const ids = documents.map((d) => d.id).reverse();
      const send = () =>
        ok(`/api/c/${company}/documents/bulk-post`, {
          method: "POST",
          body: { ids },
        });
      const concurrent = await Promise.all([send(), send()]);
      assert.equal(
        concurrent.reduce((n, r) => n + r.posted, 0),
        2,
      );
      assert.equal(
        concurrent.reduce((n, r) => n + r.alreadyPosted, 0),
        2,
      );
      for (const result of concurrent) {
        assert.equal(result.failed, 0);
        assert.deepEqual(
          result.results.map((r: any) => r.id),
          ids,
        );
      }
      const retry = await send();
      assert.equal(retry.posted, 0);
      assert.equal(retry.alreadyPosted, 2);
      assert.equal(retry.failed, 0);
      assert.deepEqual(
        retry.results.map((r: any) => r.status),
        ["already_posted", "already_posted"],
      );
      const journals = await control.query(
        `SELECT j.document_id,count(l.id)::integer lines,sum(l.debit)::text debit,sum(l.credit)::text credit
         FROM ${schema}.journals j JOIN ${schema}.journal_lines l ON l.journal_id=j.id
         WHERE j.document_id=ANY($1::integer[]) GROUP BY j.id ORDER BY j.document_id`,
        [ids],
      );
      assert.equal(journals.rows.length, 2);
      for (const row of journals.rows) {
        assert.equal(row.lines, 2);
        assert.equal(row.debit, row.credit);
        assert.ok(Number(row.debit) > 0);
      }
      const audits = await control.query(
        `SELECT entity_id,count(*)::integer count FROM ${schema}.audit
         WHERE entity='document' AND action='post' AND entity_id=ANY($1::integer[]) GROUP BY entity_id`,
        [ids],
      );
      assert.equal(audits.rows.length, 2);
      assert.ok(audits.rows.every((r: any) => r.count === 1));
    });

    test("bulk posting isolates locked, invalid, retired, cancelled and foreign-company failures", async () => {
      const isolated = await ok("/api/companies", {
        method: "POST",
        body: { name: "Bulk partial failure company" },
      });
      const prefix = `/api/c/${isolated.id}`;
      const setup = await ok(`${prefix}/bootstrap`);
      const cashAccount = await ok(`${prefix}/accounts`, {
        method: "POST",
        body: {
          code: "BULK-BANK",
          name: "Bulk bank",
          type: "asset",
          purpose: "bank",
        },
      });
      const create = (body: any) =>
        ok(`${prefix}/documents`, {
          method: "POST",
          body: {
            date: "2026-10-10",
            amount: "100",
            description: "Bulk partial failure fixture",
            ...body,
          },
        });
      const valid = await create({ kind: "opening", targetId: cashAccount.id });
      const locked = await create({
        kind: "opening",
        targetId: cashAccount.id,
        date: "2026-10-01",
      });
      const invalid = await create({
        kind: "expense",
        sourceId: cashAccount.id,
      });
      const cancelled = await create({
        kind: "expense",
        sourceId: cashAccount.id,
        headId: setup.accounts.find((a: any) => a.purpose === "office").id,
      });
      await ok(`${prefix}/documents/${cancelled.id}/cancel`, {
        method: "POST",
        body: {},
      });
      const retired = (
        await control.query(
          `INSERT INTO ${schema}.documents(company_id,kind,date,amount,currency,rate,base_amount,description,status,created_by,source_id)
         VALUES($1,'asset_purchase','2026-10-10',10,'PKR',1,10,'Retired bulk fixture','pending',$2,$3) RETURNING id`,
          [
            isolated.id,
            initialAdmin.users.find((u: any) => u.username === "admin").id,
            cashAccount.id,
          ],
        )
      ).rows[0];
      const foreign = await createPending({
        kind: "expense",
        date: "2026-10-03",
        amount: "20",
        description: "Other company selection",
        sourceId: bank,
        headId: head,
      });
      await ok(`/api/companies/${isolated.id}`, {
        method: "PATCH",
        body: {
          name: isolated.name,
          approvals: false,
          locked_through: "2026-10-05",
        },
      });
      const ids = [
        invalid.id,
        locked.id,
        valid.id,
        cancelled.id,
        retired.id,
        foreign.id,
        Number.MAX_SAFE_INTEGER,
      ];
      const bulk = await ok(`${prefix}/documents/bulk-post`, {
        method: "POST",
        body: { ids },
      });
      assert.equal(bulk.posted, 1);
      assert.equal(bulk.alreadyPosted, 0);
      assert.equal(bulk.failed, 6);
      assert.deepEqual(
        bulk.results.map((r: any) => [r.id, r.status]),
        ids.map((id) => [id, id === valid.id ? "posted" : "failed"]),
      );
      assert.equal(
        bulk.results[5].message,
        "Transaction not found or unavailable",
      );
      assert.equal(
        bulk.results[6].message,
        "Transaction not found or unavailable",
      );
      const failedIds = [invalid.id, locked.id, retired.id, foreign.id];
      assert.ok(
        (
          await control.query(
            `SELECT status FROM ${schema}.documents WHERE id=ANY($1::integer[])`,
            [failedIds],
          )
        ).rows.every((r: any) => r.status === "pending"),
      );
      assert.equal(
        (
          await control.query(
            `SELECT count(*) FROM ${schema}.journals WHERE document_id=ANY($1::integer[])`,
            [[...failedIds, cancelled.id]],
          )
        ).rows[0].count,
        "0",
      );
      assert.equal(
        (
          await control.query(
            `SELECT count(*) FROM ${schema}.audit WHERE entity='document' AND action='post' AND entity_id=ANY($1::integer[])`,
            [[...failedIds, cancelled.id]],
          )
        ).rows[0].count,
        "0",
      );
    });

    test("bulk posting processes foreign-currency activity chronologically regardless of selection order", async () => {
      const usd = await ok(`/api/c/${company}/accounts`, {
        method: "POST",
        body: {
          code: "BULK-USD",
          name: "Bulk USD bank",
          type: "asset",
          purpose: "bank",
          currency: "USD",
        },
      });
      const create = (body: any) =>
        createPending({
          currency: "USD",
          rate: "280",
          description: "Bulk currency ordering fixture",
          ...body,
        });
      const later = await create({
        kind: "expense",
        date: "2026-11-03",
        amount: "10",
        sourceId: usd.id,
        headId: head,
      });
      const earlier = await create({
        kind: "expense",
        date: "2026-11-02",
        amount: "20",
        sourceId: usd.id,
        headId: head,
      });
      const opening = await create({
        kind: "opening",
        date: "2026-11-01",
        amount: "100",
        targetId: usd.id,
      });
      const ids = [later.id, opening.id, earlier.id];
      const bulk = await ok(`/api/c/${company}/documents/bulk-post`, {
        method: "POST",
        body: { ids },
      });
      assert.equal(bulk.posted, 3, JSON.stringify(bulk));
      assert.equal(bulk.failed, 0);
      assert.deepEqual(
        bulk.results.map((r: any) => r.id),
        ids,
      );
      assert.deepEqual(
        (
          await control.query(
            `SELECT document_id FROM ${schema}.journals WHERE document_id=ANY($1::integer[]) ORDER BY id`,
            [ids],
          )
        ).rows.map((r: any) => r.document_id),
        [opening.id, earlier.id, later.id],
      );
      const balance = (
        await control.query(
          `SELECT sum(foreign_amount)::text nominal,sum(debit-credit)::text base FROM ${schema}.journal_lines WHERE account_id=$1`,
          [usd.id],
        )
      ).rows[0];
      assert.equal(Number(balance.nominal), 70);
      assert.equal(Number(balance.base), 19600);
    });

    test("concurrent posting is idempotent and creates one journal", async () => {
      const document = await createPending({
        kind: "expense",
        date: "2026-10-03",
        amount: "250",
        description: "Concurrent posting expense",
        sourceId: bank,
        headId: head,
      });
      const attempts = await Promise.all(
        Array.from({ length: 3 }, () =>
          request(`/api/c/${company}/documents/${document.id}/post`, {
            method: "POST",
            cookie: adminCookie,
            body: {},
          }),
        ),
      );
      for (const attempt of attempts)
        assert.equal(
          attempt.response.status,
          200,
          JSON.stringify(attempt.data),
        );
      const report = await ok(
        `/api/c/${company}/reports?from=2026-10-01&to=2026-10-31`,
      );
      for (const retiredReport of [
        "byProject",
        "byEmployee",
        "outstandingAdvances",
      ])
        assert.ok(!Object.hasOwn(report, retiredReport));
      assert.ok(!Object.hasOwn(report.summary, "advances"));
      const lines = report.ledger.filter(
        (line: any) => line.document_id === document.id,
      );
      assert.equal(
        lines.length,
        2,
        "Repeated POSTs create one pair of ledger lines",
      );
      assert.equal(new Set(lines.map((line: any) => line.journal_id)).size, 1);
      assert.equal(
        lines.reduce(
          (total: number, line: any) => total + Number(line.debit),
          0,
        ),
        250,
      );
    });

    test("simultaneous invoice settlements cannot allocate beyond the invoice balance", async () => {
      const customer = await ok(`/api/c/${company}/contacts`, {
        method: "POST",
        body: { name: "Concurrent payment customer", kind: "customer" },
      });
      const bootstrap = await ok(`/api/c/${company}/bootstrap`);
      const revenue = bootstrap.accounts.find(
        (account: any) => account.purpose === "revenue",
      ).id;
      const invoice = await createPending({
        kind: "invoice",
        date: "2026-10-04",
        dueDate: "2026-10-31",
        amount: "1000",
        description: "Concurrency test invoice",
        contactId: customer.id,
        headId: revenue,
      });
      await post(invoice.id);
      const first = await createPending({
        kind: "client_payment",
        date: "2026-10-05",
        amount: "600",
        description: "First concurrent settlement",
        contactId: customer.id,
        relatedId: invoice.id,
        targetId: bank,
      });
      const second = await createPending({
        kind: "client_payment",
        date: "2026-10-05",
        amount: "600",
        description: "Second concurrent settlement",
        contactId: customer.id,
        relatedId: invoice.id,
        targetId: bank,
      });
      const outcomes = await Promise.all(
        [first, second].map((document) =>
          request(`/api/c/${company}/documents/${document.id}/post`, {
            method: "POST",
            cookie: adminCookie,
            body: {},
          }),
        ),
      );
      assert.deepEqual(
        outcomes.map((outcome) => outcome.response.status).sort(),
        [200, 400],
      );
      const rejected = outcomes.find(
        (outcome) => outcome.response.status === 400,
      )!;
      assert.match(rejected.data.message, /exceeds.*outstanding/i);
      const documents = await ok(`/api/c/${company}/documents`);
      assert.equal(
        Number(
          documents.find((document: any) => document.id === invoice.id)
            .allocated,
        ),
        600,
      );
      assert.equal(
        documents.filter(
          (document: any) =>
            [first.id, second.id].includes(document.id) &&
            document.status === "posted",
        ).length,
        1,
      );
      const report = await ok(
        `/api/c/${company}/reports?from=2026-10-01&to=2026-10-31`,
      );
      assert.equal(
        Number(
          report.agingReceivables.find(
            (document: any) => document.id === invoice.id,
          ).outstanding,
        ),
        400,
      );
      assert.equal(
        report.ledger.filter((line: any) =>
          [first.id, second.id].includes(line.document_id),
        ).length,
        2,
      );
    });

    test("password changes revoke all existing sessions and require the new password", async () => {
      const user = await addUser("http_password_user", "viewer");
      const firstSession = await login("http_password_user");
      const secondSession = await login("http_password_user");
      const changedPassword = "Changed-http-test-password-99";
      const invalidChange = await request("/api/auth/change-password", {
        method: "POST",
        cookie: firstSession,
        body: { currentPassword: "incorrect", password: changedPassword },
      });
      assert.equal(invalidChange.response.status, 400);
      await ok("/api/auth/change-password", {
        method: "POST",
        cookie: firstSession,
        body: { currentPassword: password, password: changedPassword },
      });
      for (const cookie of [firstSession, secondSession])
        assert.equal(
          (await request("/api/auth/user", { cookie })).response.status,
          401,
        );
      assert.equal(
        (
          await request("/api/login", {
            method: "POST",
            body: { username: "http_password_user", password },
          })
        ).response.status,
        401,
      );
      const changedSession = await login("http_password_user", changedPassword);
      assert.equal(
        (await ok("/api/auth/user", { cookie: changedSession })).id,
        user.id,
      );
      await ok("/api/admin/users", {
        method: "POST",
        body: {
          id: user.id,
          username: "http_password_user",
          full_name: "http_password_user",
          password,
          role_id: roles.find((role) => role.name === "viewer").id,
          active: true,
          companies: [company],
          overrides: {},
        },
      });
      assert.equal(
        (await request("/api/auth/user", { cookie: changedSession })).response
          .status,
        401,
        "Administrator password reset also invalidates an existing session",
      );
    });

    test("pending transactions can be corrected and posted records require reversal", async () => {
      const body = {
        kind: "expense",
        date: "2026-10-06",
        amount: "75",
        description: "Expense to correct",
        sourceId: bank,
        headId: head,
      };
      const document = await createPending(body);
      const changed = await ok(`/api/c/${company}/documents/${document.id}`, {
        method: "PATCH",
        body: { ...body, amount: "80", description: "Corrected expense" },
      });
      assert.equal(changed.status, "pending");
      assert.equal(Number(changed.amount), 80);
      await post(document.id);
      const denied = await request(
        `/api/c/${company}/documents/${document.id}`,
        {
          method: "PATCH",
          cookie: adminCookie,
          body: { ...body, amount: "999" },
        },
      );
      assert.equal(denied.response.status, 400);
      const unchanged = (await ok(`/api/c/${company}/documents`)).find(
        (d: any) => d.id === document.id,
      );
      assert.equal(unchanged.status, "posted");
      assert.equal(Number(unchanged.amount), 80);
      await ok(`/api/c/${company}/documents/${document.id}/reverse`, {
        method: "POST",
        body: { date: "2026-10-07" },
      });
      const journals = (
        await control.query(
          `SELECT id,reversal_of FROM ${schema}.journals WHERE document_id=$1`,
          [document.id],
        )
      ).rows;
      assert.equal(journals.length, 2);
      assert.ok(journals.some((j) => j.reversal_of));
    });

    test("bootstrap redacts contact tax and banking details without master-data permission", async () => {
      const contact = await ok(`/api/c/${company}/contacts`, {
        method: "POST",
        body: {
          name: "Private vendor",
          kind: "vendor",
          tax_number: "PRIVATE-TAX-42",
          bank_details: "PRIVATE-BANK-42",
          email: "vendor@example.test",
        },
      });
      const adminData = await ok(`/api/c/${company}/bootstrap`);
      const fullContact = adminData.contacts.find(
        (row: any) => row.id === contact.id,
      );
      assert.equal(fullContact.tax_number, "PRIVATE-TAX-42");
      assert.equal(fullContact.bank_details, "PRIVATE-BANK-42");
      const managerData = await ok(`/api/c/${company}/bootstrap`, {
        cookie: managerCookie,
      });
      const redacted = managerData.contacts.find(
        (row: any) => row.id === contact.id,
      );
      assert.equal(redacted.name, "Private vendor");
      assert.ok(!Object.hasOwn(redacted, "tax_number"));
      assert.ok(!Object.hasOwn(redacted, "bank_details"));
      assert.ok(!JSON.stringify(managerData).includes("PRIVATE-BANK-42"));
    });

    test("retired modules cannot create projects, assets, advances, or reconciliation records", async () => {
      for (const [route, method, body] of [
        ["projects", "POST", { name: "Retired project" }],
        ["projects/1", "PATCH", { name: "Retired edit" }],
        ["assets", "GET", undefined],
        ["assets/1/depreciate", "POST", { date: "2026-10-31" }],
        ["reconciliation", "GET", undefined],
        ["reconciliation", "POST", {}],
      ] as const) {
        const result = await request(`/api/c/${company}/${route}`, {
          method,
          cookie: adminCookie,
          body,
        });
        assert.equal(result.response.status, 410, route);
      }
      const before = Number(
        (await control.query(`SELECT count(*) FROM ${schema}.documents`))
          .rows[0].count,
      );
      for (const kind of [
        "advance",
        "advance_expense",
        "advance_return",
        "asset_purchase",
        "depreciation",
      ]) {
        const result = await request(`/api/c/${company}/documents`, {
          method: "POST",
          cookie: adminCookie,
          body: {
            kind,
            date: "2026-10-10",
            amount: "100",
            description: "Retired transaction",
            sourceId: bank,
          },
        });
        assert.ok([400, 410].includes(result.response.status), kind);
      }
      assert.equal(
        Number(
          (await control.query(`SELECT count(*) FROM ${schema}.documents`))
            .rows[0].count,
        ),
        before,
      );
      const projectResult = await request(
        `/api/c/${company}/reports?from=2026-10-01&to=2026-10-31&project=1`,
        { cookie: adminCookie },
      );
      assert.ok([400, 410].includes(projectResult.response.status));
    });

    test("cash custodians retain their employee type and posted balances survive contact edits", async () => {
      const custodian = await ok(`/api/c/${company}/contacts`, {
        method: "POST",
        body: { name: "Cash custodian", kind: "employee" },
      });
      const cash = await ok(`/api/c/${company}/accounts`, {
        method: "POST",
        body: {
          code: "CUSTODY",
          name: "Custodian cash",
          type: "asset",
          purpose: "cash",
          currency: "PKR",
          custodian_id: custodian.id,
        },
      });
      const withdrawal = await createPending({
        kind: "withdrawal",
        date: "2026-10-10",
        amount: "500",
        description: "Cash entrusted to the custodian",
        sourceId: bank,
        targetId: cash.id,
      });
      await post(withdrawal.id);
      const changedType = await request(
        `/api/c/${company}/contacts/${custodian.id}`,
        {
          method: "PATCH",
          cookie: adminCookie,
          body: { name: "Cash custodian", kind: "vendor" },
        },
      );
      assert.equal(
        changedType.response.status,
        400,
        "An assigned custodian must remain an employee even when the withdrawal has no contact field",
      );
      await ok(`/api/c/${company}/contacts/${custodian.id}`, {
        method: "PATCH",
        body: {
          name: "Renamed cash custodian",
          kind: "employee",
          phone: "555-0101",
        },
      });
      const unchanged = (
        await control.query(
          `SELECT c.kind,c.name,sum(l.debit-l.credit)::text balance FROM ${schema}.contacts c JOIN ${schema}.accounts a ON a.custodian_id=c.id JOIN ${schema}.journal_lines l ON l.account_id=a.id WHERE c.id=$1 GROUP BY c.id`,
          [custodian.id],
        )
      ).rows[0];
      assert.equal(unchanged.kind, "employee");
      assert.equal(unchanged.name, "Renamed cash custodian");
      assert.equal(unchanged.balance, "500.00");
    });

    test("shared period access is opt-in, revocable in the same session, and preserves legacy report dates", async () => {
      const fixtureCompany = await ok("/api/companies", {
        method: "POST",
        body: { name: "Period permission fixture" },
      });
      const prefix = `/api/c/${fixtureCompany.id}`;
      const month = "period=month&year=2026&month=11";
      const admin = await ok("/api/auth/user");
      assert.ok(admin.permissions.includes("transactions.view_periods"));
      for (const role of initialAdmin.roles.filter(
        (r: any) => r.name !== "super_admin",
      ))
        assert.ok(
          !role.permissions.includes("transactions.view_periods"),
          role.name,
        );
      const profile = {
        username: "http_period_finance",
        full_name: "Period finance",
        role_id: roles.find((r) => r.name === "finance").id,
        active: true,
        companies: [fixtureCompany.id],
        data_scope: "company",
      };
      const user = await ok("/api/admin/users", {
        method: "POST",
        body: { ...profile, password, overrides: {} },
      });
      const cookie = await login(profile.username);
      const setAccess = (
        enabled: boolean,
        view = true,
        extra: Record<string, boolean> = {},
      ) =>
        ok("/api/admin/users", {
          method: "POST",
          body: {
            ...profile,
            id: user.id,
            overrides: {
              "transactions.view_periods": enabled,
              "transactions.view": view,
              ...extra,
            },
          },
        });
      for (const endpoint of [
        "period-activity",
        "period-balances",
        "reports",
        "my-cash",
      ])
        assert.equal(
          (await request(`${prefix}/${endpoint}?${month}`, { cookie })).response
            .status,
          403,
        );
      await ok(`${prefix}/reports?from=2026-11-01&to=2026-11-30`, { cookie });

      await setAccess(true);
      assert.ok(
        (await ok("/api/auth/user", { cookie })).permissions.includes(
          "transactions.view_periods",
        ),
      );
      assert.deepEqual(
        await ok(`${prefix}/period-activity?${month}`, { cookie }),
        [],
      );
      const calendar = await ok(
        `${prefix}/reports?period=calendar_year&year=2026`,
        { cookie },
      );
      assert.equal(calendar.period.from, "2026-01-01");
      assert.equal(calendar.period.to, "2026-12-31");
      const financial = await ok(
        `${prefix}/reports?period=financial_year&year=2026`,
        { cookie },
      );
      assert.equal(financial.period.from, "2026-07-01");
      assert.equal(financial.period.to, "2027-06-30");
      const leap = await ok(
        `${prefix}/reports?period=month&year=2028&month=2`,
        { cookie },
      );
      assert.equal(leap.period.to, "2028-02-29");
      for (const query of [
        "period=month&year=2026&month=13",
        "period=month&year=2026",
        "period=calendar_year&year=invalid",
        "period=financial_year&year=9999",
        "period=custom&from=2026-02-30&to=2026-03-01",
        "period=custom&from=2026-12-01&to=2026-11-30",
        "period=unknown&year=2026",
      ])
        assert.equal(
          (await request(`${prefix}/reports?${query}`, { cookie })).response
            .status,
          400,
          query,
        );
      assert.equal(
        (await request(`${prefix}/period-activity`, { cookie })).response
          .status,
        400,
      );
      assert.equal(
        (
          await request(`/api/c/${otherCompany}/period-activity?${month}`, {
            cookie,
          })
        ).response.status,
        403,
      );
      const setup = await ok(`${prefix}/bootstrap`);
      const purpose = (value: string) =>
        setup.accounts.find((a: any) => a.purpose === value).id;
      const master = (table: string, body: any) =>
        ok(`${prefix}/${table}`, { method: "POST", body });
      const periodBank = await master("accounts", {
        code: "LIMITED-PERIOD",
        name: "Limited period bank",
        type: "asset",
        purpose: "bank",
      });
      const customer = await master("contacts", {
        name: "Limited period customer",
        kind: "customer",
      });
      const vendor = await master("contacts", {
        name: "Limited period vendor",
        kind: "vendor",
      });
      const posted = async (body: any) => {
        const doc = await master("documents", {
          description: "Limited period balance fixture",
          ...body,
        });
        await ok(`${prefix}/documents/${doc.id}/post`, {
          method: "POST",
          body: {},
        });
        return doc;
      };
      await posted({
        kind: "opening",
        date: "2026-10-31",
        amount: "1000",
        targetId: periodBank.id,
      });
      const invoice = await posted({
        kind: "invoice",
        date: "2026-11-02",
        amount: "100",
        contactId: customer.id,
        headId: purpose("revenue"),
      });
      const bill = await posted({
        kind: "bill",
        date: "2026-11-03",
        amount: "80",
        contactId: vendor.id,
        headId: purpose("office"),
      });
      const limited = {
        "reports.view": false,
        "dashboard.view": false,
        "accounting.manage": false,
      };
      await setAccess(true, true, limited);
      const balances = await ok(`${prefix}/period-balances?${month}`, {
        cookie,
      });
      assert.equal(balances.period.from, "2026-11-01");
      assert.equal(balances.openingSummary.bank, "1000.00");
      assert.equal(balances.summary.bank, "1000.00");
      assert.equal(balances.summary.receivable, "100.00");
      assert.equal(balances.summary.payable, "80.00");
      assert.equal(balances.balances.accounts.length, 1);
      assert.equal(balances.balances.accounts[0].id, periodBank.id);
      assert.equal(balances.balances.accounts[0].opening, "1000.00");
      assert.equal(balances.balances.accounts[0].closing, "1000.00");
      assert.ok(
        balances.balances.accounts.every((a: any) =>
          ["bank", "cash"].includes(a.purpose),
        ),
      );
      assert.ok(
        balances.balances.contacts.every((a: any) =>
          ["receivable", "payable"].includes(a.purpose),
        ),
      );
      assert.equal(
        balances.agingReceivables.find((d: any) => d.id === invoice.id)
          .outstanding,
        "100.00",
      );
      assert.equal(
        balances.agingPayables.find((d: any) => d.id === bill.id).outstanding,
        "80.00",
      );
      const assertLimitedReport = (value: any) => {
        for (const field of [
          "ledger",
          "openingLedger",
          "trial",
          "activity",
          "balanceSheet",
          "cashFlow",
          "byCategory",
        ])
          assert.ok(
            !Object.hasOwn(value, field),
            `${field} requires report access`,
          );
        for (const field of [
          "revenue",
          "expenses",
          "profit",
          "cashFlow",
          "intercompany",
        ])
          assert.ok(
            !Object.hasOwn(value.summary, field),
            `${field} is outside the limited position summary`,
          );
      };
      assertLimitedReport(balances);
      assert.equal(
        (await request(`${prefix}/reports?${month}`, { cookie })).response
          .status,
        403,
      );
      assert.equal(
        (
          await request(`${prefix}/reports?from=2026-11-01&to=2026-11-30`, {
            cookie,
          })
        ).response.status,
        403,
      );
      assert.equal(
        (await request(`${prefix}/period-balances`, { cookie })).response
          .status,
        400,
      );
      assert.equal(
        (
          await request(`/api/c/${otherCompany}/period-balances?${month}`, {
            cookie,
          })
        ).response.status,
        403,
      );
      await setAccess(true, true, { ...limited, "accounting.manage": true });
      const chartBalances = await ok(`${prefix}/period-balances?${month}`, {
        cookie,
      });
      assert.ok(
        chartBalances.balances.accounts.some(
          (a: any) => a.purpose === "revenue",
        ),
      );
      assert.ok(
        chartBalances.balances.accounts.some(
          (a: any) => a.purpose === "office",
        ),
      );
      assertLimitedReport(chartBalances);
      assert.equal(
        (await request(`${prefix}/reports?${month}`, { cookie })).response
          .status,
        403,
      );
      await setAccess(true, false);
      assert.equal(
        (await request(`${prefix}/period-activity?${month}`, { cookie }))
          .response.status,
        403,
        "Period access alone does not grant transaction access",
      );
      assert.equal(
        (await request(`${prefix}/period-balances?${month}`, { cookie }))
          .response.status,
        403,
      );
      await setAccess(false);
      assert.ok(
        !(await ok("/api/auth/user", { cookie })).permissions.includes(
          "transactions.view_periods",
        ),
      );
      assert.equal(
        (await request(`${prefix}/reports?${month}`, { cookie })).response
          .status,
        403,
      );
      assert.equal(
        (await request(`${prefix}/period-balances?${month}`, { cookie }))
          .response.status,
        403,
      );
      await ok(`${prefix}/reports?from=2026-11-01&to=2026-11-30`, { cookie });
    });

    test("period balances carry forward and activity includes cross-month reversals with historical settlements", async () => {
      const fixtureCompany = await ok("/api/companies", {
        method: "POST",
        body: { name: "Period accounting fixture" },
      });
      const prefix = `/api/c/${fixtureCompany.id}`;
      const setup = await ok(`${prefix}/bootstrap`);
      const purpose = (value: string) =>
        setup.accounts.find((a: any) => a.purpose === value).id;
      const master = (table: string, body: any) =>
        ok(`${prefix}/${table}`, { method: "POST", body });
      const bankAccount = await master("accounts", {
        code: "PERIOD-BANK",
        name: "Period bank",
        type: "asset",
        purpose: "bank",
      });
      const customer = await master("contacts", {
        name: "Period customer",
        kind: "customer",
      });
      const vendor = await master("contacts", {
        name: "Period vendor",
        kind: "vendor",
      });
      const create = (body: any) =>
        master("documents", { description: "Period fixture", ...body });
      const posted = async (body: any) => {
        const doc = await create(body);
        await ok(`${prefix}/documents/${doc.id}/post`, {
          method: "POST",
          body: {},
        });
        return doc;
      };
      await posted({
        kind: "opening",
        date: "2026-09-30",
        amount: "50000",
        targetId: bankAccount.id,
      });
      const invoice = await posted({
        kind: "invoice",
        date: "2026-09-29",
        dueDate: "2026-10-10",
        amount: "1000",
        contactId: customer.id,
        headId: purpose("revenue"),
      });
      const receipt = await posted({
        kind: "receipt",
        date: "2026-10-15",
        amount: "20000",
        targetId: bankAccount.id,
        headId: purpose("revenue"),
      });
      const expense = await posted({
        kind: "expense",
        date: "2026-10-16",
        amount: "15000",
        sourceId: bankAccount.id,
        headId: purpose("office"),
      });
      const partial = await posted({
        kind: "client_payment",
        date: "2026-11-05",
        amount: "400",
        targetId: bankAccount.id,
        contactId: customer.id,
        relatedId: invoice.id,
      });
      const bill = await posted({
        kind: "bill",
        date: "2026-11-06",
        amount: "2000",
        headId: purpose("office"),
        contactId: vendor.id,
      });
      const pending = await create({
        kind: "expense",
        date: "2026-11-07",
        amount: "99",
        sourceId: bankAccount.id,
        headId: purpose("office"),
      });
      const cancelled = await create({
        kind: "expense",
        date: "2026-11-08",
        amount: "88",
        sourceId: bankAccount.id,
        headId: purpose("office"),
      });
      await ok(`${prefix}/documents/${cancelled.id}/cancel`, {
        method: "POST",
        body: {},
      });
      await ok(`${prefix}/documents/${expense.id}/reverse`, {
        method: "POST",
        body: { date: "2026-11-10" },
      });
      const laterPayment = await posted({
        kind: "client_payment",
        date: "2026-12-05",
        amount: "600",
        targetId: bankAccount.id,
        contactId: customer.id,
        relatedId: invoice.id,
      });
      const laterVendorPayment = await posted({
        kind: "vendor_payment",
        date: "2026-12-06",
        amount: "500",
        sourceId: bankAccount.id,
        contactId: vendor.id,
        relatedId: bill.id,
      });
      const countBefore = (
        await control.query(
          `SELECT count(*) FROM ${schema}.journals WHERE company_id=$1`,
          [fixtureCompany.id],
        )
      ).rows[0].count;

      const october = await ok(
        `${prefix}/reports?period=month&year=2026&month=10`,
      );
      const octoberBank = october.balances.accounts.find(
        (a: any) => a.id === bankAccount.id,
      );
      assert.equal(octoberBank.opening, "50000.00");
      assert.equal(octoberBank.debit, "20000.00");
      assert.equal(octoberBank.credit, "15000.00");
      assert.equal(octoberBank.closing, "55000.00");
      assert.equal(
        october.summary.revenue,
        "20000.00",
        "Earlier invoice revenue is excluded from October profit",
      );
      assert.equal(
        october.summary.expenses,
        "15000.00",
        "November reversal does not change October expense activity",
      );
      assert.equal(
        october.agingReceivables.find((d: any) => d.id === invoice.id)
          .outstanding,
        "1000.00",
      );

      const november = await ok(
        `${prefix}/reports?period=month&year=2026&month=11`,
      );
      const novemberBank = november.balances.accounts.find(
        (a: any) => a.id === bankAccount.id,
      );
      assert.equal(novemberBank.opening, octoberBank.closing);
      assert.equal(novemberBank.closing, "70400.00");
      assert.equal(november.summary.revenue, "0.00");
      assert.equal(november.summary.expenses, "-13000.00");
      assert.equal(
        november.agingReceivables.find((d: any) => d.id === invoice.id)
          .outstanding,
        "600.00",
      );
      assert.equal(
        november.agingPayables.find((d: any) => d.id === bill.id).outstanding,
        "2000.00",
      );
      const current = await ok(`${prefix}/documents`);
      assert.equal(
        Number(current.find((d: any) => d.id === invoice.id).allocated),
        1000,
        "Current settlement choices remain independent from historical balances",
      );

      const octoberRows = await ok(
        `${prefix}/period-activity?period=month&year=2026&month=10`,
      );
      assert.deepEqual(
        octoberRows.map((d: any) => d.id).sort((a: number, b: number) => a - b),
        [receipt.id, expense.id].sort((a, b) => a - b),
      );
      assert.equal(
        octoberRows.find((d: any) => d.id === expense.id).status,
        "reversed",
        "Document lifecycle remains current even while showing October activity",
      );
      const septemberRows = await ok(
        `${prefix}/period-activity?period=month&year=2026&month=9`,
      );
      assert.equal(
        septemberRows.find((d: any) => d.id === invoice.id).outstanding_as_of,
        "1000.00",
      );
      const novemberRows = await ok(
        `${prefix}/period-activity?period=month&year=2026&month=11`,
      );
      const reversal = novemberRows.find((d: any) => d.id === expense.id);
      assert.equal(reversal.activity_type, "reversal");
      assert.match(reversal.activity_id, /^reversal:\d+$/);
      assert.equal(reversal.date, "2026-11-10");
      assert.equal(reversal.document_date, "2026-10-16");
      assert.equal(Number(reversal.amount), -15000);
      assert.equal(Number(reversal.base_amount), -15000);
      assert.equal(reversal.can_manage, false);
      assert.equal(reversal.outstanding_as_of, null);
      assert.equal(
        new Set(novemberRows.map((r: any) => r.activity_id)).size,
        novemberRows.length,
      );
      assert.deepEqual(
        novemberRows
          .filter((d: any) => d.activity_type === "document")
          .map((d: any) => d.id)
          .sort((a: number, b: number) => a - b),
        [partial.id, bill.id, pending.id, cancelled.id].sort((a, b) => a - b),
      );
      assert.ok(
        !novemberRows.some((d: any) =>
          [invoice.id, laterPayment.id, laterVendorPayment.id].includes(d.id),
        ),
      );
      const empty = await ok(
        `${prefix}/reports?period=month&year=2027&month=1`,
      );
      const idleBank = empty.balances.accounts.find(
        (a: any) => a.id === bankAccount.id,
      );
      assert.equal(idleBank.opening, "70500.00");
      assert.equal(idleBank.closing, idleBank.opening);
      assert.equal(Number(idleBank.debit), 0);
      assert.equal(Number(idleBank.credit), 0);
      assert.deepEqual(empty.ledger, []);
      assert.equal(
        (
          await control.query(
            `SELECT count(*) FROM ${schema}.journals WHERE company_id=$1`,
            [fixtureCompany.id],
          )
        ).rows[0].count,
        countBefore,
        "Viewing periods never creates carry-forward journal entries",
      );
    });

    test("own-data period grants expose only assigned cash and permitted dated activity", async () => {
      const fixtureCompany = await ok("/api/companies", {
        method: "POST",
        body: { name: "Period own-data fixture" },
      });
      const prefix = `/api/c/${fixtureCompany.id}`;
      const query = "period=month&year=2026&month=11";
      const setup = await ok(`${prefix}/bootstrap`);
      const purpose = (value: string) =>
        setup.accounts.find((a: any) => a.purpose === value).id;
      const master = (table: string, body: any) =>
        ok(`${prefix}/${table}`, { method: "POST", body });
      const custodian = await master("contacts", {
        name: "Period custodian",
        kind: "employee",
      });
      const colleague = await master("contacts", {
        name: "Other period custodian",
        kind: "employee",
      });
      const bankAccount = await master("accounts", {
        code: "P-PRIVATE-BANK",
        name: "PRIVATE PERIOD BANK",
        type: "asset",
        purpose: "bank",
      });
      const ownCash = await master("accounts", {
        code: "P-OWN",
        name: "My period cash",
        type: "asset",
        purpose: "cash",
        custodian_id: custodian.id,
      });
      const otherCash = await master("accounts", {
        code: "P-OTHER",
        name: "PRIVATE OTHER CASH",
        type: "asset",
        purpose: "cash",
        custodian_id: colleague.id,
      });
      const posted = async (body: any, cookie = adminCookie) => {
        const doc = await ok(`${prefix}/documents`, {
          method: "POST",
          cookie,
          body: { description: "Period cash movement", ...body },
        });
        await ok(`${prefix}/documents/${doc.id}/post`, {
          method: "POST",
          cookie,
          body: {},
        });
        return doc;
      };
      await posted({
        kind: "opening",
        date: "2026-09-01",
        amount: "100000",
        targetId: bankAccount.id,
      });
      await posted({
        kind: "withdrawal",
        date: "2026-10-31",
        amount: "50000",
        sourceId: bankAccount.id,
        targetId: ownCash.id,
      });
      const funding = await posted({
        kind: "withdrawal",
        date: "2026-11-01",
        amount: "20000",
        sourceId: bankAccount.id,
        targetId: ownCash.id,
      });
      const otherFunding = await posted({
        kind: "withdrawal",
        date: "2026-11-01",
        amount: "5000",
        sourceId: bankAccount.id,
        targetId: otherCash.id,
      });
      const privateExpense = await posted({
        kind: "expense",
        date: "2026-11-03",
        amount: "100",
        sourceId: ownCash.id,
        headId: purpose("employee_expense"),
        description: "PRIVATE PAYROLL PERIOD",
      });
      const profile = {
        username: "http_period_own",
        full_name: "Period own-data finance",
        active: true,
        role_id: roles.find((r) => r.name === "finance").id,
        companies: [fixtureCompany.id],
        data_scope: "own",
        employee_links: [
          { company_id: fixtureCompany.id, contact_id: custodian.id },
        ],
      };
      const user = await ok("/api/admin/users", {
        method: "POST",
        body: {
          ...profile,
          password,
          overrides: { "transactions.view_periods": true },
        },
      });
      const cookie = await login(profile.username);
      const actor = await ok("/api/auth/user", { cookie });
      assert.equal(actor.dataScope, "own");
      assert.ok(actor.permissions.includes("transactions.view_periods"));
      assert.ok(!actor.permissions.includes("reports.view"));
      const expense = await posted(
        {
          kind: "expense",
          date: "2026-11-04",
          amount: "15000",
          sourceId: ownCash.id,
          headId: purpose("office"),
        },
        cookie,
      );
      const future = await posted(
        {
          kind: "expense",
          date: "2026-12-01",
          amount: "7000",
          sourceId: ownCash.id,
          headId: purpose("office"),
        },
        cookie,
      );
      const cash = await ok(`${prefix}/my-cash?${query}`, { cookie });
      assert.deepEqual(
        cash.map((a: any) => a.id),
        [ownCash.id],
      );
      assert.equal(cash[0].opening, "50000.00");
      assert.equal(cash[0].debit, "20000.00");
      assert.equal(cash[0].credit, "15100.00");
      assert.equal(
        cash[0].closing,
        "54900.00",
        "Assigned cash includes all its movements, including private accounting details",
      );
      assert.equal(
        (await ok(`${prefix}/my-cash`, { cookie }))[0].balance,
        "47900.00",
      );
      const activity = await ok(`${prefix}/period-activity?${query}`, {
        cookie,
      });
      assert.deepEqual(
        activity.map((r: any) => r.id).sort((a: number, b: number) => a - b),
        [funding.id, expense.id].sort((a, b) => a - b),
      );
      assert.ok(
        !activity.some((r: any) =>
          [otherFunding.id, privateExpense.id, future.id].includes(r.id),
        ),
      );
      const redactedFunding = activity.find((r: any) => r.id === funding.id);
      assert.equal(redactedFunding.source_id, null);
      assert.equal(redactedFunding.created_by, null);
      assert.equal(redactedFunding.creator, "Finance");
      assert.equal(redactedFunding.can_manage, false);
      assert.deepEqual(redactedFunding.extra, {});
      assert.ok(!JSON.stringify(activity).includes("PRIVATE"));
      for (const path of [
        `${prefix}/reports?${query}`,
        `${prefix}/period-balances?${query}`,
        `/api/c/${otherCompany}/period-activity?${query}`,
        `/api/c/${otherCompany}/my-cash?${query}`,
        `${prefix}/documents/${privateExpense.id}/ledger`,
      ])
        assert.equal(
          (await request(path, { cookie })).response.status,
          403,
          path,
        );
      await ok("/api/admin/users", {
        method: "POST",
        body: {
          ...profile,
          id: user.id,
          overrides: { "transactions.view_periods": false },
        },
      });
      assert.equal(
        (await request(`${prefix}/period-activity?${query}`, { cookie }))
          .response.status,
        403,
      );
      assert.equal(
        (await request(`${prefix}/my-cash?${query}`, { cookie })).response
          .status,
        403,
      );
      assert.equal(
        (await ok(`${prefix}/my-cash`, { cookie }))[0].balance,
        "47900.00",
      );
    });

    test("removed module history remains visible without allowing new postings", async () => {
      const bootstrap = await ok(`/api/c/${company}/bootstrap`);
      const fixed = bootstrap.accounts.find(
        (a: any) => a.purpose === "fixed_asset",
      ).id;
      const actor = await ok("/api/auth/user");
      const capitalCategory = (
        await control.query(
          `INSERT INTO ${schema}.categories(company_id,name,account_id) VALUES($1,'Retained capital category',$2) RETURNING id`,
          [company, fixed],
        )
      ).rows[0].id;
      for (const explicitHead of [null, head]) {
        const input = {
          kind: "bill",
          date: "2026-10-01",
          amount: "50",
          description: "Category-only capital bill",
          categoryId: capitalCategory,
          ...(explicitHead ? { headId: explicitHead } : {}),
        };
        assert.equal(
          (
            await request(`/api/c/${company}/documents`, {
              method: "POST",
              cookie: adminCookie,
              body: input,
            })
          ).response.status,
          410,
        );
        const retained = (
          await control.query(
            `INSERT INTO ${schema}.documents(company_id,kind,date,amount,currency,rate,base_amount,description,status,created_by,category_id,head_id) VALUES($1,'bill','2026-10-01',50,'PKR',1,50,'Retained category-only capital bill','pending',$2,$3,$4) RETURNING id`,
            [company, actor.id, capitalCategory, explicitHead],
          )
        ).rows[0];
        const listed = (await ok(`/api/c/${company}/documents`)).find(
          (d: any) => d.id === retained.id,
        );
        assert.equal(
          listed.retired,
          true,
          "The capital category takes precedence over an absent or operating expense head",
        );
        assert.equal(
          (
            await request(`/api/c/${company}/documents/${retained.id}/post`, {
              method: "POST",
              cookie: adminCookie,
              body: {},
            })
          ).response.status,
          410,
        );
        assert.equal(
          (
            await request(`/api/c/${company}/documents/${retained.id}`, {
              method: "PATCH",
              cookie: adminCookie,
              body: {
                ...input,
                categoryId: undefined,
                kind: "expense",
                sourceId: bank,
                headId: head,
              },
            })
          ).response.status,
          410,
        );
        assert.equal(
          (
            await control.query(
              `SELECT count(*) FROM ${schema}.journals WHERE document_id=$1`,
              [retained.id],
            )
          ).rows[0].count,
          "0",
        );
      }
      const c = await control.connect();
      let documentId: number;
      try {
        await c.query("BEGIN");
        await c.query(`SET LOCAL search_path TO ${schema}`);
        documentId = (
          await c.query(
            `INSERT INTO ${schema}.documents(company_id,kind,date,amount,currency,rate,base_amount,description,status,created_by,source_id) VALUES($1,'asset_purchase','2026-10-01',100,'PKR',1,100,'Retained historical asset','posted',$2,$3) RETURNING id`,
            [company, actor.id, bank],
          )
        ).rows[0].id;
        const journal = (
          await c.query(
            `INSERT INTO ${schema}.journals(company_id,document_id,date) VALUES($1,$2,'2026-10-01') RETURNING id`,
            [company, documentId],
          )
        ).rows[0].id;
        await c.query(
          `INSERT INTO ${schema}.journal_lines(journal_id,company_id,account_id,debit,credit,foreign_amount,currency) VALUES($1,$2,$3,100,0,100,'PKR'),($1,$2,$4,0,100,-100,'PKR')`,
          [journal, company, fixed, bank],
        );
        await c.query("COMMIT");
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      } finally {
        c.release();
      }
      const visible = (await ok(`/api/c/${company}/documents`)).find(
        (d: any) => d.id === documentId,
      );
      assert.equal(visible.status, "posted");
      assert.equal(visible.kind, "asset_purchase");
      const pending = (
        await control.query(
          `INSERT INTO ${schema}.documents(company_id,kind,date,amount,currency,rate,base_amount,description,status,created_by,source_id) VALUES($1,'asset_purchase','2026-10-01',50,'PKR',1,50,'Retained pending asset','pending',$2,$3) RETURNING id`,
          [company, actor.id, bank],
        )
      ).rows[0];
      assert.equal(
        (
          await request(`/api/c/${company}/documents/${pending.id}/post`, {
            method: "POST",
            cookie: adminCookie,
            body: {},
          })
        ).response.status,
        410,
      );
      assert.equal(
        (
          await request(`/api/c/${company}/documents/${pending.id}`, {
            method: "PATCH",
            cookie: adminCookie,
            body: {
              kind: "expense",
              date: "2026-10-01",
              amount: "50",
              description: "Attempted conversion",
              sourceId: bank,
              headId: head,
            },
          })
        ).response.status,
        410,
      );
      assert.equal(
        (
          await control.query(
            `SELECT count(*) FROM ${schema}.journals WHERE document_id=$1`,
            [pending.id],
          )
        ).rows[0].count,
        "0",
      );
      const report = await ok(
        `/api/c/${company}/reports?from=2026-10-01&to=2026-10-31`,
      );
      assert.equal(
        report.ledger.filter((l: any) => l.document_id === documentId).length,
        2,
      );
      await ok(`/api/c/${company}/documents/${documentId}/reverse`, {
        method: "POST",
        body: { date: "2026-10-11" },
      });
      assert.equal(
        (
          await control.query(
            `SELECT count(*) FROM ${schema}.journals WHERE document_id=$1`,
            [documentId],
          )
        ).rows[0].count,
        "2",
      );
    });
  },
);
