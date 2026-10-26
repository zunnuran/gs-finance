import session from "express-session";
import connectPg from "connect-pg-simple";
import bcrypt from "bcryptjs";
import type { Express, RequestHandler } from "express";
import { z } from "zod";
import { pool, transaction } from "./db";
import { permissionKeys, roleDefaults } from "../shared/permissions";
import { audit } from "./accounting";
import { administrator } from "./config";
declare module "express-session" {
  interface SessionData {
    userId: number;
  }
}
declare global {
  namespace Express {
    interface Request {
      actor: {
        id: number;
        username: string;
        email: string | null;
        full_name: string;
        role: string;
        permissions: string[];
        dataScope: "own" | "company";
      };
    }
  }
}
const buckets = new Map<string, { n: number; until: number }>();
export async function bootstrap() {
  await transaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(871235)");
    if (
      process.env.NODE_ENV === "production" &&
      (
        await c.query(
          "SELECT 1 FROM audit WHERE action='demo_seed_completed' LIMIT 1",
        )
      ).rows.length
    )
      throw new Error(
        "This database contains demo data. Configure a clean production database; demo records are not removed automatically.",
      );
    for (const [name, permissions] of Object.entries(roleDefaults))
      await c.query(
        "INSERT INTO roles(name,permissions) VALUES($1,$2) ON CONFLICT(name) DO NOTHING",
        [name, JSON.stringify(permissions)],
      );
    if (!(await c.query("SELECT 1 FROM users LIMIT 1")).rows.length) {
      if (
        !process.env.ADMIN_PASSWORD ||
        process.env.ADMIN_PASSWORD.length < 12 ||
        /replace[-_]with|change[-_]me/i.test(process.env.ADMIN_PASSWORD)
      )
        throw new Error(
          "Set ADMIN_PASSWORD to at least 12 characters for initial administrator setup",
        );
      await c.query(
        "INSERT INTO users(username,password,full_name,role_id,email) SELECT $1,$2,'System Administrator',id,$3 FROM roles WHERE name='super_admin'",
        [
          administrator.username,
          await bcrypt.hash(process.env.ADMIN_PASSWORD, 12),
          administrator.email,
        ],
      );
    }
    const admins = (
      await c.query(
        "SELECT u.id,u.username,u.active FROM users u JOIN roles r ON r.id=u.role_id WHERE r.name='super_admin'",
      )
    ).rows;
    if (
      admins.length !== 1 ||
      admins[0].username !== administrator.username ||
      !admins[0].active
    )
      throw new Error(
        "The sole active super administrator must be admin. Review existing administrator accounts before starting this release.",
      );
    // Preserve the existing administrator's password during upgrades and restarts.
    await c.query(
      "UPDATE users SET email=$1 WHERE id=$2 AND email IS DISTINCT FROM $1",
      [administrator.email, admins[0].id],
    );
  });
}
export const authenticated: RequestHandler = async (req, res, next) => {
  try {
    if (!req.session.userId)
      return void res.status(401).json({ message: "Please sign in" });
    const u = (
      await pool.query(
        "SELECT u.*,r.name role,r.permissions FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id=$1 AND u.active",
        [req.session.userId],
      )
    ).rows[0];
    if (!u)
      return void res
        .status(401)
        .json({ message: "Account is disabled or unavailable" });
    const perms = new Set<string>(u.permissions);
    for (const [key, enabled] of Object.entries(u.overrides))
      enabled ? perms.add(key) : perms.delete(key);
    const dataScope: "own" | "company" =
      u.role === "super_admin"
        ? "company"
        : (u.data_scope ?? (u.role === "employee" ? "own" : "company"));
    if (dataScope === "own")
      for (const key of [...perms])
        if (!key.startsWith("transactions.")) perms.delete(key);
    req.actor = {
      id: u.id,
      username: u.username,
      email: u.email,
      full_name: u.full_name,
      role: u.role,
      permissions: u.role === "super_admin" ? [...permissionKeys] : [...perms],
      dataScope,
    };
    next();
  } catch (e) {
    next(e);
  }
};
export const requirePermission =
  (key: string): RequestHandler =>
  (req, res, next) => {
    if (!req.actor.permissions.includes(key))
      return void res.status(403).json({ message: "Permission denied" });
    next();
  };
export async function canAccess(
  user: { id: number; role: string },
  company: number,
) {
  return (
    user.role === "super_admin" ||
    !!(
      await pool.query(
        "SELECT 1 FROM memberships WHERE user_id=$1 AND company_id=$2",
        [user.id, company],
      )
    ).rows.length
  );
}
export function setupAuth(app: Express) {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32)
    throw new Error("SESSION_SECRET must contain at least 32 characters");
  const PgStore = connectPg(session);
  const store = new PgStore({
    pool,
    tableName: "sessions",
    createTableIfMissing: true,
    ttl: 28800,
  });
  app.set("trust proxy", process.env.TRUST_PROXY === "1" ? 1 : false);
  app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "private, no-store");
    next();
  });
  app.use(
    session({
      name: "gss.sid",
      secret,
      store,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        maxAge: 8 * 60 * 60 * 1000,
      },
    }),
  );
  app.use((req, res, next) => {
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.get("X-GSS-Request") !== "1"
    )
      return void res
        .status(403)
        .json({ message: "Missing request protection header" });
    next();
  });
  app.post("/api/login", async (req, res, next) => {
    try {
      const key = req.ip || "unknown",
        now = Date.now();
      for (const [ip, b] of buckets) if (b.until < now) buckets.delete(ip);
      const b = buckets.get(key) || { n: 0, until: now + 15 * 60 * 1000 };
      b.n++;
      buckets.set(key, b);
      if (b.n > 20)
        return void res.status(429).json({
          message: "Too many login attempts; try again in 15 minutes",
        });
      if (process.env.NODE_ENV === "production" && !req.secure)
        return void res.status(503).json({
          code: "HTTPS_REQUIRED",
          message:
            "Secure sign-in is unavailable. Open the HTTPS address or ask your administrator to check the proxy configuration.",
        });
      const d = z
        .object({
          username: z.string().min(1).max(254),
          password: z.string().min(1).max(200),
        })
        .parse(req.body);
      const u = (
        await pool.query(
          d.username.includes("@")
            ? "SELECT * FROM users WHERE lower(email)=$1 AND active"
            : "SELECT * FROM users WHERE username=$1 AND active",
          [d.username.trim().toLowerCase()],
        )
      ).rows[0];
      if (!u || !(await bcrypt.compare(d.password, u.password)))
        return void res.status(401).json({ message: "Invalid credentials" });
      await new Promise<void>((resolve, reject) =>
        req.session.regenerate((e) => (e ? reject(e) : resolve())),
      );
      req.session.userId = u.id;
      await new Promise<void>((resolve, reject) =>
        req.session.save((e) => (e ? reject(e) : resolve())),
      );
      buckets.delete(key);
      res.json({ success: true });
    } catch (e) {
      next(e);
    }
  });
  app.get("/api/auth/user", authenticated, (req, res) => {
    res.json(req.actor);
  });
  app.post(
    "/api/auth/change-password",
    authenticated,
    async (req, res, next) => {
      try {
        const d = z
          .object({
            currentPassword: z.string().min(1).max(200),
            password: z.string().min(12).max(200),
          })
          .parse(req.body);
        const u = (
          await pool.query("SELECT password FROM users WHERE id=$1", [
            req.actor.id,
          ])
        ).rows[0];
        if (!(await bcrypt.compare(d.currentPassword, u.password)))
          return void res
            .status(400)
            .json({ message: "Current password is incorrect" });
        const hash = await bcrypt.hash(d.password, 12);
        await transaction(async (c) => {
          await c.query("UPDATE users SET password=$1 WHERE id=$2", [
            hash,
            req.actor.id,
          ]);
          await c.query(
            "DELETE FROM sessions WHERE (sess->>'userId')::integer=$1",
            [req.actor.id],
          );
          await audit(
            c,
            null,
            req.actor.id,
            "change_password",
            "user",
            req.actor.id,
            null,
            { password: "[redacted]" },
          );
        });
        req.session.destroy(() => {});
        res.clearCookie("gss.sid");
        res.json({ success: true });
      } catch (e) {
        next(e);
      }
    },
  );
  app.post("/api/logout", (req, res, next) =>
    req.session.destroy((e) => {
      if (e) next(e);
      else {
        res.clearCookie("gss.sid");
        res.json({ success: true });
      }
    }),
  );
  return () => store.close();
}
