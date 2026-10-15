import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { requireAdmin } from "../middlewares/auth";
import { ensureShowcaseSchema } from "../services/showcase-schema";
import { clearShowcaseCache, getShowcase } from "../services/showcase";

// ── عام: بيانات صفحة «منصات المشروع» (/achievements) — بلا تسجيل دخول، بلا أي مفتاح ──────────────
export const showcasePublicRouter = Router();

showcasePublicRouter.get("/public/showcase", async (_req, res) => {
  try {
    const data = await getShowcase();
    res.set("Cache-Control", "public, max-age=300");
    res.json(data);
  } catch {
    res.status(503).json({ message: "تعذّر تحميل البيانات الآن" });
  }
});

// ── إدارة القيم اليدوية (للمدير): روابط المتاجر، والمتابعون لحسابات بلا واجهة مجانية ─────────────
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

router.get("/showcase/manual", async (_req, res) => {
  const platforms = rowsOf(await db.execute(sql`SELECT id, name, ios_url, android_url FROM platforms ORDER BY id`));
  const pages = rowsOf(await db.execute(sql`
    SELECT pp.id, pp.platform_id, p.name AS platform_name, pp.name, pp.page_url, pp.manual_followers
    FROM platform_pages pp JOIN platforms p ON p.id = pp.platform_id ORDER BY p.name, pp.name`));
  res.json({
    platforms: platforms.map((row) => ({ id: Number(row.id), name: String(row.name), iosUrl: row.ios_url ?? null, androidUrl: row.android_url ?? null })),
    pages: pages.map((row) => ({ id: Number(row.id), platformId: Number(row.platform_id), platformName: String(row.platform_name), name: String(row.name), pageUrl: row.page_url ?? null, manualFollowers: row.manual_followers == null ? null : Number(row.manual_followers) })),
  });
});

router.put("/showcase/manual/platforms/:id", async (req, res) => {
  const id = Number(req.params.id);
  await db.execute(sql`UPDATE platforms SET ios_url = ${cleanUrl(req.body?.iosUrl)}, android_url = ${cleanUrl(req.body?.androidUrl)} WHERE id = ${id}`);
  clearShowcaseCache();
  res.json({ ok: true });
});

router.put("/showcase/manual/pages/:id", async (req, res) => {
  const id = Number(req.params.id);
  const raw = req.body?.manualFollowers;
  const value = raw === null || raw === "" || raw === undefined ? null : Number(raw);
  if (value !== null && (!Number.isInteger(value) || value < 0)) {
    res.status(400).json({ message: "عدد المتابعين يجب أن يكون عددًا صحيحًا موجبًا" });
    return;
  }
  await db.execute(sql`UPDATE platform_pages SET manual_followers = ${value} WHERE id = ${id}`);
  clearShowcaseCache();
  res.json({ ok: true });
});

router.post("/showcase/refresh", async (_req, res) => {
  clearShowcaseCache();
  res.json(await getShowcase({ force: true }));
});

export default router;
