import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { requireAdmin } from "../middlewares/auth";
import { ensureShowcaseSchema } from "../services/showcase-schema";
import { clearShowcaseCache, getShowcase, loadShowcaseApps, publicShowcase } from "../services/showcase";

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

// رابط متجر: فارغ ⇐ يُمسح (اختياري)؛ وإلا يجب أن يكون رابطًا صالحًا يبدأ بـ https:// — لا حذف صامت أبدًا.
export function validateStoreUrl(value: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value == null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, error: "الرابط غير صالح" };
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, value: null };
  if (!/^https:\/\//i.test(trimmed)) return { ok: false, error: "يجب أن يبدأ الرابط بـ https://" };
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" || !url.hostname.includes(".")) return { ok: false, error: "الرابط غير صالح — انسخه كاملًا من صفحة التطبيق في المتجر" };
  } catch {
    return { ok: false, error: "الرابط غير صالح — انسخه كاملًا من صفحة التطبيق في المتجر" };
  }
  return { ok: true, value: trimmed };
}

// روابط المتاجر فقط (روابط ثابتة، ليست أرقامًا) — لا إدخال يدوي لأي رقم. القائمة = تطبيقات الصفحة العامة نفسها.
router.get("/showcase/manual", async (_req, res) => {
  const apps = await loadShowcaseApps();
  res.json({ platforms: apps.map((app) => ({ id: app.id, name: app.name, iosUrl: app.iosUrl, androidUrl: app.androidUrl })) });
});

router.put("/showcase/manual/platforms/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ message: "معرّف غير صالح" });
    return;
  }
  const ios = validateStoreUrl(req.body?.iosUrl);
  const android = validateStoreUrl(req.body?.androidUrl);
  if (!ios.ok || !android.ok) {
    res.status(400).json({
      message: "لم يُحفظ شيء — صحّح الرابط المشار إليه",
      errors: { ...(!ios.ok ? { iosUrl: ios.error } : {}), ...(!android.ok ? { androidUrl: android.error } : {}) },
    });
    return;
  }
  const updated = rowsOf(await db.execute(sql`UPDATE platforms SET ios_url = ${ios.value}, android_url = ${android.value} WHERE id = ${id} RETURNING id`));
  if (updated.length === 0) {
    res.status(404).json({ message: "التطبيق غير موجود" });
    return;
  }
  clearShowcaseCache();
  res.json({ ok: true, iosUrl: ios.value, androidUrl: android.value });
});

// إخفاء/إظهار صفحة من الصفحة العامة فقط (لا حذف) — قرار عرض.
router.put("/showcase/pages/:id/visibility", async (req, res) => {
  const id = Number(req.params.id);
  await db.execute(sql`UPDATE platform_pages SET hide_from_showcase = ${req.body?.hidden === true} WHERE id = ${id}`);
  clearShowcaseCache();
  res.json({ ok: true });
});

router.post("/showcase/refresh", async (_req, res) => {
  clearShowcaseCache();
  const data = await getShowcase({ force: true });
  res.json(data.diagnostics ?? { youtube: [], hiddenPages: [], hidden: [], followers: [], youtubeBreakdown: { channels: [], totalViews: 0, totalSubscribers: 0 }, apps: [] });
});

// تشخيص للمدير: ما ينقص قنوات يوتيوب المسجّلة، وما لم يعد يظهر في الصفحة العامة ولماذا.
router.get("/showcase/diagnostics", async (_req, res) => {
  const data = await getShowcase();
  res.json(data.diagnostics ?? { youtube: [], hiddenPages: [], hidden: [], followers: [], youtubeBreakdown: { channels: [], totalViews: 0, totalSubscribers: 0 }, apps: [] });
});

export default router;
