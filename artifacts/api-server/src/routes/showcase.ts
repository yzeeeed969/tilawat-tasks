import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { requireAdmin } from "../middlewares/auth";
import { ensureShowcaseSchema } from "../services/showcase-schema";
import { clearShowcaseCache, getShowcase, publicShowcase } from "../services/showcase";

// ── عام: بيانات صفحة «منصات المشروع» (/achievements) — بلا تسجيل دخول، بلا أي مفتاح ──────────────
export const showcasePublicRouter = Router();

showcasePublicRouter.get("/public/showcase", async (_req, res) => {
  try {
    const data = await getShowcase();
    res.set("Cache-Control", "public, max-age=300");
    res.json(publicShowcase(data));
  } catch {
    res.status(503).json({ message: "تعذّر تحميل البيانات الآن" });
  }
});

// ── إدارة (للمدير): روابط المتاجر + التشخيص ───────────────────────────────────────────────────────
const router = Router();
router.use("/showcase", requireAdmin, async (_req, _res, next) => {
  try {
    await ensureShowcaseSchema();
    next();
  } catch (err) {
    next(err);
  }
});

const rowsOf = (result: any): any[] => result?.rows ?? result ?? [];
const cleanUrl = (value: unknown) => (typeof value === "string" && /^https?:\/\//i.test(value.trim()) ? value.trim() : null);

// روابط المتاجر فقط (روابط ثابتة، ليست أرقامًا) — لا إدخال يدوي لأي رقم.
router.get("/showcase/manual", async (_req, res) => {
  const platforms = rowsOf(await db.execute(sql`SELECT id, name, ios_url, android_url FROM platforms ORDER BY id`));
  res.json({
    platforms: platforms.map((row) => ({ id: Number(row.id), name: String(row.name), iosUrl: row.ios_url ?? null, androidUrl: row.android_url ?? null })),
  });
});

router.put("/showcase/manual/platforms/:id", async (req, res) => {
  const id = Number(req.params.id);
  await db.execute(sql`UPDATE platforms SET ios_url = ${cleanUrl(req.body?.iosUrl)}, android_url = ${cleanUrl(req.body?.androidUrl)} WHERE id = ${id}`);
  clearShowcaseCache();
  res.json({ ok: true });
});

router.post("/showcase/refresh", async (_req, res) => {
  clearShowcaseCache();
  const data = await getShowcase({ force: true });
  res.json(data.diagnostics ?? { youtube: [], hidden: [], followers: [], youtubeBreakdown: { channels: [], totalViews: 0, totalSubscribers: 0 }, apps: [] });
});

// تشخيص للمدير: ما ينقص قنوات يوتيوب المسجّلة، وما لم يعد يظهر في الصفحة العامة ولماذا.
router.get("/showcase/diagnostics", async (_req, res) => {
  const data = await getShowcase();
  res.json(data.diagnostics ?? { youtube: [], hidden: [], followers: [], youtubeBreakdown: { channels: [], totalViews: 0, totalSubscribers: 0 }, apps: [] });
});

export default router;
