// ملاحظة نشر: خدمة الموقع الحي على Railway (api-server) تبني الواجهة أيضًا وتخدمها، لكنها لا تُعاد
// إلا عند تغيّر ملفات api-server. فأي تحديث للواجهة وحدها يحتاج لمس ملف هنا (أو إضافة
// سطر هنا). آخر لمس: الإصدار 74 — ترتيب الجمعة: خطبة وصلاة كل مسجد.
import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import crypto from "node:crypto";
import path from "node:path";
import router from "./routes";
import { logger } from "./lib/logger";
import { privacyPageHtml } from "./lib/privacy-page";

const app: Express = express();
const clientDistDir = path.resolve(process.cwd(), "artifacts/tilawat-tasks/dist/public");
const clientIndexPath = path.join(clientDistDir, "index.html");
// Railway watches the API service, so this marker forces rebuilds that include frontend assets. task-flow-cache-diagnostic-deploy-20260619
const SESSION_COOKIE_NAME = "sid";
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

type MemoryTask = {
  id: number;
  title: string;
  createdAt: string;
};

const memoryTasks: MemoryTask[] = [];
let nextMemoryTaskId = 1;

// Trust the reverse proxy (Replit's proxy sends X-Forwarded-* headers)
app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return { id: req.id, method: req.method, url: req.url?.split("?")[0] };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  }),
);

app.use(cors({ credentials: true, origin: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/", (req, res, next) => {
  if (req.accepts(["html", "text"]) === "html") {
    next();
    return;
  }

  res.type("text/plain").send("API is running");
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// الواجهة (artifacts/tilawat-tasks) تُبنى وتُقدَّم من خدمة api-server نفسها على Railway. تنبيه: مسارات
// المراقبة لهذه الخدمة في Railway لا تشمل مجلد الواجهة، فتعديل يخص الواجهة وحدها لا يُعيد النشر —
// أضف ‎/artifacts/tilawat-tasks/**‎ إلى Watch Paths لخدمة api-server (إلى ذلك الحين: أي تعديل للواجهة
// وحدها يحتاج لمسة هنا ليُنشر).
app.use(express.static(clientDistDir, {
  setHeaders(res, filePath) {
    if (filePath.endsWith("sw.js")) {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
      res.setHeader("Service-Worker-Allowed", "/");
      return;
    }
    if (filePath.endsWith("index.html")) {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
      return;
    }
    if (filePath.includes(`${path.sep}assets${path.sep}`)) {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    }
  },
}));

// سياسة الخصوصية العامة لتطبيق Quran Views — HTML ثابت من الخادم (بلا تسجيل دخول، يقرؤه مدقّق ميتا بلا JavaScript).
app.get("/privacy", (_req, res) => {
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.type("html").send(privacyPageHtml());
});

app.get(/.*/, (req, res, next) => {
  if (req.path.startsWith("/api")) {
    next();
    return;
  }

  if (req.accepts(["html", "json"]) !== "html") {
    next();
    return;
  }

  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.sendFile(clientIndexPath, (err) => {
    if (err) next(err);
  });
});

app.get("/tasks", (_req, res) => {
  res.json(memoryTasks);
});

app.post("/tasks", (req, res) => {
  const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";

  if (!title) {
    res.status(400).json({ error: "title is required" });
    return;
  }

  const task: MemoryTask = {
    id: nextMemoryTaskId++,
    title,
    createdAt: new Date().toISOString(),
  };

  memoryTasks.push(task);
  res.status(201).json(task);
});

app.delete("/tasks/:id", (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "invalid task id" });
    return;
  }

  const taskIndex = memoryTasks.findIndex((task) => task.id === id);

  if (taskIndex === -1) {
    res.status(404).json({ error: "task not found" });
    return;
  }

  memoryTasks.splice(taskIndex, 1);
  res.status(204).send();
});

const sessionSecret = process.env.SESSION_SECRET ?? "";
if (!sessionSecret) throw new Error("SESSION_SECRET is required");

const isProd = process.env.NODE_ENV === "production";

function base64Url(input: Buffer | string) {
  return Buffer.from(input).toString("base64url");
}

function sign(value: string) {
  return crypto.createHmac("sha256", sessionSecret).update(value).digest("base64url");
}

function readCookie(cookieHeader: string | undefined, name: string) {
  if (!cookieHeader) return null;

  for (const part of cookieHeader.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey === name) {
      try {
        return decodeURIComponent(rawValue.join("="));
      } catch {
        return rawValue.join("=");
      }
    }
  }

  return null;
}

function encodeSession(userId: number) {
  const payload = base64Url(JSON.stringify({ userId, exp: Date.now() + SESSION_MAX_AGE_MS }));
  return `v1.${payload}.${sign(payload)}`;
}

function decodeSession(raw: string | null) {
  if (!raw) return null;

  const parts = raw.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;

  const [, payload, signature] = parts;
  const expected = sign(payload);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);

  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      userId?: unknown;
      exp?: unknown;
    };

    if (typeof data.userId !== "number" || typeof data.exp !== "number") return null;
    if (data.exp < Date.now()) return null;

    return { userId: data.userId };
  } catch {
    return null;
  }
}

app.use((req, res, next) => {
  const signedSession = decodeSession(readCookie(req.headers.cookie, SESSION_COOKIE_NAME));

  (req as any).session = {
    userId: signedSession?.userId,
    save(callback?: (err?: Error) => void) {
      try {
        if (typeof this.userId !== "number") {
          callback?.();
          return;
        }

        res.cookie(SESSION_COOKIE_NAME, encodeSession(this.userId), {
          httpOnly: true,
          sameSite: "lax",
          secure: isProd,
          maxAge: SESSION_MAX_AGE_MS,
          path: "/",
        });
        callback?.();
      } catch (err) {
        callback?.(err instanceof Error ? err : new Error("Failed to save session"));
      }
    },
    destroy(callback?: () => void) {
      delete this.userId;
      res.clearCookie(SESSION_COOKIE_NAME, {
        httpOnly: true,
        sameSite: "lax",
        secure: isProd,
        path: "/",
      });
      callback?.();
    },
  };

  next();
});

app.use("/api", router);

// Keep Railway rebuilding the API service when bundled frontend assets change. (v50: achievements dark mode)
export default app;
