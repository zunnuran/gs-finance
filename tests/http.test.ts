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
    async function approve(documentId: number) {
      await ok(`/api/c/${company}/documents/${documentId}/submit`, {
        method: "POST",
        body: {},
      });
      await ok(`/api/c/${company}/documents/${documentId}/approve`, {
        method: "POST",
        cookie: managerCookie,
        body: {},
      });
    }
    async function createApproved(body: any) {
      const document = await ok(`/api/c/${company}/documents`, {
        method: "POST",
        body,
      });
      await approve(document.id);
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
      assert.equal(bootstrap.company.approvals, true);
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
          await request(`/api/c/${company}/projects`, {
            cookie: viewerCookie,
            method: "POST",
            body: { name: "Forbidden project" },
          })
        ).response.status,
        403,
      );
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
        `/api/c/${company}/documents/${adminDocument}/submit`,
        { method: "POST", cookie: employeeCookie, body: {} },
      );
      assert.ok([400, 403].includes(denied.response.status));
    });

    test("permission holders can approve their own submitted transactions with a traceable reviewer", async () => {
      const admin = await ok("/api/auth/user");
      for (const action of ["approve", "reject"])
        assert.equal(
          (
            await request(
              `/api/c/${company}/documents/${adminDocument}/${action}`,
              {
                method: "POST",
                cookie: adminCookie,
                body: {},
              },
            )
          ).response.status,
          400,
          "Drafts must be submitted before review",
        );
      assert.equal(
        (
          await request(`/api/c/${company}/documents/${adminDocument}/post`, {
            method: "POST",
            cookie: adminCookie,
            body: {},
          })
        ).response.status,
        400,
      );
      await ok(`/api/c/${company}/documents/${adminDocument}/submit`, {
        method: "POST",
        body: {},
      });
      assert.equal(
        (
          await request(
            `/api/c/${company}/documents/${adminDocument}/approve`,
            { method: "POST", cookie: employeeCookie, body: {} },
          )
        ).response.status,
        403,
        "Company membership alone does not grant approval permission",
      );
      await ok(`/api/c/${company}/documents/${adminDocument}/approve`, {
        method: "POST",
        cookie: adminCookie,
        body: {},
      });
      const approved = (await ok(`/api/c/${company}/documents`)).find(
        (d: any) => d.id === adminDocument,
      );
      assert.equal(approved.status, "approved");
      assert.equal(approved.created_by, admin.id);
      assert.equal(approved.approved_by, admin.id);
      const reviewAudit = (
        await control.query(
          `SELECT * FROM ${schema}.audit WHERE company_id=$1 AND entity='document' AND entity_id=$2 AND action='approve'`,
          [company, adminDocument],
        )
      ).rows;
      assert.equal(reviewAudit.length, 1);
      assert.equal(reviewAudit[0].user_id, admin.id);
      assert.equal(reviewAudit[0].before_value.status, "submitted");
      assert.equal(reviewAudit[0].after_value.status, "approved");
      for (const action of ["approve", "reject"])
        assert.equal(
          (
            await request(
              `/api/c/${company}/documents/${adminDocument}/${action}`,
              {
                method: "POST",
                cookie: adminCookie,
                body: {},
              },
            )
          ).response.status,
          400,
          "An approved transaction cannot be reviewed again",
        );
      await ok(`/api/c/${company}/documents/${adminDocument}/post`, {
        method: "POST",
        body: {},
      });
      const docs = await ok(`/api/c/${company}/documents`);
      assert.equal(
        docs.find((d: any) => d.id === adminDocument).status,
        "posted",
      );
      for (const action of ["approve", "reject"])
        assert.equal(
          (
            await request(
              `/api/c/${company}/documents/${adminDocument}/${action}`,
              {
                method: "POST",
                cookie: adminCookie,
                body: {},
              },
            )
          ).response.status,
          400,
          "Posted transactions cannot re-enter review",
        );
    });

    test("uploads reach their handler and downloads retain document access checks", async () => {
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

    test("employee approval overrides enable own and company review without granting other users' edit rights", async () => {
      const reviewer = await addUser("http_employee_reviewer", "employee");
      const cookie = await login("http_employee_reviewer");
      const expense = {
        kind: "expense",
        date: "2026-10-02",
        amount: "25",
        description: "Permission-controlled review",
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
      const review = (doc: number, action: string) =>
        request(`/api/c/${company}/documents/${doc}/${action}`, {
          method: "POST",
          cookie,
          body: {},
        });
      await ok(`/api/c/${company}/documents/${own.id}/submit`, {
        method: "POST",
        cookie,
        body: {},
      });
      assert.equal((await review(own.id, "approve")).response.status, 403);
      const updatePermission = (enabled: boolean) =>
        ok("/api/admin/users", {
          method: "POST",
          body: {
            id: reviewer.id,
            username: "http_employee_reviewer",
            full_name: "http_employee_reviewer",
            role_id: roles.find((r) => r.name === "employee").id,
            active: true,
            companies: [company],
            overrides: { "transactions.approve": enabled },
            data_scope: "company",
          },
        });
      await updatePermission(true);
      const visible = await ok(`/api/c/${company}/documents`, { cookie });
      assert.ok(visible.some((d: any) => d.id === own.id));
      assert.ok(visible.some((d: any) => d.id === peer.id));
      for (const action of ["submit", "cancel"])
        assert.equal((await review(peer.id, action)).response.status, 400);
      assert.equal(
        (
          await request(`/api/c/${company}/documents/${peer.id}`, {
            method: "PATCH",
            cookie,
            body: { ...expense, description: "Unauthorized edit" },
          })
        ).response.status,
        400,
      );
      const peerReceipt = new FormData();
      peerReceipt.append(
        "files",
        new Blob(["%PDF-1.4\n%%EOF"], { type: "application/pdf" }),
        "review.pdf",
      );
      assert.equal(
        (
          await request(`/api/c/${company}/documents/${peer.id}/attachments`, {
            method: "POST",
            cookie,
            body: peerReceipt,
          })
        ).response.status,
        400,
        "Review access does not grant another creator's upload rights",
      );
      await ok(`/api/c/${company}/documents/${peer.id}/attachments`, {
        method: "POST",
        body: peerReceipt,
      });
      const attachments = await ok(
        `/api/c/${company}/documents/${peer.id}/attachments`,
        { cookie },
      );
      assert.equal(attachments.length, 1);
      const attachmentPath = `/api/c/${company}/documents/${peer.id}/attachments/${attachments[0].id}`;
      assert.equal(
        (await request(attachmentPath, { cookie })).response.status,
        200,
      );
      await ok(`/api/c/${company}/documents/${peer.id}/submit`, {
        method: "POST",
        body: {},
      });
      for (const document of [own, peer]) {
        assert.equal(
          (await review(document.id, "approve")).response.status,
          200,
        );
        const approved = (
          await control.query(
            `SELECT status,approved_by FROM ${schema}.documents WHERE id=$1`,
            [document.id],
          )
        ).rows[0];
        assert.equal(approved.status, "approved");
        assert.equal(approved.approved_by, reviewer.id);
        const audit = (
          await control.query(
            `SELECT user_id,before_value,after_value FROM ${schema}.audit WHERE entity='document' AND entity_id=$1 AND action='approve'`,
            [document.id],
          )
        ).rows;
        assert.equal(audit.length, 1);
        assert.equal(audit[0].user_id, reviewer.id);
        assert.equal(audit[0].before_value.status, "submitted");
        assert.equal(audit[0].after_value.status, "approved");
      }
      assert.equal(
        (
          await request(`/api/c/${otherCompany}/documents/${own.id}/approve`, {
            method: "POST",
            cookie,
            body: {},
          })
        ).response.status,
        403,
        "Approval permission cannot cross company memberships",
      );
      const rejected = await ok(`/api/c/${company}/documents`, {
        method: "POST",
        cookie,
        body: expense,
      });
      assert.equal((await review(rejected.id, "submit")).response.status, 200);
      assert.equal((await review(rejected.id, "reject")).response.status, 200);
      assert.equal((await review(rejected.id, "approve")).response.status, 400);
      assert.equal((await review(rejected.id, "reject")).response.status, 400);
      assert.equal((await review(rejected.id, "cancel")).response.status, 200);
      assert.equal((await review(rejected.id, "approve")).response.status, 400);
      const pending = await ok(`/api/c/${company}/documents`, {
        method: "POST",
        cookie,
        body: expense,
      });
      assert.equal((await review(pending.id, "submit")).response.status, 200);
      await updatePermission(false);
      assert.equal((await review(pending.id, "approve")).response.status, 403);
      assert.equal((await review(pending.id, "reject")).response.status, 403);
      const restricted = await ok(`/api/c/${company}/documents`, { cookie });
      assert.ok(restricted.some((d: any) => d.id === own.id));
      assert.ok(
        restricted.some((d: any) => d.id === peer.id),
        "Approval permission does not determine company data access",
      );
      assert.equal(
        (await request(attachmentPath, { cookie })).response.status,
        200,
      );
      assert.equal(
        (
          await request(`/api/c/${company}/documents/${peer.id}/attachments`, {
            cookie,
          })
        ).response.status,
        200,
      );
      assert.equal(
        (
          await control.query(
            `SELECT status,approved_by FROM ${schema}.documents WHERE id=$1`,
            [pending.id],
          )
        ).rows[0].status,
        "submitted",
      );
      assert.equal(
        (
          await control.query(
            `SELECT count(*)::integer count FROM ${schema}.audit WHERE entity='document' AND entity_id=$1 AND action IN ('approve','reject')`,
            [pending.id],
          )
        ).rows[0].count,
        0,
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
      const advance = await posted({
        kind: "advance",
        sourceId: ownBank.id,
        contactId: employee.id,
        amount: "500",
      });
      const otherAdvance = await posted({
        kind: "advance",
        sourceId: ownBank.id,
        contactId: colleague.id,
        amount: "300",
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
      await action(financeDraft, "submit");
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
      const ownAttachment = await attach(advance, "advance.pdf");
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
          [400, 403].includes(result.response.status),
          `${path} must reject own-data access, got ${result.response.status}`,
        );
      };
      const actor = await ok("/api/auth/user", { cookie: ownCookie });
      assert.equal(actor.dataScope, "own");
      assert.ok(actor.permissions.includes("transactions.approve"));
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
      for (const doc of [deposit, advance]) {
        const found = visible.find((d: any) => d.id === doc.id);
        assert.ok(
          found,
          "Finance-created deposits and advances stay visible to their custodian",
        );
        assert.equal(found.can_manage, false);
        assert.ok(found.source_id == null, "A private bank source is redacted");
      }
      for (const doc of [otherDeposit, otherAdvance, salary, income])
        assert.ok(
          !visible.some((d: any) => d.id === doc.id),
          "Payroll, income and another employee's transactions stay hidden",
        );
      assert.doesNotMatch(
        JSON.stringify(visible),
        /PRIVATE SALARY DETAILS|PRIVATE CLIENT INCOME/,
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
      const safeDownload = `${prefix}/documents/${advance.id}/attachments/${ownAttachment.id}`;
      assert.equal(
        (await request(safeDownload, { cookie: ownCookie })).response.status,
        200,
      );
      await denied(`${prefix}/documents/${salary.id}/attachments`);
      await denied(
        `${prefix}/documents/${salary.id}/attachments/${privateAttachment.id}`,
      );
      await denied(
        `${prefix}/documents/${advance.id}/attachments/${privateAttachment.id}`,
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
      await denied(`${prefix}/documents/${advance.id}/attachments`, {
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
          relatedId: otherAdvance.id,
          contactId: employee.id,
          headId: purpose("office"),
        },
        {
          kind: "advance_return",
          relatedId: advance.id,
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
      for (const operation of ["approve", "post", "reverse"])
        await denied(`${prefix}/documents/${advance.id}/${operation}`, {
          method: "POST",
          body: { date: "2026-10-11" },
        });
      for (const operation of ["approve", "post", "cancel"])
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
      for (const operation of ["submit", "approve", "post"])
        await action(expense, operation, ownCookie);
      const ownExpense = (
        await ok(`${prefix}/documents`, { cookie: ownCookie })
      ).find((d: any) => d.id === expense.id);
      assert.equal(ownExpense.can_manage, true);
      assert.equal(ownExpense.approved_by, ownUser.id);
      const requestDraft = await create(
        {
          kind: "advance",
          contactId: employee.id,
          amount: "30",
          description: "Source-free advance request",
        },
        ownCookie,
      );
      assert.equal(requestDraft.status, "draft");
      assert.ok(requestDraft.source_id == null);
      await posted(
        {
          kind: "advance_expense",
          relatedId: advance.id,
          contactId: employee.id,
          headId: purpose("office"),
          amount: "50",
        },
        ownCookie,
      );
      await posted(
        {
          kind: "advance_return",
          relatedId: advance.id,
          contactId: employee.id,
          targetId: cash.id,
          amount: "20",
        },
        ownCookie,
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
        "Employees default to own data even with approval permission",
      );
      assert.ok(defaultEmployee.permissions.includes("transactions.approve"));
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

    test("concurrent posting is idempotent and creates one journal", async () => {
      const document = await createApproved({
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
      const invoice = await createApproved({
        kind: "invoice",
        date: "2026-10-04",
        dueDate: "2026-10-31",
        amount: "1000",
        description: "Concurrency test invoice",
        contactId: customer.id,
        headId: revenue,
      });
      await post(invoice.id);
      const first = await createApproved({
        kind: "client_payment",
        date: "2026-10-05",
        amount: "600",
        description: "First concurrent settlement",
        contactId: customer.id,
        relatedId: invoice.id,
        targetId: bank,
      });
      const second = await createApproved({
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

    test("draft corrections clear review state and approved transactions cannot be silently edited", async () => {
      const body = {
        kind: "expense",
        date: "2026-10-06",
        amount: "75",
        description: "Expense to correct",
        sourceId: bank,
        headId: head,
      };
      const document = await ok(`/api/c/${company}/documents`, {
        method: "POST",
        body,
      });
      await ok(`/api/c/${company}/documents/${document.id}/submit`, {
        method: "POST",
        body: {},
      });
      await ok(`/api/c/${company}/documents/${document.id}/reject`, {
        method: "POST",
        cookie: managerCookie,
        body: {},
      });
      const changed = await ok(`/api/c/${company}/documents/${document.id}`, {
        method: "PATCH",
        body: { ...body, amount: "80", description: "Corrected expense" },
      });
      assert.equal(changed.status, "draft");
      assert.equal(changed.approved_by, null);
      assert.equal(Number(changed.amount), 80);
      assert.equal(
        (
          await request(`/api/c/${company}/documents/${document.id}/post`, {
            method: "POST",
            cookie: adminCookie,
            body: {},
          })
        ).response.status,
        400,
        "Corrected draft requires review again",
      );
      await approve(document.id);
      const deniedEdit = await request(
        `/api/c/${company}/documents/${document.id}`,
        {
          method: "PATCH",
          cookie: adminCookie,
          body: { ...body, amount: "999" },
        },
      );
      assert.equal(deniedEdit.response.status, 400);
      const unchanged = (await ok(`/api/c/${company}/documents`)).find(
        (row: any) => row.id === document.id,
      );
      assert.equal(unchanged.status, "approved");
      assert.equal(Number(unchanged.amount), 80);
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

    test("asset purchase and monthly depreciation post once with a traceable asset balance", async () => {
      const purchase = await createApproved({
        kind: "asset_purchase",
        date: "2026-10-07",
        amount: "1200",
        description: "Test workstation purchase",
        sourceId: bank,
        assetName: "HTTP workstation",
        usefulLife: 12,
        salvage: "0",
      });
      await post(purchase.id);
      let assets = await ok(`/api/c/${company}/assets`);
      const asset = assets.find((row: any) => row.document_id === purchase.id);
      assert.ok(asset);
      assert.equal(Number(asset.cost), 1200);
      assert.equal(Number(asset.depreciated), 0);
      const posted = await ok(
        `/api/c/${company}/assets/${asset.id}/depreciate`,
        { method: "POST", body: { date: "2026-10-31" } },
      );
      assert.equal(Number(posted.amount), 100);
      assert.equal(
        (
          await request(`/api/c/${company}/assets/${asset.id}/depreciate`, {
            method: "POST",
            cookie: adminCookie,
            body: { date: "2026-10-31" },
          })
        ).response.status,
        400,
      );
      assets = await ok(`/api/c/${company}/assets`);
      assert.equal(
        Number(assets.find((row: any) => row.id === asset.id).depreciated),
        100,
      );
      const report = await ok(
        `/api/c/${company}/reports?from=2026-10-01&to=2026-10-31`,
      );
      const lines = report.ledger.filter(
        (line: any) => line.document_id === posted.id,
      );
      assert.equal(lines.length, 2);
      assert.equal(
        Number(
          lines.find((line: any) => line.purpose === "depreciation").debit,
        ),
        100,
      );
      assert.equal(
        Number(
          lines.find((line: any) => line.purpose === "accum_depreciation")
            .credit,
        ),
        100,
      );
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
      const withdrawal = await createApproved({
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

    test("bank reconciliation requires the statement balance and rejects already-cleared lines", async () => {
      const reconcileBank = await ok(`/api/c/${company}/accounts`, {
        method: "POST",
        body: {
          code: "RECONBANK",
          name: "Reconciliation Bank",
          type: "asset",
          purpose: "bank",
          currency: "PKR",
        },
      });
      const opening = await ok(`/api/c/${company}/documents`, {
        method: "POST",
        body: {
          kind: "opening",
          date: "2026-10-01",
          amount: "1000",
          description: "Reconciliation opening",
          targetId: reconcileBank.id,
        },
      });
      await post(opening.id);
      const expense = await createApproved({
        kind: "expense",
        date: "2026-10-02",
        amount: "100",
        description: "Reconciliation expense",
        sourceId: reconcileBank.id,
        headId: head,
      });
      await post(expense.id);
      const lines = (await ok(`/api/c/${company}/reconciliation`)).filter(
        (line: any) => line.account_id === reconcileBank.id,
      );
      assert.equal(lines.length, 2);
      assert.ok(lines.every((line: any) => line.reconciliation_id === null));
      const body = {
        accountId: reconcileBank.id,
        date: "2026-10-31",
        balance: "900",
        lineIds: lines.map((line: any) => line.id),
      };
      assert.equal(
        (
          await request(`/api/c/${company}/reconciliation`, {
            method: "POST",
            cookie: adminCookie,
            body: { ...body, balance: "901" },
          })
        ).response.status,
        400,
      );
      const reconciled = await ok(`/api/c/${company}/reconciliation`, {
        method: "POST",
        body,
      });
      assert.equal(Number(reconciled.statement_balance), 900);
      assert.equal(
        (
          await request(`/api/c/${company}/reconciliation`, {
            method: "POST",
            cookie: adminCookie,
            body,
          })
        ).response.status,
        400,
      );
      const cleared = (await ok(`/api/c/${company}/reconciliation`)).filter(
        (line: any) => line.account_id === reconcileBank.id,
      );
      assert.ok(
        cleared.every((line: any) => line.reconciliation_id === reconciled.id),
      );
    });
  },
);
