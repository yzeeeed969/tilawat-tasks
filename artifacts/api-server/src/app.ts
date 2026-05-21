import express, { type Express } from "express";
import cors from "cors";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import pinoHttp from "pino-http";
import path from "node:path";
import router from "./routes";
import { logger } from "./lib/logger";

const PgSession = connectPgSimple(session);

const app: Express = express();
const clientDistDir = path.resolve(process.cwd(), "artifacts/tilawat-tasks/dist/public");
const clientIndexPath = path.join(clientDistDir, "index.html");

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

app.use(express.static(clientDistDir));

app.get(/.*/, (req, res, next) => {
  if (req.path.startsWith("/api")) {
    next();
    return;
  }

  if (req.accepts(["html", "json"]) !== "html") {
    next();
    return;
  }

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

const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) throw new Error("SESSION_SECRET is required");

const isProd = process.env.NODE_ENV === "production";

app.use(
  session({
    store: new PgSession({
      conString: process.env.DATABASE_URL,
      tableName: "user_sessions",
      createTableIfMissing: false,
    }),
    name: "sid",
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: isProd ? "none" : "lax",
      secure: isProd,
      maxAge: 30 * 24 * 60 * 60 * 1000,
    },
  }),
);

app.use("/api", router);

export default app;
