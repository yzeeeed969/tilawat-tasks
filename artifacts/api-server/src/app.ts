import express, { type Express } from "express";
import cors from "cors";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const PgSession = connectPgSimple(session);

const app: Express = express();

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
