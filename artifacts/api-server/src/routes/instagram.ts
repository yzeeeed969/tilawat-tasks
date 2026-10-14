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
import { checkInstagramAccount, currentWeekPostCounts, listInstagramMedia, revertInstagramMedia, runInstagramMonitorTick } from "../services/instagram-monitor";
import { applyInstagramLegacyCleanup, previewInstagramLegacyCleanup } from "../services/instagram-legacy-cleanup";
import { FACEBOOK_SCOPES, getFacebookConfig, missingFacebookEnv } from "../services/facebook-client";
import { completeFacebookConnect, getFacebookConnection, listFacebookPages, setAccountFacebookPage, startFacebookConnect } from "../services/facebook-accounts";
import { listFacebookLinks, revertFacebookLink, runFacebookCrosspostTick, setManualFacebookLink } from "../services/facebook-crosspost";

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

// عودة المتصفح من فيسبوك (Facebook Login) — عام، محمي بـ state لمرة واحدة.
instagramOauthRouter.get("/facebook/oauth/callback", async (req, res) => {
  const outcome = await completeFacebookConnect(req.query as Record<string, unknown>);
  const params = new URLSearchParams(outcome.ok
    ? { fb: "connected", pages: String(outcome.pages), name: outcome.userName ?? "" }
    : { fb: "error", message: outcome.message });
  res.redirect(302, `${getPublicAppUrl(req)}/instagram-monitor?${params.toString()}`);
});

// ── إدارة (للمدير فقط) ────────────────────────────────────────────────────────────────────
const router = Router();

async function facebookSetup() {
  const config = getFacebookConfig();
  const connection = await getFacebookConnection();
  return {
    configured: Boolean(config),
    missingEnv: missingFacebookEnv(),
    redirectUri: config?.redirectUri ?? null,
    scopes: FACEBOOK_SCOPES,
    connection: { status: connection.status, userName: connection.fbUserName, tokenExpiresAt: connection.tokenExpiresAt, lastError: connection.lastError, connectedAt: connection.connectedAt },
    pages: await listFacebookPages(),
  };
}

async function accountsWithWeekCounts() {
  const settings = await getInstagramSettings();
  const [accounts, counts] = await Promise.all([listInstagramAccounts(), currentWeekPostCounts(settings.trialMode)]);
  return accounts.map((account) => ({ ...account, currentWeekPosts: counts.get(account.id) ?? 0 }));
}

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
    accounts: await accountsWithWeekCounts(),
    facebook: await facebookSetup(),
    pages: await listInstagramPages(),
    members: await db.select({ id: membersTable.id, name: membersTable.name }).from(membersTable).orderBy(asc(membersTable.name)),
  });
});

router.patch("/instagram/settings", async (req, res) => {
  try {
    res.json(await updateInstagramSettings(req.body ?? {}));
  } catch (err) {
    sendError(res, err);
  }
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

router.put("/instagram/accounts/:id/facebook-page", async (req, res) => {
  try {
    await setAccountFacebookPage(Number(req.params.id), req.body?.fbPageId ?? null);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/instagram/facebook/connect", async (req, res) => {
  try {
    res.json(await startFacebookConnect((req as any).currentUser?.id ?? null));
  } catch (err) {
    sendError(res, err);
  }
});

router.get("/instagram/facebook-links", async (req, res) => {
  res.json(await listFacebookLinks(Number(req.query.limit) || 100));
});

router.post("/instagram/facebook-links/:id/manual", async (req, res) => {
  try {
    await setManualFacebookLink(Number(req.params.id), req.body?.url, (req as any).currentUser?.id ?? null);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/instagram/facebook-links/:id/revert", async (req, res) => {
  try {
    await revertFacebookLink(Number(req.params.id), (req as any).currentUser?.id ?? null);
    res.json({ ok: true });
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

// «افحص الآن»: كل الحسابات، أو حساب واحد.
router.post("/instagram/check-now", async (req, res) => {
  const accountId = Number(req.body?.accountId);
  if (Number.isInteger(accountId) && accountId > 0) {
    const settings = await getInstagramSettings();
    const result = await checkInstagramAccount(accountId, settings.trialMode);
    res.json({ ...result, facebook: await runFacebookCrosspostTick() });
    return;
  }
  const result = await runInstagramMonitorTick();
  res.json({ ...result, facebook: await runFacebookCrosspostTick() });
});

router.get("/instagram/media", async (req, res) => {
  const accountId = Number(req.query.accountId);
  res.json(await listInstagramMedia({
    accountId: Number.isInteger(accountId) && accountId > 0 ? accountId : undefined,
    limit: Number(req.query.limit) || 100,
  }));
});

router.post("/instagram/media/:id/revert", async (req, res) => {
  try {
    await revertInstagramMedia(Number(req.params.id), (req as any).currentUser?.id ?? null);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

// تنظيف مهام إنستقرام الأسبوعية القديمة المكرّرة (سلاسل «هدف أسبوعي» يدوية): معاينة ثم تطبيق (حذف ناعم).
router.get("/instagram/legacy-cleanup", async (_req, res) => {
  res.json(await previewInstagramLegacyCleanup());
});

router.post("/instagram/legacy-cleanup", async (req, res) => {
  if (req.body?.confirm !== true) {
    res.status(400).json({ message: "أكّد التنظيف أولًا" });
    return;
  }
  res.json(await applyInstagramLegacyCleanup((req as any).currentUser?.id ?? null));
});

export default router;
