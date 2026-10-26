import { cp, mkdir, readFile, readdir, lstat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const output = path.join(root, "releases", `${manifest.name}-${manifest.version}-${stamp}`);

// Only these compiled files and deployment documents enter the release.
// In particular, never copy the source tree, .env, uploads, or database exports.
const entries = [
  "dist/server.js",
  "dist/public",
  "package-lock.json",
  "ecosystem.config.cjs",
  ".env.production.example",
  "docs/PM2.md",
  "docs/OPERATIONS.md",
];
const migrationNames = (await readdir(path.join(root, "migrations")))
  .filter((name) => name.endsWith(".sql"))
  .sort();
if (migrationNames.length === 0) throw new Error("No SQL migrations found.");
entries.push(...migrationNames.map((name) => `migrations/${name}`));

async function verifyRegularTree(location) {
  const info = await lstat(location);
  if (info.isSymbolicLink()) throw new Error(`Release inputs cannot be symlinks: ${location}`);
  if (info.isDirectory()) {
    for (const name of await readdir(location)) await verifyRegularTree(path.join(location, name));
  } else if (!info.isFile()) {
    throw new Error(`Release input is not a regular file: ${location}`);
  }
}

// Validate all inputs before making an output directory. A prior release is never overwritten.
await lstat(path.join(root, "dist/public/index.html"));
for (const entry of entries) await verifyRegularTree(path.join(root, entry));
await mkdir(path.dirname(output), { recursive: true });
await mkdir(output);
for (const entry of entries) {
  const target = path.join(output, entry);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(path.join(root, entry), target, { recursive: true, errorOnExist: true, force: false });
}

// Keep dependency versions aligned with package-lock.json, but expose only runtime commands.
manifest.scripts = {
  start: "node dist/server.js",
  "pm2:start": "pm2 start ecosystem.config.cjs",
  "pm2:restart": "pm2 restart ecosystem.config.cjs --update-env",
  "pm2:stop": "pm2 stop gss-finance",
  "pm2:logs": "pm2 logs gss-finance",
  "pm2:status": "pm2 status gss-finance",
};
await writeFile(path.join(output, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(
  path.join(output, "README.md"),
  "# GSS Finance production release\n\n" +
    "Start with [the PM2 deployment guide](docs/PM2.md). Run `npm ci --omit=dev`, " +
    "configure `.env` using `.env.production.example`, and use a new production database.\n\n" +
    "This release includes no database contents, demo seed, credentials, or uploaded files. " +
    "Startup creates only the administrator (`admin`, `gamestrixstudios@gmail.com`) " +
    "when the database has no users. Create your company after signing in.\n",
);
console.log(`Production release created: ${output}`);
console.log("No database contents, demo seed, .env, or uploads were included.");
