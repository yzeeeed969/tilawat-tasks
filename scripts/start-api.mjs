import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entrypoint = path.join(rootDir, "artifacts/api-server/dist/index.mjs");

process.env.PORT ||= "3001";
process.env.BASE_PATH ||= "/";

if (process.env.NODE_ENV === "production" && !process.env.SESSION_SECRET) {
  console.error("SESSION_SECRET is required in production");
  process.exit(1);
}

process.env.SESSION_SECRET ||= crypto.randomBytes(48).toString("hex");

if (process.env.NODE_ENV === "production" && !process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required in production");
  process.exit(1);
}

if (!process.env.DATABASE_URL && process.env.NODE_ENV !== "production") {
  process.env.DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:5432/tilawat";
}

try {
  await access(entrypoint);
} catch {
  console.error("API build output is missing. Run: pnpm run build:api");
  process.exit(1);
}

if (process.env.DATABASE_URL) {
  console.log("Preparing database schema...");
  await new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["--filter", "@workspace/db", "run", "push"], {
      cwd: rootDir,
      env: process.env,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Database schema preparation failed with exit code ${code}`));
    });
  });
  console.log("Database schema ready");
}

await import(entrypoint);
