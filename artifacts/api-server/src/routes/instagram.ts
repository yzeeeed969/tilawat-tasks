import { Router } from "express";
import { asc } from "drizzle-orm";
import { db, membersTable } from "@workspace/db";
import { requireAdmin } from "../middlewares/auth";
import { getPublicAppUrl } from "../lib/public-url";
import { ensureInstagramSchema } from "../services/instagram-schema";
import { getInstagramConfig, INSTAGRAM_SCOPES, missingInstagramEnv } from "../services/instagram-client";
import {
  completeInstagramConnect,
  createInstagramAccount,
  disconnectInstagramAccount,
  getInstagramSettings,
  InstagramError,
  listInstagramAccounts,
  listInstagramPages,
  startInstagramConnect,
  updateInstagramAccount,
  updateInstagramSettings,
} from "../services/instagram-accounts";

function sendError(res: any, err: unknown) {
  if (err instanceof InstagramError) {
    res.status(err.status).json({ message: err.message });
    return;
  }
  throw err;
}

// ── عام: عودة المتصفح من إنستقرام (Redirect URI) ─────────────────────────────────────────
// عام عمدًا: الحماية برمز state العشوائي لمرة واحدة (15 دقيقة) المرتبط بحساب أنشأه المدير.
export const instagramOauthRouter = Router();

instagramOauthRouter.get("/instagram/oauth/callback", async (req, res) => {
  const outcome = await completeInstagramConnect(req.query as Record<string, unknown>);
  const params = new URLSearchParams(outcome.ok
    ? { ig: "connected", account: String(outcome.accountId), username: outcome.username ?? "" }
    : { ig: "error", message: outcome.message });
  res.redirect(302, `${getPublicAppUrl(req)}/instagram-monitor?${params.toString()}`);
});

// ── إدارة (للمدير فقط) ────────────────────────────────────────────────────────────────────
const router = Router();

router.use("/instagram", requireAdmin, async (_req, _res, next) => {
  try {
    await ensureInstagramSchema();
    next();
  } catch (err) {
    next(err);
  }
});

router.get("/instagram/setup", async (_req, res) => {
  const config = getInstagramConfig();
  res.json({
    settings: await getInstagramSettings(),
    meta: {
      configured: Boolean(config),
      missingEnv: missingInstagramEnv(),
      redirectUri: config?.redirectUri ?? null,
      scopes: INSTAGRAM_SCOPES,
    },
    accounts: await listInstagramAccounts(),
    pages: await listInstagramPages(),
    members: await db.select({ id: membersTable.id, name: membersTable.name }).from(membersTable).orderBy(asc(membersTable.name)),
  });
});

router.patch("/instagram/settings", async (req, res) => {
  res.json(await updateInstagramSettings(req.body ?? {}));
});

router.post("/instagram/accounts", async (req, res) => {
  try {
    res.status(201).json(await createInstagramAccount(req.body ?? {}));
  } catch (err) {
    sendError(res, err);
  }
});

router.patch("/instagram/accounts/:id", async (req, res) => {
  try {
    res.json(await updateInstagramAccount(Number(req.params.id), req.body ?? {}));
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/instagram/accounts/:id/connect", async (req, res) => {
  try {
    res.json(await startInstagramConnect(Number(req.params.id), (req as any).currentUser?.id ?? null));
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/instagram/accounts/:id/disconnect", async (req, res) => {
  try {
    await disconnectInstagramAccount(Number(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
