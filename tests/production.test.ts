import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { describe, test, type TestContext } from "node:test";
import pg from "pg";

// Explicit production-test opt-in. Each test owns a new schema and never resets
// any existing application schema, database, users, or uploaded files.
const databaseUrl = process.env.TEST_DATABASE_URL;
const enabled = process.env.TEST_PRODUCTION === "1" && !!databaseUrl;
const initialPassword = "Production-test-initial-password-42";

type RunningApp = {
  child: ChildProcess;
  output: () => string;
  finished: Promise<{ code: number | null; error?: Error }>;
  done: () => boolean;
};

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function stop(app: RunningApp) {
  if (app.done()) return;
  // This is the same graceful IPC shutdown used by PM2 on Windows.
  if (app.child.connected) app.child.send("shutdown", () => {});
  else app.child.kill("SIGTERM");
  for (let attempt = 0; attempt < 120 && !app.done(); attempt++)
    await delay(100);
  if (!app.done()) {
    app.child.kill("SIGKILL");
    for (let attempt = 0; attempt < 50 && !app.done(); attempt++)
      await delay(100);
  }
  assert.ok(app.done(), "Production test process must stop before cleanup");
}

async function fixture(t: TestContext) {
  const schema = `gss_production_${randomUUID().replaceAll("-", "")}`;
  const control = new pg.Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5000,
  });
  const apps: RunningApp[] = [];
  let uploadDir = "";
  let schemaCreated = false;
  t.after(async () => {
    try {
      for (const app of apps) await stop(app);
      if (schemaCreated) await control.query(`DROP SCHEMA ${schema} CASCADE`);
    } finally {
      await control.end();
      // Only the exact temporary directory created by this fixture is removed.
      if (uploadDir) {
        const target = resolve(uploadDir);
        assert.equal(dirname(target), resolve(tmpdir()));
        assert.ok(basename(target).startsWith("gss-production-"));
        await rm(target, { recursive: true, force: true });
      }
    }
  });
  await control.query(`CREATE SCHEMA ${schema}`);
  schemaCreated = true;
  uploadDir = await mkdtemp(join(tmpdir(), "gss-production-"));
  const scopedUrl = new URL(databaseUrl!);
  scopedUrl.searchParams.set("options", `-c search_path=${schema}`);
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  const base = `http://127.0.0.1:${port}`;
  const sessionSecret = randomUUID() + randomUUID();

  function launch(overrides: NodeJS.ProcessEnv = {}) {
    let output = "";
    let done = false;
    const child = spawn(process.execPath, ["dist/server.js"], {
      cwd: process.cwd(),
      windowsHide: true,
      env: {
        ...process.env,
        DATABASE_URL: scopedUrl.toString(),
        NODE_ENV: "production",
        HOST: "127.0.0.1",
        PORT: String(port),
        TRUST_PROXY: "1",
        ADMIN_PASSWORD: initialPassword,
        SESSION_SECRET: sessionSecret,
        UPLOAD_DIR: uploadDir,
        ...overrides,
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    child.stdout?.on("data", (data) => (output += String(data)));
    child.stderr?.on("data", (data) => (output += String(data)));
    const finished = new Promise<{ code: number | null; error?: Error }>(
      (resolve) => {
        child.once("close", (code) => {
          done = true;
          resolve({ code });
        });
        child.once("error", (error) => {
          done = true;
          resolve({ code: null, error });
        });
      },
    );
    const app = { child, output: () => output, finished, done: () => done };
    apps.push(app);
    return app;
  }

  async function ready(app: RunningApp) {
    for (let attempt = 0; attempt < 300; attempt++) {
      assert.ok(!app.done(), `Production app exited: ${app.output()}`);
      try {
        const response = await fetch(`${base}/health`, {
          signal: AbortSignal.timeout(500),
        });
        await response.arrayBuffer();
        if (response.ok) return;
      } catch {
        // The process may still be applying migrations and bootstrapping.
      }
      await delay(100);
    }
    assert.fail(`Production app did not become ready: ${app.output()}`);
  }

  async function rejected(app: RunningApp, message: RegExp) {
    for (let attempt = 0; attempt < 300 && !app.done(); attempt++)
      await delay(100);
    assert.ok(
      app.done(),
      `Invalid production startup did not exit: ${app.output()}`,
    );
    const result = await app.finished;
    assert.ifError(result.error);
    assert.notEqual(result.code, 0, "Invalid production startup must fail");
    assert.match(app.output(), message);
  }

  async function login(password: string, username = "admin") {
    return fetch(`${base}/api/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GSS-Request": "1",
        "X-Forwarded-Proto": "https",
      },
      body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(10_000),
    });
  }

  return { schema, control, base, launch, ready, rejected, login };
}

describe(
  "Production deployment safeguards",
  { skip: !enabled, timeout: 90_000 },
  () => {
    test("rejects example session secrets before creating any schema tables", async (t) => {
      const f = await fixture(t);
      const app = f.launch({
        SESSION_SECRET: "REPLACE_WITH_64_RANDOM_HEX_CHARACTERS",
      });
      await f.rejected(app, /Replace the example SESSION_SECRET/);
      const tables = await f.control.query(
        "SELECT tablename FROM pg_tables WHERE schemaname=$1",
        [f.schema],
      );
      assert.deepEqual(
        tables.rows,
        [],
        "Configuration errors must precede migrations",
      );
    });

    test("preserves the changed administrator password when restart supplies a different initial password", async (t) => {
      const f = await fixture(t);
      const first = f.launch();
      await f.ready(first);
      const initial = (
        await f.control.query(
          `SELECT id,password,username,email FROM ${f.schema}.users`,
        )
      ).rows;
      assert.equal(initial.length, 1);
      assert.equal(initial[0].username, "admin");
      assert.equal(initial[0].email, "gamestrixstudios@gmail.com");
      assert.equal(
        Number(
          (await f.control.query(`SELECT count(*) FROM ${f.schema}.companies`))
            .rows[0].count,
        ),
        0,
      );

      const login = await f.login(initialPassword);
      assert.equal(login.status, 200);
      const setCookie = login.headers.get("set-cookie");
      assert.ok(setCookie);
      assert.match(setCookie, /; Secure/i);
      await login.arrayBuffer();
      const changedPassword = "Production-test-in-app-password-84";
      const change = await fetch(`${f.base}/api/auth/change-password`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GSS-Request": "1",
          "X-Forwarded-Proto": "https",
          Cookie: setCookie.split(";")[0],
        },
        body: JSON.stringify({
          currentPassword: initialPassword,
          password: changedPassword,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      assert.equal(change.status, 200, await change.text());
      const savedHash = (
        await f.control.query(
          `SELECT password FROM ${f.schema}.users WHERE username='admin'`,
        )
      ).rows[0].password;
      assert.notEqual(savedHash, initial[0].password);
      await stop(first);
      assert.equal(
        (await first.finished).code,
        0,
        "Graceful shutdown should succeed",
      );

      const replacementEnvironmentPassword =
        "Production-test-new-env-password-126";
      const restarted = f.launch({
        ADMIN_PASSWORD: replacementEnvironmentPassword,
      });
      await f.ready(restarted);
      const after = (
        await f.control.query(`SELECT id,password,email FROM ${f.schema}.users`)
      ).rows;
      assert.equal(after.length, 1, "Restart must not create another user");
      assert.equal(after[0].id, initial[0].id);
      assert.equal(
        after[0].password,
        savedHash,
        "Bootstrap must preserve the in-app password",
      );
      for (const password of [
        initialPassword,
        replacementEnvironmentPassword,
      ]) {
        const denied = await f.login(password);
        assert.equal(denied.status, 401);
        await denied.arrayBuffer();
      }
      const accepted = await f.login(
        changedPassword,
        "GAMESTRIXSTUDIOS@GMAIL.COM",
      );
      assert.equal(accepted.status, 200);
      await accepted.arrayBuffer();
    });

    test("refuses a demo-seeded database without removing its records", async (t) => {
      const f = await fixture(t);
      const first = f.launch();
      await f.ready(first);
      await stop(first);
      await f.control.query(
        `INSERT INTO ${f.schema}.companies(name) VALUES('Retained demo rejection fixture')`,
      );
      await f.control.query(
        `INSERT INTO ${f.schema}.audit(user_id,action,entity,after_value) SELECT id,'demo_seed_completed','demo_seed','{"seedKey":"production-guard-test"}'::jsonb FROM ${f.schema}.users WHERE username='admin'`,
      );

      const rejected = f.launch();
      await f.rejected(rejected, /database contains demo data/i);
      const company = await f.control.query(
        `SELECT name FROM ${f.schema}.companies`,
      );
      assert.deepEqual(company.rows, [
        { name: "Retained demo rejection fixture" },
      ]);
      const markers = await f.control.query(
        `SELECT count(*) FROM ${f.schema}.audit WHERE action='demo_seed_completed'`,
      );
      assert.equal(Number(markers.rows[0].count), 1);
      assert.equal(
        Number(
          (await f.control.query(`SELECT count(*) FROM ${f.schema}.users`))
            .rows[0].count,
        ),
        1,
      );
    });
  },
);
