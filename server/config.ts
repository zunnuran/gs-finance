export const administrator = {
  username: "admin",
  email: "gamestrixstudios@gmail.com",
} as const;

export function validateEnvironment(env: NodeJS.ProcessEnv = process.env) {
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const url = new URL(env.DATABASE_URL);
  if (!["postgres:", "postgresql:"].includes(url.protocol))
    throw new Error("DATABASE_URL must be a PostgreSQL connection URL");
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32)
    throw new Error("SESSION_SECRET must contain at least 32 characters");
  if (
    env.NODE_ENV === "production" &&
    /replace[-_]with|change[-_]me/i.test(env.SESSION_SECRET)
  )
    throw new Error(
      "Replace the example SESSION_SECRET before production startup",
    );
  const port = Number(env.PORT || 5000);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT must be an integer between 1 and 65535");
}
