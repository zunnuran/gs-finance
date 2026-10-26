// Explicit test database only; tests a built release without changing application data.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, mkdir } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import pg from "pg";

assert.ok(process.env.TEST_DATABASE_URL, "Set TEST_DATABASE_URL to a dedicated test database");
assert.ok(process.argv[2], "Pass the generated release directory");
const release = path.resolve(process.argv[2]);
const key = randomUUID().replaceAll("-", "");
const schema = `gss_pm2_${key}`;
const home = path.resolve(".pm2", `verify-${key}`);
const password = `Test-only-${key}`;
const control = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
const url = new URL(process.env.TEST_DATABASE_URL);
url.searchParams.set("options", `-c search_path=${schema}`);

// PM2 uses global named pipes on Windows even when PM2_HOME is different.
// Refuse to touch an existing daemon. Linux uses the unique PM2_HOME sockets.
if (process.platform === "win32") {
  const occupied = await new Promise((resolve) => {
    const socket = net.connect("\\\\.\\pipe\\rpc.sock");
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  });
  assert.equal(occupied, false, "An existing PM2 daemon is running; use an isolated test host");
}
const probe = net.createServer();
await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
await mkdir(home, { recursive: true });
const env = {
  ...process.env, PM2_HOME: home, PM2_SILENT: "true", PM2_DISCRETE_MODE: "true",
  DATABASE_URL: url.toString(), ADMIN_PASSWORD: password,
  SESSION_SECRET: randomUUID() + randomUUID(), NODE_ENV: "production",
  HOST: "127.0.0.1", PORT: String(port), TRUST_PROXY: "1",
  UPLOAD_DIR: path.join(home, "uploads"),
};
const run = promisify(execFile);
const cli = (...args) => run(process.execPath, [path.join(release, "node_modules/pm2/bin/pm2"), ...args], {
  cwd: release, env, windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024,
});
const base = `http://127.0.0.1:${port}`;
async function login() {
  const response = await fetch(`${base}/api/login`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-GSS-Request": "1", "X-Forwarded-Proto": "https" },
    body: JSON.stringify({ username: "gamestrixstudios@gmail.com", password }),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie"), /Secure/);
  return response.headers.get("set-cookie").split(";")[0];
}
try {
  await control.query(`CREATE SCHEMA ${schema}`);
  await cli("start", "ecosystem.config.cjs");
  assert.equal((await fetch(`${base}/health`)).status, 200);
  const processes = JSON.parse((await cli("jlist")).stdout);
  assert.equal(processes.length, 1);
  assert.equal(processes[0].name, "gss-finance");
  assert.equal(processes[0].pm2_env.status, "online");
  assert.equal(processes[0].pm2_env.NODE_ENV, "production");
  const firstPid = processes[0].pid;
  const cookie = await login();
  const headers = { Cookie: cookie, "X-Forwarded-Proto": "https" };
  const actor = await (await fetch(`${base}/api/auth/user`, { headers })).json();
  assert.equal(actor.username, "admin");
  assert.equal(actor.email, "gamestrixstudios@gmail.com");
  assert.deepEqual(await (await fetch(`${base}/api/companies`, { headers })).json(), []);
  const users = (await (await fetch(`${base}/api/admin`, { headers })).json()).users;
  assert.equal(users.length, 1);
  const index = await (await fetch(base)).text();
  const asset = index.match(/src="([^"]+\.js)"/)[1];
  assert.equal((await fetch(new URL(asset, base))).status, 200);
  await cli("restart", "ecosystem.config.cjs", "--update-env");
  assert.equal((await fetch(`${base}/health`)).status, 200);
  await login();
  assert.notEqual(JSON.parse((await cli("jlist")).stdout)[0].pid, firstPid);
  await cli("stop", "gss-finance");
  const stopped = JSON.parse((await cli("jlist")).stdout)[0];
  assert.equal(stopped.pm2_env.status, "stopped");
  assert.equal(stopped.pm2_env.exit_code, 0);
  const log = await readFile(stopped.pm2_env.pm_out_log_path, "utf8");
  assert.match(log, /GSS Finance shutting down/);
  console.log("PASS: PM2 release start, static assets, clean database, sole admin, secure email login, restart and graceful stop.");
} finally {
  // Kill only the daemon created by this run, and only if no unrelated apps appeared.
  try {
    const pidFile = await readFile(path.join(home, "pm2.pid"), "utf8");
    if (/^\d+\s*$/.test(pidFile)) {
      const processes = JSON.parse((await cli("jlist")).stdout);
      assert.ok(processes.every((p) => p.name === "gss-finance" && p.pm2_env.pm_cwd === release), "Unrelated PM2 processes detected; daemon cleanup refused");
      await cli("kill");
    }
  } finally {
    // The randomly generated schema belongs exclusively to this test.
    await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await control.end();
  }
}
