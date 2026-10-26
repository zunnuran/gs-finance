import "dotenv/config";
import express from "express";
import { createServer } from "node:http";
import path from "node:path";
import { ZodError } from "zod";
import { runMigrations } from "./migrate";
import { bootstrap, setupAuth } from "./auth";
import { registerRoutes } from "./routes";
import { pool } from "./db";
import { validateEnvironment } from "./config";
validateEnvironment();
const app = express(),
  server = createServer(app);
let stopping = false;
app.disable("x-powered-by");
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  next();
});
app.use(express.json({ limit: "1mb" }));
app.get("/health", async (_req, res) => {
  try {
    if (stopping) throw new Error("Stopping");
    await pool.query("SELECT 1");
    res.json({ status: "ok" });
  } catch {
    res.status(503).json({ status: "unavailable" });
  }
});
await runMigrations();
await bootstrap();
const closeSessions = setupAuth(app);
registerRoutes(app);
app.use("/api", (_req, res) => {
  res.status(404).json({ message: "Endpoint not found" });
});
app.use(
  (
    err: any,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    const validation = err instanceof ZodError;
    const status = validation
      ? 400
      : err.code === "23505"
        ? 409
        : err.code === "23503"
          ? 400
          : err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({
      message: validation
        ? err.issues
            .map((i: any) => `${i.path.join(".")}: ${i.message}`)
            .join("; ")
        : err.code === "23505"
          ? "A record with these details already exists"
          : err.code === "23503"
            ? "A referenced record is unavailable or belongs to another company"
            : status < 500
              ? err.message
              : "An unexpected server error occurred",
    });
  },
);
let closeVite: (() => Promise<void>) | undefined;
if (process.env.NODE_ENV === "production") {
  app.use(express.static(path.resolve("dist/public")));
  app.get("*", (_req, res) =>
    res.sendFile(path.resolve("dist/public/index.html")),
  );
} else {
  const { createServer: createVite } = await import("vite");
  const vite = await createVite({
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
  closeVite = () => vite.close();
}
async function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log("GSS Finance shutting down");
  const deadline = setTimeout(() => process.exit(1), 10_000).unref();
  try {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await closeVite?.();
    await closeSessions();
    await pool.end();
    clearTimeout(deadline);
    process.exit(0);
  } catch (error) {
    console.error("Shutdown failed", error);
    process.exit(1);
  }
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
// PM2 uses this message for graceful shutdown on Windows.
process.on("message", (message) => {
  if (message === "shutdown") void shutdown();
});
server.on("error", (error) => {
  console.error("Server could not listen", error);
  process.exit(1);
});
server.listen(
  Number(process.env.PORT || 5000),
  process.env.HOST || "0.0.0.0",
  () => {
    console.log(`GSS Finance listening on port ${process.env.PORT || 5000}`);
    process.send?.("ready");
  },
);
